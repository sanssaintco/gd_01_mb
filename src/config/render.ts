// Print render settings: tile grid, MSAA, accumulation passes, tone curve, dither.

export interface ToneConfig {
  /** Exposure applied to linear luminance before encoding. */
  exposureEV: number;
  /**
   * Levels, on the sRGB-encoded value (0..1). At the defaults the print matches the live viewer.
   * inBlack/inWhite clip the input, gamma bends the midtones (>1 brighter), outBlack/outWhite set
   * the output range (0 = 100 % K, 1 = paper white).
   */
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
  /**
   * Optional dot-gain pre-compensation: DeviceGray goes to the K plate 1:1, so midtones print
   * darker by the press's tone value increase (TVI). Parabolic TVI model peaking at 50 %.
   */
  dotGain: { enabled: boolean; tvi50: number };
}

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
   * Accumulation passes per tile. 1 = single pass. >1 is reserved for jittered-camera DOF/AA,
   * which is not implemented yet.
   */
  passes: number;
  tone: ToneConfig;
  /** TPDF dither against banding: peak amplitude in 8-bit steps (LSB); 0 = off. */
  dither: { amplitude: number; seed: number };
  /** Scale of the on-screen print preview relative to full resolution. */
  previewScale: number;
  seamTest: { width: number; height: number; grids: Array<[number, number]> };
}

export const DEFAULT_RENDER: RenderConfig = {
  tiles: { cols: 2, rows: 2 },
  maxTileMegapixels: 2.5,
  printShadowMap: 'auto',
  msaaSamples: 4,
  passes: 1,
  tone: {
    exposureEV: 0,
    inBlack: 0,
    inWhite: 1,
    gamma: 1,
    outBlack: 0,
    outWhite: 1,
    dotGain: { enabled: false, tvi50: 0.15 },
  },
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
  },
};
