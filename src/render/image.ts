// Helpers for inspecting the 8-bit gray result: histogram stats, downscaling, crops, PNG previews.
// PNG previews are display-only (canvas PNGs are RGB); the PDF embeds the raw gray buffer.

export interface GrayStats {
  min: number;
  max: number;
  mean: number;
  /** Unused levels between min and max: a sign of banding / posterization when > 0. */
  gapsInRange: number;
  /** Share of pixels at 0 (100 % K) and 255 (paper). */
  fractionBlack: number;
  fractionWhite: number;
}

export function grayStats(g: Uint8Array): GrayStats {
  const h = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < g.length; i++) {
    h[g[i]]++;
    sum += g[i];
  }
  let min = 0;
  while (min < 255 && h[min] === 0) min++;
  let max = 255;
  while (max > 0 && h[max] === 0) max--;
  let gaps = 0;
  for (let v = min; v <= max; v++) if (h[v] === 0) gaps++;
  return {
    min,
    max,
    mean: sum / g.length,
    gapsInRange: gaps,
    fractionBlack: h[0] / g.length,
    fractionWhite: h[255] / g.length,
  };
}

/** Box-filter downscale by an integer factor. */
export function downscale(g: Uint8Array, w: number, h: number, factor: number) {
  const ow = Math.floor(w / factor);
  const oh = Math.floor(h / factor);
  const out = new Uint8Array(ow * oh);
  const n = factor * factor;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = (y * factor + dy) * w + x * factor;
        for (let dx = 0; dx < factor; dx++) s += g[i++];
      }
      out[y * ow + x] = Math.round(s / n);
    }
  }
  return { gray: out, width: ow, height: oh };
}

export function crop(g: Uint8Array, w: number, x: number, y: number, cw: number, ch: number) {
  const out = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) out.set(g.subarray((y + r) * w + x, (y + r) * w + x + cw), r * cw);
  return { gray: out, width: cw, height: ch };
}

export function grayToCanvas(g: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = g[i];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function grayToPngDataUrl(g: Uint8Array, w: number, h: number): string {
  return grayToCanvas(g, w, h).toDataURL('image/png');
}
