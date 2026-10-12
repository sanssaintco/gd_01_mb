// Connects the viewer's framing and studio to tiled render jobs: print preview, full-resolution
// render, seam test. Keeps the last full-resolution result for the PDF export.

import type { PageGeometry } from '../config/page';
import type { RenderConfig } from '../config/render';
import type { Viewer } from '../viewer/viewer';
import { runSeamTest } from './seamTest';
import { type RenderJob, type RenderResult, makePasses, renderRegion } from './tiler';

/** 'auto': next power of two ≥ the image's long side, 2048…8192 (A4 → 4096, A2 → 8192). */
export function printShadowMapSize(setting: RenderConfig['printShadowMap'], width: number, height: number) {
  if (setting !== 'auto') return setting;
  const longSide = Math.max(width, height);
  let size = 2048;
  while (size < longSide && size < 8192) size *= 2;
  return size;
}

export class PrintRenderer {
  /** Last full-resolution render (input for the PDF export). */
  full?: RenderResult;
  busy = false;

  constructor(
    private viewer: Viewer,
    readonly page: PageGeometry,
    readonly cfg: RenderConfig,
  ) {}

  /** Renders the media box at `scale` × print resolution. scale = 1 is kept in `full`. */
  async render(scale: number, onProgress?: (done: number, total: number) => void): Promise<RenderResult> {
    const W = Math.round(this.page.pxW * scale);
    const H = Math.round(this.page.pxH * scale);
    const result = await this.run(() =>
      renderRegion({
        ...this.baseJob(),
        globalWidth: W,
        globalHeight: H,
        tiles: this.cfg.tiles,
        maxTilePixels: this.cfg.maxTileMegapixels * 1e6,
        shadowMapSize: printShadowMapSize(this.cfg.printShadowMap, W, H),
        onProgress,
      }),
    );
    if (scale === 1) this.full = result;
    return result;
  }

  seamTest() {
    return this.run(() => runSeamTest(this.baseJob(), this.cfg.seamTest));
  }

  private baseJob(): Omit<RenderJob, 'globalWidth' | 'globalHeight' | 'tiles'> {
    const c = this.cfg;
    return {
      renderer: this.viewer.renderer,
      studio: this.viewer.studio,
      camera: this.viewer.makePrintCamera(),
      samples: c.msaaSamples,
      passes: makePasses(c.passes),
      tone: c.tone,
      dither: c.dither,
    };
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('a render job is already running');
    this.busy = true;
    this.viewer.pause();
    try {
      return await fn();
    } finally {
      this.viewer.resume();
      this.busy = false;
    }
  }
}
