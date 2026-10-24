import { describe, expect, it } from "vitest";
import { detectTransfer, findColrTransfer, transferFromCode } from "../src/web/hdr";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function colr(kind: "nclx" | "nclc", transfer: number): Uint8Array<ArrayBuffer> {
  const tail = kind === "nclx" ? [0, 9, transfer >> 8, transfer & 255, 0, 9, 0] : [0, 9, transfer >> 8, transfer & 255, 0, 9];
  return box("colr", new Uint8Array([...ascii(kind), ...tail]));
}

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe("HDR detection", () => {
  it("reads the transfer code from nclx (MP4) and nclc (QuickTime) colr boxes", () => {
    expect(findColrTransfer(cat(new Uint8Array(40), colr("nclx", 18)))).toBe(18);
    expect(findColrTransfer(cat(new Uint8Array(40), colr("nclc", 18)))).toBe(18);
    expect(findColrTransfer(colr("nclc", 1))).toBe(1);
    expect(findColrTransfer(new Uint8Array(500))).toBeNull();
  });

  it("maps HLG and PQ codes and treats everything else as SDR", () => {
    expect(transferFromCode(18)).toBe("hlg");
    expect(transferFromCode(16)).toBe("pq");
    expect(transferFromCode(1)).toBe("sdr");
  });

  it("finds moov in the middle of a file, the way iPhone writes it", async () => {
    const mdat1 = box("mdat", new Uint8Array(6 * 1024 * 1024));
    const moov = box("moov", box("trak", colr("nclc", 18)));
    const mdat2 = box("mdat", new Uint8Array(5 * 1024 * 1024));
    const file = new Blob([box("ftyp", new Uint8Array(12)), mdat1, moov, mdat2]);
    expect(await detectTransfer(file)).toBe("hlg");
  });

  it("returns sdr for an SDR moov and for files with no boxes", async () => {
    const file = new Blob([box("ftyp", new Uint8Array(12)), box("moov", colr("nclx", 1))]);
    expect(await detectTransfer(file)).toBe("sdr");
    expect(await detectTransfer(new Blob([new Uint8Array(3)]))).toBe("sdr");
  });
});
