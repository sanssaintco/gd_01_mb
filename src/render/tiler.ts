// Tiled offscreen capture with accumulation. The full image is never rendered to the canvas:
// every tile goes into one offscreen MSAA float render target and is read back with
// readRenderTargetPixels. All tiles come from the same virtual camera via
// setViewOffset(globalW, globalH, x, y, tileW, tileH), so they line up without seams.
//
// Loop order: passes outside, tiles inside. Each pass moves the key light on its disk and the
// dome light to its next direction (shadow maps rendered once per pass), shifts the camera on the
// lens aperture and by a sub-pixel; every tile of that pass adds its luminance to one full-frame
// float buffer. Only after the last pass does anything look at neighbouring pixels: bloom runs on
// the stitched frame (render/bloom.ts, the same GPU code as the live viewer), then the look's tone
// curve and the dither produce the 8-bit tone index.
//
// A "region" is a sub-rectangle of the global virtual image. One sheet = one region, so a
// multi-sheet mosaic later is just a loop over regions of one large virtual image.

import * as THREE from 'three';
import type { BloomConfig, LookConfig } from './look';
import type { Studio } from '../viewer/scene';
import { Bloom } from './bloom';
import { type LensState, type Pass, applyPass } from './passes';
import { patchMaterialForTiling, setTileOrigin } from './tileNoise';
import { ditheredIndex, makeToneMapper, rowHash, toneOfExposed } from './tone';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderJob {
  renderer: THREE.WebGLRenderer;
  studio: Studio;
  /** Print camera: position, orientation, vertical fov, near/far. Aspect is set from the image. */
  camera: THREE.PerspectiveCamera;
  globalWidth: number;
  globalHeight: number;
  /** Defaults to the full global image. */
  region?: Region;
  tiles: { cols: number; rows: number };
  /** GPU memory guard: the grid is refined until no tile has more pixels than this. */
  maxTilePixels?: number;
  /** Key-light shadow-map resolution for this job (restored afterwards); default: as is. */
  shadowMapSize?: number;
  samples: number;
  passes: Pass[];
  /** Thin lens (aperture, focus distance) for the passes' lens samples. */
  lens: LensState;
  /** Tone curve and bloom (the ramp is applied later, see render/inks.ts). */
  look: Pick<LookConfig, 'tone' | 'bloom'>;
  /** Bloom is computed at this resolution (long side), then upsampled: it is low-frequency. */
  bloomBaseLongSide: number;
  dither: { amplitude: number; seed: number };
  /** Tile-global shadow noise (default true). false = stock three.js, for the seam-test A/B. */
  globalShadowNoise?: boolean;
  /** Also return the exposed luminance incl. bloom (seam test; 4 bytes per pixel). */
  keepLinear?: boolean;
  /** Render without setViewOffset (1×1 tiles, full image only): the seam-test reference. */
  noViewOffset?: boolean;
  /** Seam-test positive control only: misaligns every tile except the first column by this many px. */
  debugMisalignPx?: number;
  /** Progress over all passes × tiles. */
  onProgress?: (done: number, total: number) => void;
}

export interface RenderStats {
  width: number;
  height: number;
  tileW: number;
  tileH: number;
  tileCount: number;
  /** Grid actually rendered, and the one requested (they differ when the memory guard kicked in). */
  grid: [number, number];
  gridRequested: [number, number];
  shadowMapSize: number;
  samples: number;
  passes: number;
  colorType: 'float32' | 'float16';
  /** Bloom base resolution (0 = bloom off). */
  bloomBase: [number, number];
  msTotal: number;
  /** Render + readback (readPixels waits for the GPU, so this includes GPU time). */
  msGpu: number;
  msAccumulate: number;
  msBloom: number;
  msTone: number;
  /** Bytes held during the job: accumulation + tone index + one tile's buffers (CPU side). */
  bytesCpuPeak: number;
}

export interface RenderResult {
  /** 8-bit tone index, top-down rows: 0 = ramp.dark … 255 = ramp.light. */
  tone: Uint8Array;
  /** Exposed luminance incl. bloom (keepLinear only). */
  linear?: Float32Array;
  width: number;
  height: number;
  stats: RenderStats;
}

/**
 * Refines the requested grid until no tile exceeds `maxPixels`, always splitting the longer tile
 * side. Keeps the request when it already fits (A4 2×2 stays 2×2).
 */
export function fitTileGrid(
  width: number,
  height: number,
  requested: { cols: number; rows: number },
  maxPixels?: number,
): { cols: number; rows: number } {
  let cols = Math.max(1, Math.floor(requested.cols));
  let rows = Math.max(1, Math.floor(requested.rows));
  if (!maxPixels) return { cols, rows };
  while (Math.ceil(width / cols) * Math.ceil(height / rows) > maxPixels) {
    if (Math.ceil(width / cols) >= Math.ceil(height / rows)) cols++;
    else rows++;
  }
  return { cols, rows };
}

export async function renderRegion(job: RenderJob): Promise<RenderResult> {
  const t0 = performance.now();
  const { renderer, studio } = job;
  const gW = job.globalWidth;
  const gH = job.globalHeight;
  const region = job.region ?? { x: 0, y: 0, width: gW, height: gH };
  const W = region.width;
  const H = region.height;
  const requested = job.noViewOffset ? { cols: 1, rows: 1 } : job.tiles;
  const { cols, rows } = job.noViewOffset ? requested : fitTileGrid(W, H, requested, job.maxTilePixels);
  if (cols !== requested.cols || rows !== requested.rows) {
    console.info(`[tiler] ${requested.cols}×${requested.rows} tiles too large for the GPU budget → ${cols}×${rows}`);
  }
  if (job.noViewOffset && (W !== gW || H !== gH)) throw new Error('noViewOffset renders the full image only');
  const tw = Math.ceil(W / cols);
  const th = Math.ceil(H / rows);
  // Tiles actually needed (ceil can leave an empty last column/row, e.g. 4 px over 3 tiles).
  const nx = Math.ceil(W / tw);
  const ny = Math.ceil(H / th);

  const gl = renderer.getContext();
  const maxSize = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  if (tw > maxSize || th > maxSize) throw new Error(`tile ${tw}×${th} exceeds the GPU limit ${maxSize}; use more tiles`);
  const samples = Math.min(job.samples, renderer.capabilities.maxSamples);
  const half = !renderer.extensions.has('EXT_color_buffer_float');
  if (half) console.warn('[tiler] EXT_color_buffer_float missing: falling back to half-float tiles');

  for (const m of [studio.material, studio.floor.material as THREE.Material]) patchMaterialForTiling(m);
  const globalNoise = job.globalShadowNoise ?? true;

  const rt = new THREE.WebGLRenderTarget(tw, th, { type: half ? THREE.HalfFloatType : THREE.FloatType, samples, depthBuffer: true });
  const base = job.camera.clone();
  base.aspect = gW / gH;
  const cam = new THREE.PerspectiveCamera();

  const rgba = half ? new Uint16Array(tw * th * 4) : new Float32Array(tw * th * 4);
  const acc = new Float32Array(W * H);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoShadow = renderer.shadowMap.autoUpdate;
  const prevShadowMap = studio.shadowMapSize;
  if (job.shadowMapSize) studio.setShadowMapSize(Math.min(job.shadowMapSize, renderer.capabilities.maxTextureSize));
  const shadowMapSize = studio.shadowMapSize;
  // Shadow maps are view-independent: rendered once per pass (the lights move per pass), reused
  // for every tile of that pass.
  renderer.shadowMap.autoUpdate = false;

  let msGpu = 0;
  let msAccumulate = 0;
  const total = job.passes.length * nx * ny;
  let done = 0;
  let wsum = 0;
  try {
    for (const pass of job.passes) {
      studio.setKeyJitter(pass.lightU, pass.lightV);
      studio.setDomeSample(pass.domeU, pass.domeV);
      renderer.shadowMap.needsUpdate = true;
      for (let ty = 0; ty < ny; ty++) {
        for (let tx = 0; tx < nx; tx++) {
          // Global, top-down pixel coordinates of this tile.
          const x0 = region.x + tx * tw;
          const y0 = region.y + ty * th;
          const cropW = Math.min(tw, region.x + W - x0);
          const cropH = Math.min(th, region.y + H - y0);

          let t = performance.now();
          cam.copy(base);
          if (job.noViewOffset) cam.clearViewOffset();
          else cam.setViewOffset(gW, gH, x0 + (tx > 0 ? (job.debugMisalignPx ?? 0) : 0), y0, tw, th);
          cam.updateProjectionMatrix();
          // Sub-pixel shift in global pixels: the same NDC offset per pixel in a tile and in the
          // one-piece reference, so both see the identical jitter.
          applyPass(cam, pass, job.lens, { widthPx: tw, heightPx: th });
          // Bottom-left pixel of this tile in global GL coordinates (y up).
          if (globalNoise) setTileOrigin(x0, gH - y0 - th);
          else setTileOrigin(0, 0);

          renderer.setRenderTarget(rt);
          renderer.render(studio.scene, cam);
          renderer.readRenderTargetPixels(rt, 0, 0, tw, th, rgba);
          msGpu += performance.now() - t;

          t = performance.now();
          accumulate(rgba, half, acc, W, tw, th, x0 - region.x, y0 - region.y, cropW, cropH, pass.weight);
          msAccumulate += performance.now() - t;

          job.onProgress?.(++done, total);
          await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between tiles
        }
      }
      wsum += pass.weight;
    }
  } finally {
    rt.dispose();
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevAutoShadow;
    if (studio.shadowMapSize !== prevShadowMap) studio.setShadowMapSize(prevShadowMap);
    studio.setKeyJitter(0, 0);
    studio.setDomeSample(-1, -1);
    setTileOrigin(0, 0);
  }

  // Exposure and pass normalization in one factor; acc becomes the exposed luminance.
  const tone = makeToneMapper(job.look.tone);
  const k = tone.exposure / wsum;
  for (let i = 0; i < acc.length; i++) acc[i] *= k;

  let t = performance.now();
  const bloom = job.look.bloom.enabled && job.look.bloom.intensity > 0
    ? computeBloom(renderer, acc, W, H, job.look.bloom, job.bloomBaseLongSide)
    : undefined;
  const msBloom = performance.now() - t;

  t = performance.now();
  const out = new Uint8Array(W * H);
  const amp = job.dither.amplitude;
  for (let r = 0; r < H; r++) {
    const gy = region.y + r;
    const rh = rowHash(gy, job.dither.seed);
    const row = r * W;
    for (let c = 0; c < W; c++) {
      let y = acc[row + c];
      if (bloom) {
        y += bloom.intensity * bloom.sample(c, r);
        acc[row + c] = y;
      }
      out[row + c] = ditheredIndex(toneOfExposed(tone, y), region.x + c, rh, amp);
    }
  }
  const msTone = performance.now() - t;

  return {
    tone: out,
    linear: job.keepLinear ? acc : undefined,
    width: W,
    height: H,
    stats: {
      width: W,
      height: H,
      tileW: tw,
      tileH: th,
      tileCount: nx * ny,
      grid: [nx, ny],
      gridRequested: [requested.cols, requested.rows],
      shadowMapSize,
      samples,
      passes: job.passes.length,
      colorType: half ? 'float16' : 'float32',
      bloomBase: bloom ? bloom.base : [0, 0],
      msTotal: performance.now() - t0,
      msGpu,
      msAccumulate,
      msBloom,
      msTone,
      bytesCpuPeak: acc.byteLength + out.byteLength + rgba.byteLength,
    },
  };
}

/**
 * Adds weight × Rec.709 luminance of the tile's top-left cropW × cropH pixels to the full-frame
 * buffer at (ox, oy). readPixels returns rows bottom-up, so rows are flipped here.
 */
function accumulate(
  rgba: Float32Array | Uint16Array,
  half: boolean,
  acc: Float32Array,
  W: number,
  tw: number,
  th: number,
  ox: number,
  oy: number,
  cropW: number,
  cropH: number,
  weight: number,
) {
  const f = half ? THREE.DataUtils.fromHalfFloat : (v: number) => v;
  for (let r = 0; r < cropH; r++) {
    let s = (th - 1 - r) * tw * 4;
    let d = (oy + r) * W + ox;
    for (let c = 0; c < cropW; c++, s += 4, d++) {
      acc[d] += weight * (0.2126 * f(rgba[s]) + 0.7152 * f(rgba[s + 1]) + 0.0722 * f(rgba[s + 2]));
    }
  }
}

/**
 * Bloom of the whole frame: box-downsample the exposed luminance to ≤ baseLongSide, run the shared
 * GPU bloom on it (sigmas relative to the frame height, like the viewer), read it back and return
 * a bilinear sampler in full-resolution pixel coordinates.
 */
function computeBloom(renderer: THREE.WebGLRenderer, acc: Float32Array, W: number, H: number, cfg: BloomConfig, baseLongSide: number) {
  const f = Math.max(1, Math.ceil(Math.max(W, H) / baseLongSide));
  const bw = Math.ceil(W / f);
  const bh = Math.ceil(H / f);
  // Half-float RGBA (filterable everywhere); rows bottom-up for GL.
  const data = new Uint16Array(bw * bh * 4);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let n = 0;
      for (let y = by * f; y < Math.min(H, (by + 1) * f); y++) {
        for (let x = bx * f; x < Math.min(W, (bx + 1) * f); x++, n++) s += acc[y * W + x];
      }
      const h = THREE.DataUtils.toHalfFloat(s / n);
      const o = ((bh - 1 - by) * bw + bx) * 4;
      data[o] = data[o + 1] = data[o + 2] = h;
      data[o + 3] = 15360; // 1.0
    }
  }
  const tex = new THREE.DataTexture(data, bw, bh, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const bloom = new Bloom(renderer);
  const prevTarget = renderer.getRenderTarget();
  try {
    bloom.render({ texture: tex, width: bw, height: bh, scale: 1, refHeightPx: bh }, cfg);
    const outp = bloom.readOutput(); // rows bottom-up
    const ow = outp.width;
    const oh = outp.height;
    const map = outp.data;
    return {
      base: [bw, bh] as [number, number],
      intensity: cfg.intensity,
      /** Bilinear sample at full-resolution pixel (x, y), top-down. */
      sample(x: number, y: number): number {
        const u = Math.min(ow - 1, Math.max(0, ((x + 0.5) / W) * ow - 0.5));
        const v = Math.min(oh - 1, Math.max(0, (1 - (y + 0.5) / H) * oh - 0.5));
        const x0 = Math.min(ow - 2, u | 0);
        const y0 = Math.min(oh - 2, v | 0);
        const fx = u - x0;
        const fy = v - y0;
        const i = y0 * ow + x0;
        const top = map[i] + (map[i + 1] - map[i]) * fx;
        const bot = map[i + ow] + (map[i + ow + 1] - map[i + ow]) * fx;
        return top + (bot - top) * fy;
      },
    };
  } finally {
    renderer.setRenderTarget(prevTarget);
    bloom.dispose();
    tex.dispose();
  }
}
