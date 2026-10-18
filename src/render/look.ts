// The photographic "look": exposure → filmic tone curve → tone t ∈ [0, 1] → colour ramp.
// Pure functions, no three.js. The viewer uploads the tables as LUT textures, the print path
// evaluates them on the CPU, so screen and print share one definition.
//
//   t = 0  → ramp.dark  (#2b2a28 by default, the deepest shadow)
//   t = 1  → ramp.light (#deddde by default, the brightest highlight; never paper white)
//
// t is a perceptual lightness fraction: L* runs linearly from the dark stop to the light stop.
// a*/b* (the tint) move from the dark hue to the light hue; an optional mid stop adds a hue
// (not a lightness) in between, e.g. a warmer beige in the midtones.

export interface ToneCurveConfig {
  /** Exposure in stops, applied to scene-linear luminance before the curve. */
  exposureEV: number;
  /** Tone t of an 18 % grey after exposure. High-key: well above 0.5. */
  pivot: number;
  /** Slope at the pivot, in t per stop. */
  contrast: number;
  /** Stops above 18 % grey where t reaches 1 (everything brighter is the light stop). */
  whiteStops: number;
  /** Stops below 18 % grey (negative) where t reaches 0. */
  blackStops: number;
  /** Slope where the shoulder meets the white point, as a fraction of the secant (0 = softest roll-off). */
  shoulder: number;
  /** Same for the toe at the black point. */
  toe: number;
}

export interface RampConfig {
  dark: string;
  light: string;
  /** Hue-only intermediate stop. */
  mid: { enabled: boolean; color: string; position: number };
  /** The tint (a*, b*) follows t^tintBias: < 1 brings the light stop's hue down into the shadows, > 1 the reverse. */
  tintBias: number;
}

export interface BloomConfig {
  enabled: boolean;
  /** Exposed scene-linear luminance where bloom starts (18 % grey = 0.18). */
  threshold: number;
  /** Soft-knee width around the threshold, in the same units. */
  knee: number;
  /** Amount of bloom light added to the image. */
  intensity: number;
  /** Sigma of the widest bloom component, as a fraction of the frame height. */
  radius: number;
  /** Weight ratio from one component to the next wider one (5 components, each 2.5× wider). */
  falloff: number;
}

export interface LookConfig {
  tone: ToneCurveConfig;
  ramp: RampConfig;
  bloom: BloomConfig;
}

export const DEFAULT_LOOK: LookConfig = {
  tone: { exposureEV: 0.6, pivot: 0.68, contrast: 0.48, whiteStops: 2.2, blackStops: -5.5, shoulder: 0.15, toe: 0.4 },
  ramp: {
    dark: '#2b2a28',
    light: '#deddde',
    mid: { enabled: false, color: '#c9c0b0', position: 0.6 },
    tintBias: 1.52,
  },
  bloom: { enabled: true, threshold: 0.5, knee: 1.08, intensity: 0.52, radius: 0.147, falloff: 2 },
};

const MID_GREY = 0.18;

/** Domain of the tone LUT: log2(Y / 0.18) from LUT_MIN to LUT_MAX stops. */
export const TONE_LUT_MIN = -14;
export const TONE_LUT_MAX = 8;

// ---------------------------------------------------------------------------------------------
// Tone curve: two cubic Hermite segments in log2 space, meeting C1 at the pivot.

/** Exposed scene-linear luminance → tone t ∈ [0, 1]. */
export function toneT(y: number, c: ToneCurveConfig): number {
  if (!(y > 0)) return 0;
  return toneTStops(Math.log2(y / MID_GREY), c);
}

/** Tone t for x stops relative to an 18 % grey (exposure already applied). */
export function toneTStops(x: number, c: ToneCurveConfig): number {
  const p = clamp(c.pivot, 0.01, 0.99);
  const xw = Math.max(0.05, c.whiteStops);
  const xb = Math.min(-0.05, c.blackStops);
  if (x >= xw) return 1;
  if (x <= xb) return 0;
  // Fritsch–Carlson: keep each segment monotone by limiting the tangents to 3 × the secant.
  const dw = (1 - p) / xw;
  const db = p / -xb;
  const s = Math.min(Math.max(0, c.contrast), 3 * dw, 3 * db);
  if (x >= 0) return hermite(x / xw, p, 1, s * xw, clamp(c.shoulder, 0, 3) * dw * xw);
  return hermite((x - xb) / -xb, 0, p, clamp(c.toe, 0, 3) * db * -xb, s * -xb);
}

/** Cubic Hermite on u ∈ [0, 1] with end values a, b and end tangents ma, mb (per unit u). */
function hermite(u: number, a: number, b: number, ma: number, mb: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * ma + (-2 * u3 + 3 * u2) * b + (u3 - u2) * mb;
}

// ---------------------------------------------------------------------------------------------
// Colour: sRGB ↔ CIE Lab (D50, as in ICC profiles), Bradford adaptation D65 ↔ D50.

export type Lab = [number, number, number];
export type Rgb = [number, number, number];

const D50: Rgb = [0.96422, 1, 0.82521];

// Linear sRGB (D65) → XYZ D50, Bradford-adapted (the ICC sRGB matrix).
const SRGB_TO_XYZ50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];
const XYZ50_TO_SRGB = invert3(SRGB_TO_XYZ50);

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function srgbToLab(rgb: Rgb): Lab {
  const lin = rgb.map(srgbDecode) as Rgb;
  const xyz = mul3(SRGB_TO_XYZ50, lin);
  const f = xyz.map((v, i) => labF(v / D50[i]));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/** Lab (D50) → sRGB-encoded 0..1, unclipped (out-of-gamut values fall outside 0..1). */
export function labToSrgb(lab: Lab): Rgb {
  const fy = (lab[0] + 16) / 116;
  const xyz: Rgb = [D50[0] * labFInv(fy + lab[1] / 500), D50[1] * labFInv(fy), D50[2] * labFInv(fy - lab[2] / 200)];
  return mul3(XYZ50_TO_SRGB, xyz).map((v) => (v < 0 ? -srgbEncode(-v) : srgbEncode(v))) as Rgb;
}

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116);
const labFInv = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : ((f - 16 / 116) * 116 * 27) / 24389);

// ---------------------------------------------------------------------------------------------
// Ramp: t → Lab.

export interface Ramp {
  dark: Lab;
  light: Lab;
  mid?: { lab: Lab; position: number };
  tintBias: number;
}

export function makeRamp(r: RampConfig): Ramp {
  return {
    dark: srgbToLab(hexToRgb(r.dark)),
    light: srgbToLab(hexToRgb(r.light)),
    mid: r.mid.enabled ? { lab: srgbToLab(hexToRgb(r.mid.color)), position: clamp(r.mid.position, 0.01, 0.99) } : undefined,
    tintBias: Math.max(0.05, r.tintBias),
  };
}

export function rampLab(t: number, r: Ramp): Lab {
  t = clamp(t, 0, 1);
  const L = r.dark[0] + t * (r.light[0] - r.dark[0]);
  const h = t ** r.tintBias;
  let a: number;
  let b: number;
  if (r.mid && h < r.mid.position) {
    const u = h / r.mid.position;
    a = lerp(r.dark[1], r.mid.lab[1], u);
    b = lerp(r.dark[2], r.mid.lab[2], u);
  } else if (r.mid) {
    const u = (h - r.mid.position) / (1 - r.mid.position);
    a = lerp(r.mid.lab[1], r.light[1], u);
    b = lerp(r.mid.lab[2], r.light[2], u);
  } else {
    a = lerp(r.dark[1], r.light[1], h);
    b = lerp(r.dark[2], r.light[2], h);
  }
  return [L, a, b];
}

// ---------------------------------------------------------------------------------------------
// LUTs for the viewer.

/**
 * Display LUT: index i ↔ log2(Y / 0.18) = TONE_LUT_MIN + i / (size − 1) × (MAX − MIN), with Y the
 * exposed luminance (exposure is a shader uniform). Values: sRGB-encoded RGB, RGBA float.
 */
export function makeDisplayLut(look: LookConfig, size = 4096): Float32Array {
  const ramp = makeRamp(look.ramp);
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const x = TONE_LUT_MIN + (i / (size - 1)) * (TONE_LUT_MAX - TONE_LUT_MIN);
    const rgb = labToSrgb(rampLab(toneTStops(x, look.tone), ramp));
    out.set([clamp(rgb[0], 0, 1), clamp(rgb[1], 0, 1), clamp(rgb[2], 0, 1), 1], i * 4);
  }
  return out;
}

/** Five bloom components: sigma (fraction of frame height) and normalized weight. */
export function bloomComponents(b: BloomConfig): Array<{ sigma: number; weight: number }> {
  const n = 5;
  const raw = Array.from({ length: n }, (_, k) => ({ sigma: b.radius / 2.5 ** (n - 1 - k), weight: b.falloff ** k }));
  const sum = raw.reduce((s, c) => s + c.weight, 0);
  return raw.map((c) => ({ sigma: c.sigma, weight: c.weight / sum }));
}

// ---------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function mul3(m: number[][], v: Rgb): Rgb {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
