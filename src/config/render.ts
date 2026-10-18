// Print render settings: tile grid, MSAA, accumulation passes, bloom resolution, dither. The look
// itself (tone curve, ramp, bloom amount) is the studio preset's (config/scene.ts → look), shared
// with the live viewer.

export interface RenderConfig {
  /**
   * Requested tile grid; every tile is ceil(W/cols) × ceil(H/rows). The renderer refines it
   * until no tile exceeds maxTileMegapixels (A4: 2×2 stays 2×2; A2: 2×2 becomes 3×5).
   */
  tiles: { cols: number; rows: number };
  /**
   * GPU memory guard. A float RGBA tile with 4× MSAA needs about 100 bytes per pixel on the GPU
   * (multisampled colour + depth, resolve target), so 2.5 Mpx ≈ 250 MB.
   */
  maxTileMegapixels: number;
  /**
   * Key-light shadow-map resolution for print jobs. 'auto' = the next power of two at or above
   * the image's long side (A4 → 4096, A2 → 8192), i.e. about one shadow texel per print pixel.
   * The penumbra size does not change with it (see Studio.setShadowMapSize).
   */
  printShadowMap: 'auto' | 2048 | 4096 | 8192;
  msaaSamples: number;
  /**
   * Accumulation passes (anti-aliasing, depth of field, key-light area, dome directions), the same
   * sequence as the live viewer. More passes = smoother soft shadows and bokeh, linear in time.
   */
  passes: number;
  /** Bloom is computed at this long side and upsampled (it is low-frequency). */
  bloomBaseLongSide: number;
  /** TPDF dither on the 8-bit tone index against banding, peak amplitude in steps; 0 = off. */
  dither: { amplitude: number; seed: number };
  /** Scale of the on-screen print preview relative to full resolution. */
  previewScale: number;
  seamTest: { width: number; height: number; grids: Array<[number, number]>; passes: number };
}

/** localStorage key (bumped when the shape or meaning changes, so stale values don't load). */
export const RENDER_STORAGE_KEY = 'render.v2';

export const DEFAULT_RENDER: RenderConfig = {
  tiles: { cols: 2, rows: 2 },
  maxTileMegapixels: 2.5,
  printShadowMap: 'auto',
  msaaSamples: 4,
  passes: 32,
  bloomBaseLongSide: 2048,
  dither: { amplitude: 1, seed: 1 },
  previewScale: 0.25,
  seamTest: {
    width: 300,
    height: 421,
    // [1, 1] is the control: no tiling, but rendered through setViewOffset.
    grids: [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    passes: 8,
  },
};
