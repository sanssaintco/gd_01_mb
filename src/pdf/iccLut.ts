// Colour transforms from the output-intent profile itself (Coated FOGRA39, ICC v2): its lut16
// ('mft2') tags B2A1 (Lab → CMYK) and A2B1 (CMYK → Lab), relative colorimetric. Pure TS, no
// browser APIs, so scripts can run it in Node and cross-check it against LittleCMS.
//
// lut16Type layout: in/out channel counts, CLUT grid points, a 3×3 matrix (only used for an XYZ
// PCS, ignored here), per-channel input curves, the CLUT (first input varies slowest), per-channel
// output curves. All tables are uint16 over 0..1. PCS Lab uses the ICC v2 legacy 16-bit encoding:
// L* = v · 100 / 0xFF00, a*/b* = v / 256 − 128.

import type { Lab } from '../render/look';

export interface Lut16 {
  inputs: number;
  outputs: number;
  grid: number;
  inputCurves: Uint16Array[];
  clut: Uint16Array;
  outputCurves: Uint16Array[];
}

export function readLut16(bytes: Uint8Array, tag: string): Lut16 {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  let off = -1;
  for (let i = 0, n = v.getUint32(128); i < n; i++) {
    if (sig(132 + 12 * i) === tag) off = v.getUint32(132 + 12 * i + 4);
  }
  if (off < 0) throw new Error(`ICC profile has no ${tag} tag`);
  if (sig(off) !== 'mft2') throw new Error(`ICC ${tag} is "${sig(off)}", only lut16Type (mft2) is supported`);
  const inputs = bytes[off + 8];
  const outputs = bytes[off + 9];
  const grid = bytes[off + 10];
  const nIn = v.getUint16(off + 48);
  const nOut = v.getUint16(off + 50);
  let p = off + 52;
  const table = (count: number) => {
    const t = new Uint16Array(count);
    for (let i = 0; i < count; i++, p += 2) t[i] = v.getUint16(p);
    return t;
  };
  const inputCurves = Array.from({ length: inputs }, () => table(nIn));
  const clut = table(grid ** inputs * outputs);
  const outputCurves = Array.from({ length: outputs }, () => table(nOut));
  return { inputs, outputs, grid, inputCurves, clut, outputCurves };
}

/**
 * Evaluates a lut16 for inputs in 0..1; returns outputs in 0..1. CLUT interpolation as in
 * LittleCMS: tetrahedral for 3 inputs; for 4 inputs tetrahedral in the last three at the two
 * neighbouring slices of the first (K for CMYK… the first channel), then linear between them.
 */
export function evalLut16(l: Lut16, x: ArrayLike<number>): number[] {
  const g = l.grid;
  const base: number[] = [];
  const frac: number[] = [];
  for (let i = 0; i < l.inputs; i++) {
    const u = curve(l.inputCurves[i], x[i]) * (g - 1);
    const b = Math.min(g - 2, Math.max(0, Math.floor(u)));
    base.push(b);
    frac.push(u - b);
  }
  let out: number[];
  if (l.inputs === 3) {
    out = tetrahedral(l, 0, base, frac);
  } else if (l.inputs === 4) {
    const slice = g * g * g;
    const lo = tetrahedral(l, base[0] * slice, base.slice(1), frac.slice(1));
    const hi = tetrahedral(l, (base[0] + 1) * slice, base.slice(1), frac.slice(1));
    out = lo.map((v, o) => v + (hi[o] - v) * frac[0]);
  } else {
    throw new Error(`lut16 with ${l.inputs} inputs is not supported`);
  }
  return out.map((v, o) => curve(l.outputCurves[o], v / 65535));
}

/** Tetrahedral interpolation in a 3D sub-grid starting at CLUT entry `offset` (Sakamoto). */
function tetrahedral(l: Lut16, offset: number, base: number[], f: number[]): number[] {
  const g = l.grid;
  const n = l.outputs;
  const at = (i: number, j: number, k: number) =>
    (offset + ((base[0] + i) * g + (base[1] + j)) * g + (base[2] + k)) * n;
  const [rx, ry, rz] = f;
  const c000 = at(0, 0, 0);
  const c111 = at(1, 1, 1);
  let a: number, b: number, c: number, d: number, e: number, h: number; // three edge pairs
  if (rx >= ry && ry >= rz) [a, b, c, d, e, h] = [at(1, 0, 0), c000, at(1, 1, 0), at(1, 0, 0), c111, at(1, 1, 0)];
  else if (rx >= rz && rz >= ry) [a, b, c, d, e, h] = [at(1, 0, 0), c000, c111, at(1, 0, 1), at(1, 0, 1), at(1, 0, 0)];
  else if (rz >= rx && rx >= ry) [a, b, c, d, e, h] = [at(1, 0, 1), at(0, 0, 1), c111, at(1, 0, 1), at(0, 0, 1), c000];
  else if (ry >= rx && rx >= rz) [a, b, c, d, e, h] = [at(1, 1, 0), at(0, 1, 0), at(0, 1, 0), c000, c111, at(1, 1, 0)];
  else if (ry >= rz && rz >= rx) [a, b, c, d, e, h] = [c111, at(0, 1, 1), at(0, 1, 0), c000, at(0, 1, 1), at(0, 1, 0)];
  else [a, b, c, d, e, h] = [c111, at(0, 1, 1), at(0, 1, 1), at(0, 0, 1), at(0, 0, 1), c000];
  const t = l.clut;
  const out = new Array<number>(n);
  for (let o = 0; o < n; o++) {
    out[o] = t[c000 + o] + (t[a + o] - t[b + o]) * rx + (t[c + o] - t[d + o]) * ry + (t[e + o] - t[h + o]) * rz;
  }
  return out;
}

/** Piecewise-linear 1D table over 0..1 (uint16 values → 0..1). */
function curve(t: Uint16Array, x: number): number {
  const u = Math.min(1, Math.max(0, x)) * (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor(u));
  const f = u - i;
  return (t[i] * (1 - f) + t[i + 1] * f) / 65535;
}

const encodeLab = (lab: Lab) => [(lab[0] * 652.8) / 65535, ((lab[1] + 128) * 256) / 65535, ((lab[2] + 128) * 256) / 65535];
const decodeLab = (v: number[]): Lab => [(v[0] * 65535) / 652.8, (v[1] * 65535) / 256 - 128, (v[2] * 65535) / 256 - 128];

export type Cmyk = [number, number, number, number];

/** Relative-colorimetric transforms of one CMYK output profile. CMYK values are ink fractions 0..1. */
export class PrintProfile {
  private b2a: Lut16;
  private a2b: Lut16;

  constructor(bytes: Uint8Array) {
    this.b2a = readLut16(bytes, 'B2A1');
    this.a2b = readLut16(bytes, 'A2B1');
    if (this.b2a.inputs !== 3 || this.b2a.outputs !== 4 || this.a2b.inputs !== 4 || this.a2b.outputs !== 3) {
      throw new Error('ICC profile is not a Lab ↔ CMYK output profile');
    }
  }

  labToCmyk(lab: Lab): Cmyk {
    return evalLut16(this.b2a, encodeLab(lab)) as Cmyk;
  }

  cmykToLab(cmyk: Cmyk): Lab {
    return decodeLab(evalLut16(this.a2b, cmyk));
  }
}
