// Print actions behind the GUI buttons and the headless API: preview, full render, seam test.

import * as THREE from 'three';
import type GUI from 'three/addons/libs/lil-gui.module.min.js';
import { DEFAULT_EXPORT, type ExportConfig } from './config/export';
import type { PageGeometry } from './config/page';
import { DEFAULT_RENDER } from './config/render';
import { crop, downscale, grayStats, grayToCanvas, grayToPngDataUrl } from './render/image';
import { buildPdf } from './pdf/exportPdf';
import { PrintRenderer } from './render/print';
import type { SeamReport } from './render/seamTest';
import type { RenderResult } from './render/tiler';
import { addExportFolder, addPrintFolder } from './viewer/gui';
import { PrintPanel } from './viewer/printPanel';
import { loadStored } from './viewer/storage';
import type { Viewer } from './viewer/viewer';

export function setupPrint(viewer: Viewer, page: PageGeometry, gui: GUI, setStatus: (s: string) => void) {
  const cfg = loadStored('render', DEFAULT_RENDER);
  const exportCfg = loadStored('export', DEFAULT_EXPORT);
  // ?icc=<url> swaps the output-intent profile for one run (e.g. to test the missing-profile error).
  const iccOverride = new URLSearchParams(location.search).get('icc');
  const print = new PrintRenderer(viewer, page, cfg);
  const panel = new PrintPanel(document.body);
  const progress = (label: string) => (done: number, total: number) => setStatus(`${label}: tile ${done}/${total}`);

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
    panel.show(grayToCanvas(r.gray, r.width, r.height), caption('Print preview', r));
    setStatus(`preview done in ${(r.stats.msTotal / 1000).toFixed(1)} s`);
    return r;
  }

  async function renderFull() {
    panel.message(`Rendering ${page.pxW}×${page.pxH} px…`);
    const r = await print.render(1, progress('full render'));
    const small = downscale(r.gray, r.width, r.height, 4);
    panel.show(grayToCanvas(small.gray, small.width, small.height), caption('Full resolution (shown at 25 %)', r), {
      'Download PNG (inspection only)': () => downloadPng(r),
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

  async function exportPdf() {
    panel.message('Rendering full resolution and building the PDF/X-4…');
    const r = await print.render(1, progress('export render'));
    setStatus('building PDF…');
    const runCfg: ExportConfig = iccOverride
      ? { ...exportCfg, outputIntent: { ...exportCfg.outputIntent, iccUrl: iccOverride } }
      : exportCfg;
    const { bytes, report } = await buildPdf({
      gray: r.gray,
      width: r.width,
      height: r.height,
      page,
      cfg: runCfg,
      creator: `david-print (three.js r${THREE.REVISION})`,
    });
    const filename = safeFilename(exportCfg.filename);
    download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), filename);
    const small = downscale(r.gray, r.width, r.height, 4);
    panel.show(
      grayToCanvas(small.gray, small.width, small.height),
      `PDF/X-4 exported: ${filename}\n` +
        `${(report.bytes / 2 ** 20).toFixed(2)} MB (image ${(report.imageBytes / 2 ** 20).toFixed(2)} MB, ` +
        `ICC ${(report.iccBytes / 2 ** 20).toFixed(2)} MB) · ${exportCfg.colorModel} · ${report.ms.toFixed(0)} ms\n` +
        `output intent: ${report.iccDescription} · font: ${report.fontName ?? '—'}`,
    );
    setStatus(`exported ${filename}`);
    return { filename, report, render: r.stats };
  }

  addPrintFolder(gui, cfg, {
    preview: guarded(preview),
    renderFull: guarded(renderFull),
    seamTest: guarded(seamTest),
  });
  addExportFolder(gui, exportCfg, guarded(exportPdf));

  /** For the headless driver: full render + compact, inspectable outputs. */
  async function fullReport() {
    const r = await renderFull();
    const small = downscale(r.gray, r.width, r.height, 4);
    // 1:1 crop centred on the point where the four 2×2 tiles meet.
    const cx = Math.min(r.stats.tileW, r.width - 1);
    const cy = Math.min(r.stats.tileH, r.height - 1);
    const s = 384;
    const junction = crop(r.gray, r.width, Math.max(0, cx - s / 2), Math.max(0, cy - s / 2), s, s);
    return {
      stats: r.stats,
      gray: grayStats(r.gray),
      preview: grayToPngDataUrl(small.gray, small.width, small.height),
      junction: { x: cx, y: cy, png: grayToPngDataUrl(junction.gray, junction.width, junction.height) },
    };
  }

  return { print, cfg, exportCfg, preview, renderFull, seamTest, fullReport, exportPdf };
}

function caption(title: string, r: RenderResult) {
  const s = r.stats;
  const g = grayStats(r.gray);
  return (
    `${title}\n` +
    `${s.width}×${s.height} px · ${s.grid.join('×')} tiles of ${s.tileW}×${s.tileH}` +
    `${s.grid.join() !== s.gridRequested.join() ? ` (requested ${s.gridRequested.join('×')}, refined for GPU memory)` : ''}` +
    ` · MSAA ${s.samples} · ${s.colorType} · shadow map ${s.shadowMapSize}\n` +
    `${(s.msTotal / 1000).toFixed(2)} s (GPU+readback ${(s.msGpu / 1000).toFixed(2)} s, ` +
    `tone/dither ${(s.msConvert / 1000).toFixed(2)} s)\n` +
    `gray min ${g.min} · max ${g.max} · mean ${g.mean.toFixed(1)} · unused levels in range ${g.gapsInRange}`
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

function downloadPng(r: RenderResult) {
  grayToCanvas(r.gray, r.width, r.height).toBlob((blob) => {
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
