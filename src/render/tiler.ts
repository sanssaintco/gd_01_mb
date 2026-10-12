// Tiled offscreen capture. The full image is never rendered to the canvas: every tile goes into
// one offscreen MSAA float render target and is read back with readRenderTargetPixels. All tiles
// come from the same virtual camera via setViewOffset(globalW, globalH, x, y, tileW, tileH), so
// they line up without seams.
//
// A "region" is a sub-rectangle of the global virtual image. One sheet = one region, so a
// multi-sheet mosaic later is just a loop over regions of one large virtual image.
//
// No screen-space effects anywhere in this path: they read neighbouring pixels and would seam.
// Depth of field is planned as accumulation (N jittered-camera passes averaged per tile), which
// is tile-safe; the pass loop is in place, only the identity pass is implemented.

import * as THREE from 'three';
import type { ToneConfig } from '../config/render';
import type { Studio } from '../viewer/scene';
import { patchMaterialForTiling, setTileOrigin } from './tileNoise';
import { makeToneMapper, quantizeInto } from './tone';

/** One accumulation pass: sub-pixel shift (in pixels) and lens-aperture offset (−1..1). */
export interface Pass {
  subpixelX: number;
  subpixelY: number;
  lensU: number;
  lensV: number;
  weight: number;
}

export const IDENTITY_PASS: Pass = { subpixelX: 0, subpixelY: 0, lensU: 0, lensV: 0, weight: 1 };

export function makePasses(n: number): Pass[] {
  if (n === 1) return [IDENTITY_PASS];
  throw new Error(`passes = ${n}: jittered accumulation (DOF/AA) is not implemented yet; use 1`);
}

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
  tone: ToneConfig;
  dither: { amplitude: number; seed: number };
  /** Tile-global shadow noise (default true). false = stock three.js, for the seam-test A/B. */
  globalShadowNoise?: boolean;
  /** Also return linear luminance (seam test; 4 bytes per pixel). */
  keepLinear?: boolean;
  /** Render without setViewOffset (1×1 tiles, full image only): the seam-test reference. */
  noViewOffset?: boolean;
  /** Seam-test positive control only: misaligns every tile except the first column by this many px. */
  debugMisalignPx?: number;
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
  msTotal: number;
  /** Render + readback (readPixels waits for the GPU, so this includes GPU time). */
  msGpu: number;
  msConvert: number;
  /** Bytes held during the job: final image + one tile's buffers (CPU side). */
  bytesCpuPeak: number;
}

export interface RenderResult {
  gray: Uint8Array;
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
  const requested = job.noViewOffset ? { cols: 1, rows: 1 } : job.tiles;
  const { cols, rows } = job.noViewOffset
    ? requested
    : fitTileGrid(region.width, region.height, requested, job.maxTilePixels);
  if (cols !== requested.cols || rows !== requested.rows) {
    console.info(`[tiler] ${requested.cols}×${requested.rows} tiles too large for the GPU budget → ${cols}×${rows}`);
  }
  if (job.noViewOffset && (region.width !== gW || region.height !== gH)) {
    throw new Error('noViewOffset renders the full image only');
  }
  const tw = Math.ceil(region.width / cols);
  const th = Math.ceil(region.height / rows);
  // Tiles actually needed (ceil can leave an empty last column/row, e.g. 4 px over 3 tiles).
  const nx = Math.ceil(region.width / tw);
  const ny = Math.ceil(region.height / th);

  const gl = renderer.getContext();
  const maxSize = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  if (tw > maxSize || th > maxSize) {
    throw new Error(`tile ${tw}×${th} exceeds the GPU limit ${maxSize}; use more tiles`);
  }
  const samples = Math.min(job.samples, renderer.capabilities.maxSamples);
  const half = !renderer.extensions.has('EXT_color_buffer_float');
  if (half) console.warn('[tiler] EXT_color_buffer_float missing: falling back to half-float tiles');

  for (const m of [studio.material, studio.floor.material as THREE.Material]) patchMaterialForTiling(m);
  const globalNoise = job.globalShadowNoise ?? true;

  const rt = new THREE.WebGLRenderTarget(tw, th, {
    type: half ? THREE.HalfFloatType : THREE.FloatType,
    samples,
    depthBuffer: true,
  });
  const cam = job.camera.clone();
  cam.aspect = gW / gH;

  const rgba = half ? new Uint16Array(tw * th * 4) : new Float32Array(tw * th * 4);
  const acc = new Float32Array(tw * th);
  const gray = new Uint8Array(region.width * region.height);
  const linear = job.keepLinear ? new Float32Array(region.width * region.height) : undefined;
  const tone = makeToneMapper(job.tone);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoShadow = renderer.shadowMap.autoUpdate;
  const prevShadowMap = studio.shadowMapSize;
  if (job.shadowMapSize) studio.setShadowMapSize(Math.min(job.shadowMapSize, renderer.capabilities.maxTextureSize));
  const shadowMapSize = studio.shadowMapSize;
  // The shadow map is view-independent: render it once, reuse it for every tile.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  let msGpu = 0;
  let msConvert = 0;
  const total = nx * ny;
  try {
    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        // Global, top-down pixel coordinates of this tile.
        const x0 = region.x + tx * tw;
        const y0 = region.y + ty * th;
        const cropW = Math.min(tw, region.x + region.width - x0);
        const cropH = Math.min(th, region.y + region.height - y0);

        acc.fill(0);
        let wsum = 0;
        for (const pass of job.passes) {
          let t = performance.now();
          if (job.noViewOffset) cam.clearViewOffset();
          else {
            const err = tx > 0 ? (job.debugMisalignPx ?? 0) : 0;
            cam.setViewOffset(gW, gH, x0 + pass.subpixelX + err, y0 + pass.subpixelY, tw, th);
          }
          applyLens(cam, pass);
          cam.updateProjectionMatrix();
          // Bottom-left pixel of this tile in global GL coordinates (y up).
          if (globalNoise) setTileOrigin(x0, gH - y0 - th);
          else setTileOrigin(0, 0);

          renderer.setRenderTarget(rt);
          renderer.render(studio.scene, cam);
          renderer.readRenderTargetPixels(rt, 0, 0, tw, th, rgba);
          msGpu += performance.now() - t;

          t = performance.now();
          accumulate(rgba, half, acc, tw, th, cropW, cropH, pass.weight);
          wsum += pass.weight;
          msConvert += performance.now() - t;
        }

        const t = performance.now();
        if (wsum !== 1) for (let i = 0; i < acc.length; i++) acc[i] /= wsum;
        const outOffset = (y0 - region.y) * region.width + (x0 - region.x);
        quantizeInto(acc, tw, cropW, cropH, gray, outOffset, region.width, x0, y0, tone, job.dither);
        if (linear) {
          for (let r = 0; r < cropH; r++) linear.set(acc.subarray(r * tw, r * tw + cropW), outOffset + r * region.width);
        }
        msConvert += performance.now() - t;

        job.onProgress?.(ty * nx + tx + 1, total);
        await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between tiles
      }
    }
  } finally {
    rt.dispose();
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevAutoShadow;
    if (studio.shadowMapSize !== prevShadowMap) studio.setShadowMapSize(prevShadowMap);
    setTileOrigin(0, 0);
  }

  return {
    gray,
    linear,
    width: region.width,
    height: region.height,
    stats: {
      width: region.width,
      height: region.height,
      tileW: tw,
      tileH: th,
      tileCount: total,
      grid: [nx, ny],
      gridRequested: [requested.cols, requested.rows],
      shadowMapSize,
      samples,
      passes: job.passes.length,
      colorType: half ? 'float16' : 'float32',
      msTotal: performance.now() - t0,
      msGpu,
      msConvert,
      bytesCpuPeak: gray.byteLength + rgba.byteLength + acc.byteLength + (linear?.byteLength ?? 0),
    },
  };
}

/**
 * Hook for accumulation DOF: shift the camera on the lens disk and skew the frustum so the focus
 * plane stays registered. Not implemented yet; only the identity pass is allowed.
 */
function applyLens(_cam: THREE.PerspectiveCamera, pass: Pass) {
  if (pass.lensU !== 0 || pass.lensV !== 0) throw new Error('lens offsets (DOF) are not implemented yet');
}

/**
 * Adds weight × Rec.709 luminance of the tile's top-left cropW × cropH pixels to `acc`
 * (top-down rows). readPixels returns rows bottom-up, so rows are flipped here.
 */
function accumulate(
  rgba: Float32Array | Uint16Array,
  half: boolean,
  acc: Float32Array,
  tw: number,
  th: number,
  cropW: number,
  cropH: number,
  weight: number,
) {
  const f = half ? THREE.DataUtils.fromHalfFloat : (v: number) => v;
  for (let r = 0; r < cropH; r++) {
    let s = (th - 1 - r) * tw * 4;
    let d = r * tw;
    for (let c = 0; c < cropW; c++, s += 4, d++) {
      acc[d] += weight * (0.2126 * f(rgba[s]) + 0.7152 * f(rgba[s + 1]) + 0.0722 * f(rgba[s + 2]));
    }
  }
}
