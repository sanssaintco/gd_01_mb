// Crop rectangle over the viewer canvas: media box (incl. bleed), trim line, safety line.
// The rectangle is centered; the viewer derives its fov from it so the rectangle shows exactly
// the print camera's frustum.

import type { PageGeometry } from '../config/page';

export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Largest centered rect with the media aspect that leaves `margin` (fraction) free around it. */
export function computeOverlayRect(cw: number, ch: number, aspect: number, margin = 0.05): OverlayRect {
  let height = ch * (1 - 2 * margin);
  let width = height * aspect;
  const maxW = cw * (1 - 2 * margin);
  if (width > maxW) {
    width = maxW;
    height = width / aspect;
  }
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height };
}

export class CropOverlay {
  readonly el: HTMLDivElement;
  private trim: HTMLDivElement;
  private safe: HTMLDivElement;
  private label: HTMLDivElement;
  private appLabel: HTMLDivElement;

  constructor(parent: HTMLElement, private page: PageGeometry) {
    this.el = div('crop-media');
    this.trim = div('crop-trim');
    this.safe = div('crop-safe');
    // Technical label for the dev mode, short one for the app (CSS shows one of them).
    this.label = div('crop-label crop-label-dev');
    this.appLabel = div('crop-label crop-label-app');
    this.el.append(this.trim, this.safe, this.label, this.appLabel);
    parent.append(this.el);
    const s = page.spec;
    this.label.textContent =
      `${s.name} ${s.trimW_mm}×${s.trimH_mm} mm · bleed ${s.bleed_mm} mm → ` +
      `${page.mediaW_mm}×${page.mediaH_mm} mm · ${page.pxW}×${page.pxH} px @ ${s.dpi} dpi · ` +
      `safety ${s.safety_mm} mm`;
    this.appLabel.textContent = `Poster ${s.name} · ${s.trimW_mm} × ${s.trimH_mm} mm · red line = paper edge after trimming`;
  }

  layout(r: OverlayRect) {
    Object.assign(this.el.style, px(r));
    const s = this.page.spec;
    const k = r.width / this.page.mediaW_mm; // CSS px per mm
    const b = s.bleed_mm * k;
    const sf = (s.bleed_mm + s.safety_mm) * k;
    Object.assign(this.trim.style, px({ left: b, top: b, width: r.width - 2 * b, height: r.height - 2 * b }));
    Object.assign(this.safe.style, px({ left: sf, top: sf, width: r.width - 2 * sf, height: r.height - 2 * sf }));
  }
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function px(r: OverlayRect) {
  return { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` };
}
