// Linear luminance → 8-bit DeviceGray: exposure, sRGB encode, levels, optional dot-gain
// compensation, TPDF dither, quantization. DeviceGray 0 = black (100 % K), 255 = paper.

import type { ToneConfig } from '../config/render';

/** LUT resolution over linear luminance [0, 1]. Max error < 0.05 LSB at the steepest point. */
const LUT_SIZE = 65536;

export interface ToneMapper {
  /** Output value in 8-bit units (0..255, unrounded) for linear luminance i / LUT_SIZE. */
  lut: Float32Array;
  exposure: number;
}

export function makeToneMapper(t: ToneConfig): ToneMapper {
  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) lut[i] = 255 * toneCurve(i / LUT_SIZE, t);
  return { lut, exposure: 2 ** t.exposureEV };
}

/** Linear luminance (exposure already applied, clipped to 0..1) → output 0..1. */
export function toneCurve(y: number, t: ToneConfig): number {
  let v = srgbEncode(y);
  v = clamp01((v - t.inBlack) / Math.max(1e-6, t.inWhite - t.inBlack));
  v = Math.pow(v, 1 / t.gamma);
  v = t.outBlack + v * (t.outWhite - t.outBlack);
  if (t.dotGain.enabled) v = compensateDotGain(v, t.dotGain.tvi50);
  return clamp01(v);
}

/** Unrounded, undithered output in 8-bit units. */
export function toneValue(m: ToneMapper, linearLum: number): number {
  const y = linearLum * m.exposure;
  return m.lut[y >= 1 ? LUT_SIZE : y > 0 ? (y * LUT_SIZE + 0.5) | 0 : 0];
}

/**
 * Converts one tile's linear luminance (top-down rows, stride `srcStride`) into the 8-bit output.
 * Dither noise is a pure function of the global pixel position, so it is identical whether the
 * image is rendered in tiles or in one piece.
 */
export function quantizeInto(
  src: Float32Array,
  srcStride: number,
  width: number,
  height: number,
  out: Uint8Array,
  outOffset: number,
  outStride: number,
  globalX: number,
  globalY: number,
  m: ToneMapper,
  dither: { amplitude: number; seed: number },
) {
  const amp = dither.amplitude;
  const seedHash = hash32(dither.seed);
  for (let r = 0; r < height; r++) {
    const gy = globalY + r;
    const rowHash = hash32(gy ^ seedHash);
    let s = r * srcStride;
    let o = outOffset + r * outStride;
    for (let c = 0; c < width; c++, s++, o++) {
      let v = toneValue(m, src[s]);
      if (amp > 0) v += amp * tpdf(globalX + c, rowHash);
      out[o] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
    }
  }
}

/** Triangular-PDF noise in [-1, 1) for one pixel. */
function tpdf(gx: number, rowHash: number): number {
  const h1 = hash32(gx ^ rowHash);
  const h2 = hash32(h1 ^ 0x9e3779b9);
  return (h1 + h2) / 4294967296 - 1;
}

/** lowbias32 (C. Wellons): fast, well-mixed 32-bit integer hash. */
function hash32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function srgbEncode(y: number): number {
  return y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
}

/**
 * Pre-compensates a parabolic TVI curve: printed = a + 4·tvi50·a·(1−a) for nominal coverage a.
 * Solves for the a that prints the desired coverage p = 1 − v.
 */
function compensateDotGain(v: number, tvi50: number): number {
  if (tvi50 <= 0) return v;
  const p = 1 - v;
  const k = 4 * tvi50;
  const a = ((1 + k) - Math.sqrt((1 + k) * (1 + k) - 4 * k * p)) / (2 * k);
  return 1 - a;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
