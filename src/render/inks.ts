// From the 8-bit tone index (0 = ramp.dark … 255 = ramp.light) to what gets printed or shown:
//   cmyk   DeviceCMYK through the output profile's B2A1 (the default export)
//   kOnly  DeviceGray (0 = 100 % K) whose K alone prints the ramp's lightness (fallback models)
//   srgb   the ramp on screen (previews), exactly as the live viewer's LUT
// The tone index carries the dither, so all four CMYK plates step together.

import type { Cmyk, PrintProfile } from '../pdf/iccLut';
import { type LookConfig, labToSrgb, makeRamp, rampLab } from './look';

export const TONE_LEVELS = 256;

export interface InkReport {
  /** CMYK in % at the light (index 255) and dark (index 0) end of the ramp. */
  light: number[];
  dark: number[];
  /** Highest total ink in % over the ramp (FOGRA39 limit: 300 %). */
  maxTac: number;
  /** Ramp lightness the K plate alone cannot reach (K-only models), in L*; 0 = none. */
  kOnlyClippedBelowL: number;
}

export interface InkTables {
  /** TONE_LEVELS × 4 bytes, C M Y K, 255 = full ink. */
  cmyk: Uint8Array;
  /** TONE_LEVELS bytes, DeviceGray (0 = 100 % K, 255 = paper). */
  kOnly: Uint8Array;
  report: InkReport;
}

const tAt = (i: number) => i / (TONE_LEVELS - 1);

/** sRGB palette of the ramp (TONE_LEVELS × 3 bytes), for previews; no profile needed. */
export function makePreviewPalette(look: LookConfig): Uint8Array {
  const ramp = makeRamp(look.ramp);
  const out = new Uint8Array(TONE_LEVELS * 3);
  for (let i = 0; i < TONE_LEVELS; i++) {
    const rgb = labToSrgb(rampLab(tAt(i), ramp));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(Math.min(1, Math.max(0, rgb[c])) * 255);
  }
  return out;
}

export function makeInkTables(look: LookConfig, profile: PrintProfile): InkTables {
  const ramp = makeRamp(look.ramp);
  const cmyk = new Uint8Array(TONE_LEVELS * 4);
  const kOnly = new Uint8Array(TONE_LEVELS);
  let maxTac = 0;
  let kOnlyClippedBelowL = 0;
  const kOnlyLightness = (k: number) => profile.cmykToLab([0, 0, 0, k])[0];
  const lMinK = kOnlyLightness(1);
  for (let i = 0; i < TONE_LEVELS; i++) {
    const lab = rampLab(tAt(i), ramp);
    const ink: Cmyk = profile.labToCmyk(lab);
    for (let c = 0; c < 4; c++) cmyk[i * 4 + c] = Math.round(ink[c] * 255);
    maxTac = Math.max(maxTac, ink.reduce((a, v) => a + v, 0));
    // K-only: bisect the profile's K curve (lightness falls monotonically with K).
    let lo = 0;
    let hi = 1;
    if (lab[0] <= lMinK) {
      lo = hi = 1;
      kOnlyClippedBelowL = Math.max(kOnlyClippedBelowL, lMinK);
    } else {
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        if (kOnlyLightness(mid) > lab[0]) lo = mid;
        else hi = mid;
      }
    }
    kOnly[i] = Math.round((1 - (lo + hi) / 2) * 255);
  }
  const pct = (i: number) => Array.from(cmyk.subarray(i * 4, i * 4 + 4), (v) => Math.round((v / 2.55) * 10) / 10);
  return {
    cmyk,
    kOnly,
    report: {
      light: pct(TONE_LEVELS - 1),
      dark: pct(0),
      maxTac: Math.round(maxTac * 1000) / 10,
      kOnlyClippedBelowL: Math.round(kOnlyClippedBelowL * 10) / 10,
    },
  };
}
