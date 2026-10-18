// Print-side tone mapping: exposed linear luminance (bloom included) → the look's filmic curve
// (render/look.ts, same as the live viewer) → 8-bit tone index with TPDF dither. Index 0 is the
// ramp's dark end, 255 its light end; render/inks.ts turns the index into CMYK / gray / sRGB.

import { type ToneCurveConfig, TONE_LUT_MAX, TONE_LUT_MIN, toneTStops } from './look';

/** LUT resolution over log2 luminance; ≈ 0.0013 stops per entry, linearly interpolated. */
const LUT_SIZE = 16384;

export interface ToneMapper {
  /** 255 · t for log2(Y / 0.18) = TONE_LUT_MIN … TONE_LUT_MAX. */
  lut: Float32Array;
  /** Linear multiplier of the exposure. */
  exposure: number;
}

export function makeToneMapper(t: ToneCurveConfig): ToneMapper {
  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    lut[i] = 255 * toneTStops(TONE_LUT_MIN + (i / (LUT_SIZE - 1)) * (TONE_LUT_MAX - TONE_LUT_MIN), t);
  }
  return { lut, exposure: 2 ** t.exposureEV };
}

const SCALE = (LUT_SIZE - 1) / (TONE_LUT_MAX - TONE_LUT_MIN);

/** Unrounded, undithered tone index (0..255) of an *exposed* luminance. */
export function toneOfExposed(m: ToneMapper, y: number): number {
  if (!(y > 0)) return m.lut[0];
  const u = (Math.log2(y / 0.18) - TONE_LUT_MIN) * SCALE;
  if (u <= 0) return m.lut[0];
  if (u >= LUT_SIZE - 1) return m.lut[LUT_SIZE - 1];
  const i = u | 0;
  const f = u - i;
  return m.lut[i] + (m.lut[i + 1] - m.lut[i]) * f;
}

/** Rounded tone index with TPDF dither keyed to the global pixel position (tile-independent). */
export function ditheredIndex(v: number, gx: number, rowHash: number, amplitude: number): number {
  if (amplitude > 0) v += amplitude * tpdf(gx, rowHash);
  return v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
}

/** Per-row hash for ditheredIndex. */
export function rowHash(gy: number, seed: number): number {
  return hash32(gy ^ hash32(seed));
}

/** Triangular-PDF noise in [-1, 1) for one pixel. */
function tpdf(gx: number, rh: number): number {
  const h1 = hash32(gx ^ rh);
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
