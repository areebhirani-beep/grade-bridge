// iPhones record HDR (HLG) by default. Browsers hand that footage to WebGL
// without a reliable HDR to Rec.709 conversion, so it looks colder and flatter
// than it is, and a Rec.709 LUT will not match on it in an editor either.
// We can't fix the decode, but we can tell the user before they trust the look.

export type Transfer = "hlg" | "pq" | "sdr";

// ISO/IEC 23001-8 transfer characteristics: 16 = PQ (SMPTE ST 2084), 18 = HLG.
export function transferFromCode(code: number): Transfer {
  if (code === 18) return "hlg";
  if (code === 16) return "pq";
  return "sdr";
}

// Finds the first `colr` box of type `nclx` (MP4) or `nclc` (QuickTime, what
// iPhones write) and returns its transfer code. Both store primaries u16 then
// transfer u16 right after the 4-byte colour type.
export function findColrTransfer(bytes: Uint8Array): number | null {
  for (let i = 0; i + 12 <= bytes.length; i++) {
    if (bytes[i] !== 0x63 || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6c || bytes[i + 3] !== 0x72) continue; // colr
    const isNcl = bytes[i + 4] === 0x6e && bytes[i + 5] === 0x63 && bytes[i + 6] === 0x6c; // ncl
    const kind = bytes[i + 7];
    if (isNcl && (kind === 0x78 || kind === 0x63)) return (bytes[i + 10] << 8) | bytes[i + 11]; // x or c
  }
  return null;
}

const MAX_MOOV = 64 * 1024 * 1024;

// Walks the top-level boxes reading only their 16-byte headers, then reads just
// the moov box, which holds the colour tags. iPhone files can put moov anywhere,
// so guessing at the start or end of the file is not enough.
export async function detectTransfer(file: Blob): Promise<Transfer> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - offset;
    if (size < 8) break;
    if (type === "moov") {
      const end = Math.min(offset + size, offset + MAX_MOOV);
      const code = findColrTransfer(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
      return code === null ? "sdr" : transferFromCode(code);
    }
    offset += size;
  }
  return "sdr";
}
