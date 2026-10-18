// Print actions behind the GUI buttons, the app's Export button and the headless API: preview,
// full render, seam test, PDF export.

import * as THREE from 'three';
import type { ExportProgress } from './app/appPanel';
import type GUI from 'three/addons/libs/lil-gui.module.min.js';
import { DEFAULT_EXPORT, EXPORT_STORAGE_KEY, type ExportConfig } from './config/export';
import type { PageGeometry } from './config/page';
import { DEFAULT_RENDER, RENDER_STORAGE_KEY } from './config/render';
import { type Student, missingFields, pdfFilename, pdfMeta } from './config/student';
import { buildPdf } from './pdf/exportPdf';
import { crop, downscale, grayStats, indexToCanvas, indexToPngDataUrl } from './render/image';
import { makePreviewPalette } from './render/inks';
import { PrintRenderer } from './render/print';
import type { SeamReport } from './render/seamTest';
import type { RenderResult } from './render/tiler';
import { addExportFolder, addPrintFolder } from './viewer/gui';
import { PrintPanel } from './viewer/printPanel';
import { loadStored } from './viewer/storage';
import type { Viewer } from './viewer/viewer';

/** `student`: the live details from the app panel; when complete they name the PDF and fill its metadata. */
export function setupPrint(
  viewer: Viewer,
  page: PageGeometry,
  gui: GUI,
  setStatus: (s: string) => void,
  student: Student,
) {
  const cfg = loadStored(RENDER_STORAGE_KEY, DEFAULT_RENDER);
  const exportCfg = loadStored(EXPORT_STORAGE_KEY, DEFAULT_EXPORT);
  // ?icc=<url> swaps the output-intent profile for one run (e.g. to test the missing-profile error).
  const iccOverride = new URLSearchParams(location.search).get('icc');
  const print = new PrintRenderer(viewer, page, cfg);
  const panel = new PrintPanel(document.body);
  const progress = (label: string) => (done: number, total: number) =>
    setStatus(`${label}: ${done}/${total} tile renders (${cfg.passes} passes)`);
  /** The ramp's screen colours, for showing a tone-index image. */
  const palette = () => makePreviewPalette(viewer.preset.look);

  const guarded =
    <T>(fn: () => Promise<T>) =>
    async (): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (err) {
        console.error(err);
        panel.message(`Error: ${(err as Error).message}`);
        setStatus(`Error: ${(err as Error).message}`);
        return undefined;
      }
    };

  async function preview() {
    panel.message('Rendering print preview…');
    const r = await print.render(cfg.previewScale, progress('preview'));
    panel.show(indexToCanvas(r.tone, r.width, r.height, palette()), caption('Print preview', r));
    setStatus(`preview done in ${(r.stats.msTotal / 1000).toFixed(1)} s`);
    return r;
  }

  async function renderFull() {
    panel.message(`Rendering ${page.pxW}×${page.pxH} px…`);
    const r = await print.render(1, progress('full render'));
    const small = downscale(r.tone, r.width, r.height, 4);
    panel.show(indexToCanvas(small.gray, small.width, small.height, palette()), caption('Full resolution (shown at 25 %)', r), {
      'Download PNG (inspection only)': () => downloadPng(r, palette()),
    });
    setStatus(`full render done in ${(r.stats.msTotal / 1000).toFixed(1)} s`);
    return r;
  }

  async function seamTest() {
    panel.message('Running seam test…');
    const rep = await print.seamTest();
    const img = new Image();
    img.src = rep.diffImage;
    panel.show(img, formatSeamReport(rep));
    setStatus(`seam test ${rep.pass ? 'PASSED' : 'FAILED'} (${(rep.msTotal / 1000).toFixed(1)} s)`);
    return rep;
  }

  /**
   * Full render → PDF/X-4 → browser download. `quiet` skips the dev print panel (the app panel
   * shows its own progress via `onProgress`); errors are thrown to the caller.
   */
  async function exportPdf(opts: { quiet?: boolean; onProgress?: (p: ExportProgress) => void } = {}) {
    const { quiet = false, onProgress } = opts;
    if (!quiet) panel.message('Rendering full resolution and building the PDF/X-4…');
    const r = await print.render(1, (done, total) => {
      progress('export render')(done, total);
      onProgress?.({ phase: 'render', done, total });
    });
    setStatus('building PDF…');
    onProgress?.({ phase: 'pdf' });
    const runCfg: ExportConfig = iccOverride
      ? { ...exportCfg, outputIntent: { ...exportCfg.outputIntent, iccUrl: iccOverride } }
      : exportCfg;
    const complete = missingFields(student).length === 0;
    const { bytes, report } = await buildPdf({
      tone: r.tone,
      look: viewer.preset.look,
      width: r.width,
      height: r.height,
      page,
      cfg: runCfg,
      meta: complete ? pdfMeta(student) : undefined,
      creator: `david-print (three.js r${THREE.REVISION})`,
    });
    const filename = complete ? pdfFilename(student) : safeFilename(exportCfg.filename);
    download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), filename);
    onProgress?.({ phase: 'done', filename });
    setStatus(`exported ${filename}`);
    if (quiet) return { filename, report, render: r.stats };
    const small = downscale(r.tone, r.width, r.height, 4);
    const ink = report.inks;
    panel.show(
      indexToCanvas(small.gray, small.width, small.height, palette()),
      `PDF/X-4 exported: ${filename}\n` +
        `${(report.bytes / 2 ** 20).toFixed(2)} MB (image ${(report.imageBytes / 2 ** 20).toFixed(2)} MB, ` +
        `ICC ${(report.iccBytes / 2 ** 20).toFixed(2)} MB) · ${exportCfg.colorModel} · ${report.ms.toFixed(0)} ms\n` +
        `ramp CMYK %: light ${ink.light.join('/')} · dark ${ink.dark.join('/')} · max total ink ${ink.maxTac} %` +
        `${ink.kOnlyClippedBelowL ? ` · K-only clips below L* ${ink.kOnlyClippedBelowL}` : ''}\n` +
        `output intent: ${report.iccDescription} · font: ${report.fontName ?? '—'}`,
    );
    return { filename, report, render: r.stats };
  }

  addPrintFolder(gui, cfg, {
    preview: guarded(preview),
    renderFull: guarded(renderFull),
    seamTest: guarded(seamTest),
  });
  addExportFolder(gui, exportCfg, guarded(() => exportPdf()));

  /** For the headless driver: full render + compact, inspectable outputs. */
  async function fullReport() {
    const r = await renderFull();
    const pal = palette();
    const small = downscale(r.tone, r.width, r.height, 4);
    // 1:1 crop centred on the point where the four 2×2 tiles meet.
    const cx = Math.min(r.stats.tileW, r.width - 1);
    const cy = Math.min(r.stats.tileH, r.height - 1);
    const s = 384;
    const junction = crop(r.tone, r.width, Math.max(0, cx - s / 2), Math.max(0, cy - s / 2), s, s);
    return {
      stats: r.stats,
      tone: grayStats(r.tone),
      preview: indexToPngDataUrl(small.gray, small.width, small.height, pal),
      junction: { x: cx, y: cy, png: indexToPngDataUrl(junction.gray, junction.width, junction.height, pal) },
    };
  }

  return { print, cfg, exportCfg, preview, renderFull, seamTest, fullReport, exportPdf };
}

function caption(title: string, r: RenderResult) {
  const s = r.stats;
  const g = grayStats(r.tone);
  const sec = (ms: number) => (ms / 1000).toFixed(2);
  return (
    `${title}\n` +
    `${s.width}×${s.height} px · ${s.passes} passes · ${s.grid.join('×')} tiles of ${s.tileW}×${s.tileH}` +
    `${s.grid.join() !== s.gridRequested.join() ? ` (requested ${s.gridRequested.join('×')}, refined for GPU memory)` : ''}` +
    ` · MSAA ${s.samples} · ${s.colorType} · shadow map ${s.shadowMapSize}` +
    `${s.bloomBase[0] ? ` · bloom at ${s.bloomBase.join('×')}` : ' · bloom off'}\n` +
    `${sec(s.msTotal)} s (GPU+readback ${sec(s.msGpu)} s, accumulate ${sec(s.msAccumulate)} s, ` +
    `bloom ${sec(s.msBloom)} s, tone/dither ${sec(s.msTone)} s)\n` +
    `tone index min ${g.min} · max ${g.max} · mean ${g.mean.toFixed(1)} · unused levels in range ${g.gapsInRange}`
  );
}

function formatSeamReport(rep: SeamReport) {
  const lines = [`Seam test ${rep.width}×${rep.height}: ${rep.pass ? 'PASS' : 'FAIL'} (diff image ×32, white = 0)`];
  for (const c of rep.cases) {
    const f = (v: number) => v.toFixed(3);
    lines.push(
      `${c.label} (tile ${c.tileSize.join('×')}): ${c.pass ? 'no seam' : 'SEAM'}` +
        `${c.mustFail ? (c.pass ? ' ← control NOT detected!' : ' ← control detected') : ''}\n` +
        `  continuous Δ max ${f(c.continuous.max)} mean ${f(c.continuous.mean)} · ` +
        `border band ${f(c.continuous.band.mean)} vs control ${f(c.continuous.control.mean)}\n` +
        `  8-bit Δ max ${c.output8.max} · pixels >1: ${c.output8.countOver}`,
    );
  }
  return lines.join('\n');
}

function downloadPng(r: RenderResult, palette: Uint8Array) {
  indexToCanvas(r.tone, r.width, r.height, palette).toBlob((blob) => {
    if (blob) download(blob, `print-render-${r.width}x${r.height}.png`);
  }, 'image/png');
}

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** No path separators or reserved characters; always ends in .pdf. */
function safeFilename(name: string) {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, '_') || DEFAULT_EXPORT.filename;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}
