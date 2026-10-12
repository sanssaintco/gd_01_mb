// Page specification. Everything downstream (overlay, tiling, PDF boxes) is derived from this.

export interface PageSpec {
  name: string;
  trimW_mm: number;
  trimH_mm: number;
  bleed_mm: number;
  /** Minimum distance of text / key elements from the trim edge. */
  safety_mm: number;
  dpi: number;
}

export const PAGE_PRESETS = {
  A4: { name: 'A4', trimW_mm: 210, trimH_mm: 297, bleed_mm: 3, safety_mm: 5, dpi: 300 },
  A2: { name: 'A2', trimW_mm: 420, trimH_mm: 594, bleed_mm: 3, safety_mm: 5, dpi: 300 },
} satisfies Record<string, PageSpec>;

export type PageName = keyof typeof PAGE_PRESETS;

/** Active page: the brief's DIN A2 poster. `?page=A4` in the URL switches back to the A4 prototype. */
export const PAGE: PageSpec = PAGE_PRESETS.A2;

export const mmToPt = (mm: number): number => (mm / 25.4) * 72;
export const mmToPx = (mm: number, dpi: number): number => Math.round((mm / 25.4) * dpi);

/** Box as [x, y, width, height]. */
export type Box = [number, number, number, number];

export interface PageGeometry {
  spec: PageSpec;
  /** Media box = trim + bleed on all sides. */
  mediaW_mm: number;
  mediaH_mm: number;
  /** width / height of the media box (bleed included). */
  aspect: number;
  /** Full-bleed raster size at spec.dpi. */
  pxW: number;
  pxH: number;
  /** Boxes in PDF points, origin bottom-left. */
  mediaBox_pt: Box;
  bleedBox_pt: Box;
  trimBox_pt: Box;
  /** Safety area (trim inset by safety_mm) in points. */
  safeBox_pt: Box;
}

export function derivePage(spec: PageSpec = PAGE): PageGeometry {
  const mediaW_mm = spec.trimW_mm + 2 * spec.bleed_mm;
  const mediaH_mm = spec.trimH_mm + 2 * spec.bleed_mm;
  const b = mmToPt(spec.bleed_mm);
  const s = mmToPt(spec.bleed_mm + spec.safety_mm);
  const W = mmToPt(mediaW_mm);
  const H = mmToPt(mediaH_mm);
  return {
    spec,
    mediaW_mm,
    mediaH_mm,
    aspect: mediaW_mm / mediaH_mm,
    pxW: mmToPx(mediaW_mm, spec.dpi),
    pxH: mmToPx(mediaH_mm, spec.dpi),
    mediaBox_pt: [0, 0, W, H],
    bleedBox_pt: [0, 0, W, H],
    trimBox_pt: [b, b, W - 2 * b, H - 2 * b],
    safeBox_pt: [s, s, W - 2 * s, H - 2 * s],
  };
}
