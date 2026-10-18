// Seam test: renders the same view once as one image (no view offset) and again in tiles, then
// compares them. Both use the full pipeline: the same accumulation passes (jittered lens, lights,
// sub-pixel), bloom on the stitched frame, tone curve and dither. Pixels in a 2 px band along the internal tile borders are reported separately
// from the interior: a seam shows up as a band that is worse than the interior.
//
// Verdict: a seam is a discontinuity along a tile border, so it shows as a spike in the mean |Δ|
// of the pixel lines next to the border compared with lines 3–12 px away. Each border line must
// stay within 2 × its neighbourhood + 0.05 LSB: a 1-LSB step along just 5 % of a border fails,
// isolated outlier pixels don't.
//
// For information, stats are also split into border band / control band (same width, half a tile
// from the borders) / interior, on *object* pixels only (statue, shadows; not the background).
//
// A 1×1 grid rendered through setViewOffset is the control: it shows the differences that come
// from a different projection matrix alone (float rounding at edges/shadow tests), without tiling.
// Each grid also runs with the stock (tile-local) shadow noise, as an A/B for the tileNoise patch.

import { grayToPngDataUrl } from './image';
import { type RenderJob, renderRegion } from './tiler';
import { makeToneMapper, toneOfExposed } from './tone';

export interface GroupStats {
  mean: number;
  max: number;
  /** Pixels above the outlier threshold. */
  over: number;
  pixels: number;
}

export interface DiffStats {
  max: number;
  mean: number;
  /** Pixels with |Δ| > 1 (8-bit) or > 0.5 (unrounded). */
  countOver: number;
  maxAt: [number, number];
  maxInBand: boolean;
  /** Object pixels only (see header). */
  band: GroupStats;
  control: GroupStats;
  interior: GroupStats;
}

export interface SeamCase {
  label: string;
  grid: [number, number];
  tileSize: [number, number];
  globalShadowNoise: boolean;
  /** Tone index, unrounded, undithered (in 8-bit units): the sensitive metric. */
  continuous: DiffStats;
  /** The actual dithered 8-bit tone index. */
  output8: DiffStats;
  /** Mean continuous |Δ| per column (x) and per row (y): a seam shows as a spike at a border. */
  profile: { x: number[]; y: number[] };
  /** Lines adjacent to each internal border vs. their neighbourhood (the pass criterion). */
  borderLines: BorderLine[];
  pass: boolean;
  /** true for the positive control, which must fail. */
  mustFail: boolean;
}

export interface BorderLine {
  axis: 'x' | 'y';
  /** Index of the pixel line (column or row). */
  line: number;
  value: number;
  neighbourhood: number;
  ok: boolean;
}

export interface SeamReport {
  width: number;
  height: number;
  cases: SeamCase[];
  pass: boolean;
  /** |Δ| × 32 of the worst patched case, as PNG data URL. */
  diffImage: string;
  msTotal: number;
}

const BAND = 2;

export async function runSeamTest(
  base: Omit<RenderJob, 'globalWidth' | 'globalHeight' | 'region' | 'tiles' | 'keepLinear' | 'noViewOffset'>,
  cfg: { width: number; height: number; grids: Array<[number, number]> },
): Promise<SeamReport> {
  const t0 = performance.now();
  const W = cfg.width;
  const H = cfg.height;
  const common = { ...base, globalWidth: W, globalHeight: H, keepLinear: true, onProgress: undefined };
  const ref = await renderRegion({ ...common, tiles: { cols: 1, rows: 1 }, noViewOffset: true });
  const tone = makeToneMapper(base.look.tone);
  const refCont = Float32Array.from(ref.linear!, (v) => toneOfExposed(tone, v));
  const isObject = objectMask(refCont);

  const variants: Array<{ label: string; grid: [number, number]; globalShadowNoise: boolean; misalign?: number }> = [];
  for (const grid of cfg.grids) {
    variants.push({ label: `${grid.join('×')} tiles`, grid, globalShadowNoise: true });
    variants.push({ label: `${grid.join('×')} tiles, stock shadow noise`, grid, globalShadowNoise: false });
  }
  // Positive control: the right column misaligned by half a pixel. The test must catch this.
  variants.push({ label: '2×2 tiles misaligned 0.5 px (must FAIL)', grid: [2, 2], globalShadowNoise: true, misalign: 0.5 });

  const cases: SeamCase[] = [];
  let worst: { cont: Float32Array; max: number } | undefined;
  for (const { label, grid, globalShadowNoise, misalign } of variants) {
    const [cols, rows] = grid;
    {
      const t = await renderRegion({
        ...common,
        tiles: { cols, rows },
        globalShadowNoise,
        debugMisalignPx: misalign,
      });
      const tw = t.stats.tileW;
      const th = t.stats.tileH;
      const zone = makeZones(W, H, tw, th);

      const cont = new Float32Array(W * H);
      for (let i = 0; i < cont.length; i++) cont[i] = Math.abs(toneOfExposed(tone, t.linear![i]) - refCont[i]);
      const out8 = new Float32Array(W * H);
      for (let i = 0; i < out8.length; i++) out8[i] = Math.abs(t.tone[i] - ref.tone[i]);

      const continuous = diffStats(cont, W, H, zone, isObject, 0.5);
      const output8 = diffStats(out8, W, H, zone, isObject, 1);
      const profile = profiles(cont, W, H);
      const borderLines = [...checkBorders(profile.x, tw, 'x'), ...checkBorders(profile.y, th, 'y')];
      const pass = borderLines.every((b) => b.ok) && continuous.mean < 0.05;
      cases.push({
        label,
        mustFail: misalign !== undefined,
        grid: [cols, rows],
        tileSize: [tw, th],
        globalShadowNoise,
        continuous,
        output8,
        profile,
        borderLines,
        pass,
      });
      if (globalShadowNoise && !misalign && (!worst || continuous.max > worst.max)) {
        worst = { cont, max: continuous.max };
      }
    }
  }

  const img = new Uint8Array(W * H);
  if (worst) for (let i = 0; i < img.length; i++) img[i] = 255 - Math.min(255, Math.round(worst.cont[i] * 32));

  return {
    width: W,
    height: H,
    cases,
    // Pass = every real (patched) case passes *and* the positive control is detected.
    pass: cases.every((c) => (c.mustFail ? !c.pass : !c.globalShadowNoise || c.pass)),
    diffImage: grayToPngDataUrl(img, W, H),
    msTotal: performance.now() - t0,
  };
}

/** The two pixel lines on either side of every internal border vs. lines 3–12 px away. */
function checkBorders(profile: number[], tile: number, axis: 'x' | 'y'): BorderLine[] {
  const out: BorderLine[] = [];
  for (let b = tile; b < profile.length; b += tile) {
    const near: number[] = [];
    for (let d = 3; d <= 12; d++) {
      if (b - 1 - d >= 0) near.push(profile[b - 1 - d]);
      if (b + d < profile.length) near.push(profile[b + d]);
    }
    const neighbourhood = near.reduce((a, v) => a + v, 0) / Math.max(1, near.length);
    for (const line of [b - 1, b]) {
      const value = profile[line];
      out.push({ axis, line, value, neighbourhood, ok: value <= 2 * neighbourhood + 0.05 });
    }
  }
  return out;
}

function profiles(d: Float32Array, W: number, H: number) {
  const x = new Array<number>(W).fill(0);
  const y = new Array<number>(H).fill(0);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const v = d[r * W + c];
      x[c] += v / H;
      y[r] += v / W;
    }
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return { x: x.map(round), y: y.map(round) };
}

const INTERIOR = 0;
const BORDER = 1;
const CONTROL = 2;

/** Per-pixel zone: border band (±BAND px around internal tile edges), control band, interior. */
function makeZones(W: number, H: number, tw: number, th: number): Uint8Array {
  const axis = (size: number, tile: number) => {
    const borders: number[] = [];
    for (let b = tile; b < size; b += tile) borders.push(b);
    const controls = [...new Set(borders.flatMap((b) => [b - tile / 2, b + tile / 2]).map(Math.round))].filter(
      (c) => c - BAND >= 0 && c + BAND <= size && borders.every((b) => Math.abs(b - c) >= 4 * BAND),
    );
    const z = new Uint8Array(size);
    for (const c of controls) for (let v = c - BAND; v < c + BAND; v++) z[v] = CONTROL;
    for (const b of borders) for (let v = b - BAND; v < b + BAND; v++) z[v] = BORDER;
    return z;
  };
  const zx = axis(W, tw);
  const zy = axis(H, th);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = zx[x];
      const b = zy[y];
      out[y * W + x] = a === BORDER || b === BORDER ? BORDER : a === CONTROL || b === CONTROL ? CONTROL : INTERIOR;
    }
  }
  return out;
}

/** Object pixels: everything that differs from the flat background (the most frequent value). */
function objectMask(cont: Float32Array): Uint8Array {
  const counts = new Map<number, number>();
  for (const v of cont) {
    const k = Math.round(v * 4);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bg = 0;
  let best = -1;
  for (const [k, n] of counts) if (n > best) [bg, best] = [k / 4, n];
  return Uint8Array.from(cont, (v) => (Math.abs(v - bg) > 0.5 ? 1 : 0));
}

function diffStats(
  d: Float32Array,
  W: number,
  H: number,
  zone: Uint8Array,
  isObject: Uint8Array,
  over: number,
): DiffStats {
  let max = 0;
  let maxAt: [number, number] = [0, 0];
  let sum = 0;
  let countOver = 0;
  const groups = [0, 1, 2].map(() => ({ sum: 0, max: 0, over: 0, pixels: 0 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = d[i];
      sum += v;
      if (v > over) countOver++;
      if (v > max) {
        max = v;
        maxAt = [x, y];
      }
      if (!isObject[i]) continue;
      const g = groups[zone[i]];
      g.sum += v;
      g.pixels++;
      if (v > over) g.over++;
      if (v > g.max) g.max = v;
    }
  }
  const fin = (g: (typeof groups)[number]): GroupStats => ({
    mean: g.pixels ? g.sum / g.pixels : 0,
    max: g.max,
    over: g.over,
    pixels: g.pixels,
  });
  return {
    max,
    mean: sum / d.length,
    countOver,
    maxAt,
    maxInBand: zone[maxAt[1] * W + maxAt[0]] === BORDER,
    band: fin(groups[BORDER]),
    control: fin(groups[CONTROL]),
    interior: fin(groups[INTERIOR]),
  };
}
