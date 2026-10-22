/**
 * The .cube file format (Adobe / Resolve 3D LUT spec).
 *
 * It is plain text, which is why every editor supports it:
 *
 *   TITLE "Warm Film"
 *   LUT_3D_SIZE 33
 *   DOMAIN_MIN 0 0 0
 *   DOMAIN_MAX 1 1 1
 *   0.000000 0.000000 0.000000     <- output for input (r=0, g=0, b=0)
 *   0.031250 0.000000 0.000000     <- red changes fastest
 *   ...                            <- 33^3 = 35,937 lines in total
 */

import type { Lut3D } from "./lut.ts";
import type { RGB } from "./params.ts";

export interface CubeFile extends Lut3D {
  title: string;
}

export function serializeCube(lut: Lut3D, title = "grade-bridge"): string {
  const { size, data, domainMin, domainMax } = lut;
  if (data.length !== size * size * size * 3) throw new Error("LUT data length does not match its size");
  const safeTitle = title.replace(/["\r\n]/g, "'");
  const fmt = (v: number) => v.toFixed(6);
  const lines = [
    `TITLE "${safeTitle}"`,
    `# Made with grade-bridge. Input and output are display-referred sRGB / Rec.709.`,
    `LUT_3D_SIZE ${size}`,
    `DOMAIN_MIN ${domainMin.map(fmt).join(" ")}`,
    `DOMAIN_MAX ${domainMax.map(fmt).join(" ")}`,
  ];
  for (let i = 0; i < data.length; i += 3) lines.push(`${fmt(data[i])} ${fmt(data[i + 1])} ${fmt(data[i + 2])}`);
  return lines.join("\n") + "\n";
}

export function parseCube(text: string): CubeFile {
  let title = "";
  let size = 0;
  let domainMin: RGB = [0, 0, 0];
  let domainMax: RGB = [1, 1, 1];
  const values: number[] = [];

  const parseTriplet = (parts: string[], lineNo: number): RGB => {
    const nums = parts.map(Number);
    if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) throw new Error(`Line ${lineNo}: expected three numbers`);
    return nums as RGB;
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const [keyword, ...rest] = line.split(/\s+/);

    if (keyword === "TITLE") {
      title = line.slice(5).trim().replace(/^"|"$/g, "");
    } else if (keyword === "LUT_3D_SIZE") {
      size = Number(rest[0]);
      if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error(`Line ${i + 1}: invalid LUT_3D_SIZE "${rest[0]}" (must be an integer from 2 to 256)`);
    } else if (keyword === "LUT_1D_SIZE") {
      throw new Error("This is a 1D LUT. grade-bridge reads 3D LUTs (LUT_3D_SIZE) only.");
    } else if (keyword === "DOMAIN_MIN") {
      domainMin = parseTriplet(rest, i + 1);
    } else if (keyword === "DOMAIN_MAX") {
      domainMax = parseTriplet(rest, i + 1);
    } else if (/^[-+.\d]/.test(keyword)) {
      values.push(...parseTriplet([keyword, ...rest], i + 1));
    }
    // Unknown keywords (e.g. LUT_3D_INPUT_RANGE from other tools) are ignored, as the spec allows.
  }

  if (size === 0) throw new Error("Missing LUT_3D_SIZE");
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(`Expected ${size}^3 = ${size ** 3} color lines for LUT_3D_SIZE ${size}, found ${values.length / 3}`);
  }
  if ([0, 1, 2].some((c) => domainMax[c] <= domainMin[c])) throw new Error("DOMAIN_MAX must be greater than DOMAIN_MIN");
  return { title, size, data: Float32Array.from(values), domainMin, domainMax };
}
