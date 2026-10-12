// Builds the K-only PDF/X-4 page: stitched gray image filling the bleed, one test line in subset
// Fira Sans, the flattened signature as vector paths, all in DeviceGray (or CMYK with C=M=Y=0).
// No transparency anywhere: no ExtGState, no SMask, no transparency group, no blend modes.

import fontkit from '@pdf-lib/fontkit';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFOperator,
  type PDFPage,
  appendBezierCurve,
  closePath,
  cmyk,
  concatTransformationMatrix,
  drawObject,
  fill,
  grayscale,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingCmykColor,
  setFillingGrayscaleColor,
} from 'pdf-lib';
import type { ExportConfig } from '../config/export';
import { type PageGeometry, mmToPt } from '../config/page';
import { deflate, paethFilter } from './deflate';
import { patchFontkitSubsetPadding } from './fontkitPatch';
import { loadIcc } from './icc';
import { patchHeaderTo16, writeMetadata, writeOutputIntent, writeTrailerId } from './pdfx';
import { type FlatShape, loadSvgShape } from './svgPath';

export interface PdfInput {
  gray: Uint8Array;
  width: number;
  height: number;
  page: PageGeometry;
  cfg: ExportConfig;
  creator: string;
  date?: Date;
}

export interface PdfReport {
  bytes: number;
  imageBytes: number;
  iccBytes: number;
  iccDescription: string;
  fontName?: string;
  /** Boxes in mm from the bottom-left corner of the media box. */
  textBox_mm?: [number, number, number, number];
  signatureBox_mm?: [number, number, number, number];
  signatureSegments?: number;
  creationDate: string;
  documentIdHex: string;
  ms: number;
}

const PRODUCER = 'david-print 0.1 (pdf-lib 1.17.1)';

export async function buildPdf(inp: PdfInput): Promise<{ bytes: Uint8Array; report: PdfReport }> {
  const t0 = performance.now();
  const { page, cfg } = inp;
  const kOnlyCmyk = cfg.colorModel === 'CMYK-K';

  // Load every external input first: a missing ICC profile must abort before any work is done.
  const icc = await loadIcc(cfg.outputIntent.iccUrl);
  const fontBytes = cfg.text.enabled ? await fetchBytes(cfg.text.fontUrl) : undefined;
  const shape = cfg.signature.enabled ? await loadSvgShape(cfg.signature.url) : undefined;

  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);

  const [, , mw, mh] = page.mediaBox_pt;
  const p = doc.addPage([mw, mh]);
  p.setMediaBox(...page.mediaBox_pt);
  p.setBleedBox(...page.bleedBox_pt);
  p.setTrimBox(...page.trimBox_pt);

  const imageBytes = await placeImage(doc, p, inp, kOnlyCmyk);
  const report: Partial<PdfReport> = {};

  if (fontBytes) {
    patchFontkitSubsetPadding(fontkit, fontBytes);
    const ps = fontkit.create(fontBytes).postscriptName ?? 'FiraSans-Regular';
    const font = await doc.embedFont(fontBytes, {
      subset: true,
      customName: `${subsetTag(ps + cfg.text.content)}+${ps}`,
    });
    const size = cfg.text.sizePt;
    const [sx, sy, sw, sh] = page.safeBox_pt;
    const width = font.widthOfTextAtSize(cfg.text.content, size);
    if (width > sw) throw new Error(`test line is ${Math.round(width)} pt wide, the safety area only ${Math.round(sw)} pt`);
    const ascent = font.heightAtSize(size, { descender: false });
    const baseline = sy + sh - ascent;
    p.drawText(cfg.text.content, { x: sx, y: baseline, size, font, color: kOnlyCmyk ? cmyk(0, 0, 0, 1) : grayscale(0) });
    const descent = font.heightAtSize(size) - ascent;
    report.fontName = `${subsetTag(ps + cfg.text.content)}+${ps}`;
    report.textBox_mm = [sx, baseline - descent, width, ascent + descent].map(ptToMm) as PdfReport['textBox_mm'];
  }

  if (shape) {
    const box = placeSignature(p, shape, page, cfg.signature.widthMm, kOnlyCmyk);
    report.signatureBox_mm = box.map(ptToMm) as PdfReport['signatureBox_mm'];
    report.signatureSegments = shape.segments.length;
  }

  const intent = await writeOutputIntent(doc, icc, cfg.outputIntent);
  const date = inp.date ?? new Date();
  const dates = writeMetadata(doc, {
    title: cfg.title,
    author: cfg.author,
    creator: inp.creator,
    producer: PRODUCER,
    date,
  });
  const id = writeTrailerId(doc);
  removeEmptyPageEntries(p);

  const bytes = patchHeaderTo16(await doc.save({ useObjectStreams: false, addDefaultPage: false }));
  return {
    bytes,
    report: {
      ...report,
      bytes: bytes.length,
      imageBytes,
      iccBytes: intent.compressedBytes,
      iccDescription: icc.description,
      creationDate: dates.pdf,
      documentIdHex: id,
      ms: performance.now() - t0,
    },
  };
}

/** Raw 8-bit image XObject (pdf-lib's embedPng would turn gray into DeviceRGB + SMask). */
async function placeImage(doc: PDFDocument, p: PDFPage, inp: PdfInput, kOnlyCmyk: boolean) {
  const { gray, width: w, height: h } = inp;
  const channels = kOnlyCmyk ? 4 : 1;
  let samples = gray;
  if (kOnlyCmyk) {
    // DeviceCMYK: C = M = Y = 0, K = 1 − gray (0 = no ink).
    samples = new Uint8Array(w * h * 4);
    for (let i = 0, j = 3; i < gray.length; i++, j += 4) samples[j] = 255 - gray[i];
  }
  const data = await deflate(paethFilter(samples, w, h, channels));
  const ctx = doc.context;
  const ref = ctx.register(
    ctx.stream(data, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: kOnlyCmyk ? 'DeviceCMYK' : 'DeviceGray',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: channels, BitsPerComponent: 8, Columns: w },
    }),
  );
  const name = p.node.newXObject('Im', ref);
  const [x, y, mw, mh] = inp.page.mediaBox_pt;
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(mw, 0, 0, mh, x, y), drawObject(name), popGraphicsState());
  return data.length;
}

/**
 * Signature as filled vector paths, `widthMm` wide, centred horizontally, bottom edge on the
 * safety line. The shape is in mm with y down (SVG); PDF is pt with y up.
 */
function placeSignature(p: PDFPage, shape: FlatShape, page: PageGeometry, widthMm: number, kOnlyCmyk: boolean) {
  const b = shape.bbox;
  const s = mmToPt(widthMm) / (b.maxX - b.minX);
  const [mx, , mw] = page.mediaBox_pt;
  const [, safeY] = page.safeBox_pt;
  const w = (b.maxX - b.minX) * s;
  const h = (b.maxY - b.minY) * s;
  const left = mx + (mw - w) / 2;
  const X = (x: number) => round3(left + (x - b.minX) * s);
  const Y = (y: number) => round3(safeY + (b.maxY - y) * s);
  const ops: PDFOperator[] = [pushGraphicsState(), kOnlyCmyk ? setFillingCmykColor(0, 0, 0, 1) : setFillingGrayscaleColor(0)];
  for (const seg of shape.segments) {
    if (seg.op === 'M') ops.push(moveTo(X(seg.x), Y(seg.y)));
    else if (seg.op === 'L') ops.push(lineTo(X(seg.x), Y(seg.y)));
    else if (seg.op === 'C') ops.push(appendBezierCurve(X(seg.x1), Y(seg.y1), X(seg.x2), Y(seg.y2), X(seg.x), Y(seg.y)));
    else ops.push(closePath());
  }
  ops.push(fill(), popGraphicsState());
  p.pushOperators(...ops);
  return [left, safeY, w, h] as [number, number, number, number];
}

/**
 * pdf-lib's page normalization adds an empty /Annots array and an empty /ExtGState dictionary.
 * Neither belongs in a print file; the page is already normalized, so they are not re-added.
 */
function removeEmptyPageEntries(p: PDFPage) {
  const annots = p.node.Annots();
  if (annots && annots.size() === 0) p.node.delete(PDFName.of('Annots'));
  const res = p.node.Resources();
  const gs = res?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  if (res && gs && gs.keys().length === 0) res.delete(PDFName.of('ExtGState'));
}

/** Deterministic 6-letter subset tag (ISO 32000: "ABCDEF+FontName" for subset fonts). */
function subsetTag(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + Math.imul(h, 7) + i;
    h >>>= 0;
  }
  return tag;
}

async function fetchBytes(url: string) {
  const res = await fetch(url);
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`asset not found: ${decodeURI(url)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const ptToMm = (v: number) => Math.round(((v * 25.4) / 72) * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
