// Structural PDF/X-4 checker for the exported file, plus the external tools found on this machine
// (qpdf, poppler, PyMuPDF ink check). Not a replacement for Acrobat/callas preflight.
// Image: DeviceCMYK (the default colour model) or DeviceGray; text and vector art K only.
// The ink check enforces TAC ≤ 300 %; with --k-only (automatic when every image is DeviceGray)
// also no ink on C, M, Y.
//
//   node scripts/check-pdf.mjs <file.pdf> [--expect A2] [--k-only] [--no-tools]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const runTools = !process.argv.includes('--no-tools');
const expectAt = process.argv.indexOf('--expect');
const expectFormat = expectAt > 0 ? process.argv[expectAt + 1] : undefined;
/** DIN EN ISO 216 A series, portrait, mm. */
const DIN_A = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210] };
if (!file || (expectFormat && !DIN_A[expectFormat])) {
  console.error('usage: node scripts/check-pdf.mjs <file.pdf> [--expect A2] [--no-tools]');
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });
const mm = (pt) => ((pt * 25.4) / 72).toFixed(3);

// ── Header ────────────────────────────────────────────────────────────────────────────────
const head = bytes.subarray(0, 32).toString('latin1');
check('Header is %PDF-1.6', head.startsWith('%PDF-1.6'), head.split(/\r?\n/)[0]);
const binLine = bytes.subarray(head.indexOf('\n') + 1, head.indexOf('\n') + 6);
check('Binary comment after header (≥ 4 bytes ≥ 128)', binLine[0] === 0x25 && [...binLine.subarray(1, 5)].every((b) => b >= 128));

const doc = await PDFDocument.load(bytes, { updateMetadata: false });
const ctx = doc.context;
const L = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const text = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o?.toString());
const get = (dict, key) => L(dict?.get(PDFName.of(key)));

// ── Trailer /ID ───────────────────────────────────────────────────────────────────────────
const id = L(ctx.trailerInfo.ID);
const ids = id instanceof PDFArray ? id.asArray().map((x) => L(x).asString?.() ?? L(x).toString()) : [];
check('Trailer /ID: two 16-byte strings', ids.length === 2 && ids.every((s) => /^[0-9A-Fa-f]{32}$/.test(s)), ids.join(' '));

// ── Info dictionary ───────────────────────────────────────────────────────────────────────
const info = L(ctx.trailerInfo.Info);
const infoVals = {
  Title: text(get(info, 'Title')),
  Author: text(get(info, 'Author')),
  Creator: text(get(info, 'Creator')),
  Producer: text(get(info, 'Producer')),
  CreationDate: text(get(info, 'CreationDate')),
  ModDate: text(get(info, 'ModDate')),
  Trapped: get(info, 'Trapped')?.toString(),
  GTS_PDFXVersion: text(get(info, 'GTS_PDFXVersion')),
};
check('Info /GTS_PDFXVersion (PDF/X-4)', infoVals.GTS_PDFXVersion === 'PDF/X-4', infoVals.GTS_PDFXVersion);
check('Info /Title present', !!infoVals.Title, infoVals.Title);
check('Info /Trapped /False', infoVals.Trapped === '/False', infoVals.Trapped);
check('Info /CreationDate and /ModDate present', infoVals.CreationDate && infoVals.ModDate, `${infoVals.CreationDate} / ${infoVals.ModDate}`);

// ── XMP metadata ──────────────────────────────────────────────────────────────────────────
const metaStream = get(doc.catalog, 'Metadata');
let xmp = '';
if (metaStream instanceof PDFRawStream) {
  check('XMP stream /Type /Metadata /Subtype /XML', get(metaStream.dict, 'Type')?.toString() === '/Metadata' && get(metaStream.dict, 'Subtype')?.toString() === '/XML');
  check('XMP stream uncompressed', !metaStream.dict.get(PDFName.of('Filter')));
  xmp = Buffer.from(decodePDFRawStream(metaStream).decode()).toString('utf8');
} else {
  check('XMP metadata stream present', false);
}
const tag = (name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xmp);
  return m ? unescapeXml(m[1].trim()) : undefined;
};
const xmpVals = {
  title: /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp)?.[1],
  author: /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp)?.[1],
  createDate: tag('xmp:CreateDate'),
  modifyDate: tag('xmp:ModifyDate'),
  creatorTool: tag('xmp:CreatorTool'),
  producer: tag('pdf:Producer'),
  trapped: tag('pdf:Trapped'),
  pdfx: tag('pdfxid:GTS_PDFXVersion'),
  documentId: tag('xmpMM:DocumentID'),
  versionId: tag('xmpMM:VersionID'),
  renditionClass: tag('xmpMM:RenditionClass'),
};
if (xmpVals.title) xmpVals.title = unescapeXml(xmpVals.title);
if (xmpVals.author) xmpVals.author = unescapeXml(xmpVals.author);
check('XMP xpacket wrapper', xmp.startsWith('<?xpacket begin=') && xmp.trimEnd().endsWith('<?xpacket end="w"?>'));
check('XMP pdfxid:GTS_PDFXVersion = PDF/X-4', xmpVals.pdfx === 'PDF/X-4', xmpVals.pdfx);
check('XMP xmpMM:DocumentID / VersionID / RenditionClass', xmpVals.documentId && xmpVals.versionId && xmpVals.renditionClass,
  `${xmpVals.documentId} / ${xmpVals.versionId} / ${xmpVals.renditionClass}`);
check('Info /Title = XMP dc:title', infoVals.Title === xmpVals.title, `"${infoVals.Title}" vs "${xmpVals.title}"`);
check('Info /Author = XMP dc:creator (or both absent)', (infoVals.Author ?? '') === (xmpVals.author ?? ''));
check('Info /Creator = XMP xmp:CreatorTool', infoVals.Creator === xmpVals.creatorTool, xmpVals.creatorTool);
check('Info /Producer = XMP pdf:Producer', infoVals.Producer === xmpVals.producer, xmpVals.producer);
check('Info /CreationDate = XMP xmp:CreateDate', pdfDateToXmp(infoVals.CreationDate) === xmpVals.createDate, `${infoVals.CreationDate} ↔ ${xmpVals.createDate}`);
check('Info /ModDate = XMP xmp:ModifyDate', pdfDateToXmp(infoVals.ModDate) === xmpVals.modifyDate, `${infoVals.ModDate} ↔ ${xmpVals.modifyDate}`);
check('Info /Trapped = XMP pdf:Trapped', infoVals.Trapped === `/${xmpVals.trapped}`, xmpVals.trapped);

// ── OutputIntent ──────────────────────────────────────────────────────────────────────────
const intents = get(doc.catalog, 'OutputIntents');
const intent = intents instanceof PDFArray && intents.size() === 1 ? L(intents.get(0)) : undefined;
check('Exactly one OutputIntent', intent instanceof PDFDict);
let iccInfo = '';
if (intent instanceof PDFDict) {
  check('OutputIntent /S /GTS_PDFX', get(intent, 'S')?.toString() === '/GTS_PDFX');
  check('OutputIntent /OutputConditionIdentifier (FOGRA39)', text(get(intent, 'OutputConditionIdentifier')) === 'FOGRA39', text(get(intent, 'OutputConditionIdentifier')));
  check('OutputIntent /RegistryName', !!text(get(intent, 'RegistryName')), text(get(intent, 'RegistryName')));
  const prof = get(intent, 'DestOutputProfile');
  if (prof instanceof PDFRawStream) {
    const icc = Buffer.from(decodePDFRawStream(prof).decode());
    const sig = (o) => icc.subarray(o, o + 4).toString('latin1');
    const n = get(prof.dict, 'N')?.asNumber?.();
    iccInfo = `${(icc.length / 2 ** 20).toFixed(2)} MB, ICC v${icc[8]}.${icc[9] >> 4}, class ${sig(12)}, ${sig(16)} → ${sig(20)}, /N ${n}, /Info (${text(get(intent, 'Info'))})`;
    check('DestOutputProfile embedded: valid CMYK output profile, /N 4',
      sig(36) === 'acsp' && sig(12) === 'prtr' && sig(16) === 'CMYK' && n === 4 && icc.readUInt32BE(0) === icc.length, iccInfo);
  } else {
    check('DestOutputProfile embedded', false);
  }
}

// ── Pages and boxes ───────────────────────────────────────────────────────────────────────
const pages = doc.getPages();
check('Exactly one page', pages.length === 1, `${pages.length} pages`);
const boxReport = [];
for (const [i, p] of pages.entries()) {
  const raw = (k) => p.node.get(PDFName.of(k));
  const box = (k) => {
    const a = L(raw(k));
    return a instanceof PDFArray ? a.asArray().map((v) => L(v).asNumber()) : undefined;
  };
  const media = box('MediaBox');
  const bleed = box('BleedBox');
  const trim = box('TrimBox');
  const art = box('ArtBox');
  const fmt = (b) => (b ? `[${b.map((v) => v.toFixed(3)).join(' ')}] pt = ${mm(b[2] - b[0])} × ${mm(b[3] - b[1])} mm` : '—');
  boxReport.push({ page: i + 1, MediaBox: fmt(media), BleedBox: fmt(bleed), TrimBox: fmt(trim), ArtBox: fmt(art) });
  check(`p${i + 1}: MediaBox, BleedBox, TrimBox set; no ArtBox`, media && bleed && trim && !art);
  const inside = (a, b) => a && b && a[0] >= b[0] - 1e-6 && a[1] >= b[1] - 1e-6 && a[2] <= b[2] + 1e-6 && a[3] <= b[3] + 1e-6;
  check(`p${i + 1}: TrimBox ⊆ BleedBox ⊆ MediaBox`, inside(trim, bleed) && inside(bleed, media));
  if (trim && bleed) {
    const bleedMm = [trim[0] - bleed[0], trim[1] - bleed[1], bleed[2] - trim[2], bleed[3] - trim[3]].map(mm);
    check(`p${i + 1}: bleed 3 mm on all sides`, bleedMm.every((v) => Math.abs(v - 3) < 0.001), bleedMm.join(' / ') + ' mm');
    const tw = Number(mm(trim[2] - trim[0]));
    const th = Number(mm(trim[3] - trim[1]));
    const format = Object.entries(DIN_A).find(([, [w, h]]) => Math.abs(w - tw) < 0.01 && Math.abs(h - th) < 0.01)?.[0];
    if (expectFormat) {
      check(`p${i + 1}: TrimBox is DIN ${expectFormat} (${DIN_A[expectFormat]?.join(' × ')} mm, portrait)`,
        format === expectFormat, `${tw} × ${th} mm${format ? ` = DIN ${format}` : ''}`);
    } else {
      check(`p${i + 1}: TrimBox is a DIN A format`, !!format, `${tw} × ${th} mm${format ? ` = DIN ${format}` : ''}`);
    }
  }
}

// ── Whole-file scan: colour spaces, transparency, forbidden features ──────────────────────
const FORBIDDEN_NAMES = new Set(['DeviceRGB', 'CalRGB', 'CalGray', 'Lab', 'ICCBased', 'Indexed', 'Separation', 'DeviceN', 'Pattern', 'Transparency']);
const FORBIDDEN_KEYS = new Set(['SMask', 'CA', 'ca', 'BM', 'Group', 'AA', 'OpenAction', 'JavaScript', 'JS', 'EmbeddedFiles', 'Encrypt', 'Annots', 'TR', 'TR2', 'HT']);
const colourSpaces = new Map();
const forbidden = [];
const fonts = [];
const images = [];
const seen = new Set();
function walk(obj, where) {
  obj = L(obj);
  if (!obj || seen.has(obj)) return;
  if (obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFRawStream) seen.add(obj);
  if (obj instanceof PDFRawStream) return walk(obj.dict, where);
  if (obj instanceof PDFArray) return obj.asArray().forEach((v) => walk(v, where));
  if (obj instanceof PDFName) {
    const n = obj.decodeText();
    if (FORBIDDEN_NAMES.has(n)) forbidden.push(`/${n} in ${where}`);
    if (n === 'DeviceGray' || n === 'DeviceCMYK') colourSpaces.set(n, (colourSpaces.get(n) ?? 0) + 1);
    return;
  }
  if (!(obj instanceof PDFDict)) return;
  for (const [k, v] of obj.entries()) {
    const key = k.decodeText();
    const emptyAnnots = key === 'Annots' && L(v) instanceof PDFArray && L(v).size() === 0;
    if (FORBIDDEN_KEYS.has(key) && !emptyAnnots) forbidden.push(`/${key} in ${where}`);
    // The output-intent profile is an ICC stream, not a colour space: its dict holds no names.
    walk(v, `${where}/${key}`);
  }
}
for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
  walk(obj, `obj ${ref.objectNumber}`);
  const dict = obj instanceof PDFRawStream ? obj.dict : obj;
  if (!(dict instanceof PDFDict)) continue;
  const type = get(dict, 'Type')?.toString();
  const subtype = get(dict, 'Subtype')?.toString();
  if (type === '/Font' && subtype !== '/CIDFontType2' && subtype !== '/CIDFontType0') fonts.push(describeFont(dict));
  if (subtype === '/Image') images.push(describeImage(dict, obj));
}
const found = (re) => forbidden.filter((f) => re.test(f));
const csFound = found(/^\/(DeviceRGB|CalRGB|CalGray|Lab|ICCBased|Indexed|Separation|DeviceN|Pattern) /);
const trFound = found(/^\/(SMask|CA|ca|BM|Group|Transparency) /);
const miscFound = found(/^\/(AA|OpenAction|JavaScript|JS|EmbeddedFiles|Encrypt|Annots|TR|TR2|HT) /);
check('No RGB / Lab / ICCBased / Indexed / Separation / DeviceN / Pattern colour spaces', csFound.length === 0,
  csFound.join('; ') || `colour spaces used: ${[...colourSpaces.keys()].join(', ')}`);
check('No transparency (SMask, CA/ca, BM, transparency groups)', trFound.length === 0, trFound.join('; '));
check('No annotations, actions, JavaScript, embedded files, encryption, transfer functions, halftones', miscFound.length === 0, miscFound.join('; '));

// ── Content streams: colour operators ─────────────────────────────────────────────────────
const ops = new Map();
const badOps = [];
for (const [i, p] of pages.entries()) {
  const contents = L(p.node.get(PDFName.of('Contents')));
  const streams = contents instanceof PDFArray ? contents.asArray().map(L) : [contents];
  for (const s of streams) {
    const src = Buffer.from(decodePDFRawStream(s).decode()).toString('latin1');
    const tokens = src
      .replace(/\((?:\\.|[^\\)])*\)/g, ' () ')
      .replace(/<[0-9A-Fa-f\s]*>/g, ' <> ')
      .split(/[\s[\]]+/)
      .filter(Boolean);
    const stack = [];
    for (const t of tokens) {
      if (/^[a-zA-Z'"*]+$/.test(t) && !['true', 'false', 'null'].includes(t)) {
        ops.set(t, (ops.get(t) ?? 0) + 1);
        const args = stack.splice(0).map(Number);
        if (['rg', 'RG', 'sc', 'scn', 'SC', 'SCN', 'cs', 'CS', 'sh', 'gs', 'BI'].includes(t)) badOps.push(`p${i + 1}: ${t}`);
        if ((t === 'k' || t === 'K') && !(args.length === 4 && args[0] === 0 && args[1] === 0 && args[2] === 0)) {
          badOps.push(`p${i + 1}: ${args.join(' ')} ${t} (CMY ≠ 0)`);
        }
      } else {
        stack.push(t);
      }
    }
  }
}
const colourOps = [...ops.keys()].filter((o) => ['g', 'G', 'k', 'K', 'rg', 'RG', 'sc', 'scn', 'SC', 'SCN', 'cs', 'CS'].includes(o));
check('Content streams: only g/G or K-only k/K colour operators; no gs/sh/inline images', badOps.length === 0,
  badOps.join('; ') || `colour operators: ${colourOps.map((o) => `${o}×${ops.get(o)}`).join(', ')}`);

// ── Fonts ─────────────────────────────────────────────────────────────────────────────────
check('All fonts embedded', fonts.length > 0 ? fonts.every((f) => f.embedded) : true, fonts.map((f) => f.summary).join('; ') || 'no fonts');
check('Subset fonts carry a ABCDEF+ tag', fonts.every((f) => f.subset), fonts.map((f) => f.name).join(', '));

// ── Images ────────────────────────────────────────────────────────────────────────────────
const media = pages[0] && L(pages[0].node.get(PDFName.of('MediaBox'))).asArray().map((v) => L(v).asNumber());
for (const im of images) {
  if (media) {
    im.ppiX = im.width / ((media[2] - media[0]) / 72);
    im.ppiY = im.height / ((media[3] - media[1]) / 72);
  }
  check(`Image ${im.width}×${im.height}: ${im.colorSpace}, 8 bit, ≥ 300 ppi (placed full-bleed)`,
    ['/DeviceGray', '/DeviceCMYK'].includes(im.colorSpace) && im.bpc === 8 && im.ppiX > 299.9 && im.ppiY > 299.9,
    `${im.ppiX?.toFixed(2)} × ${im.ppiY?.toFixed(2)} ppi, ${im.filter}, ${(im.bytes / 2 ** 20).toFixed(2)} MB`);
}

// ── Report ────────────────────────────────────────────────────────────────────────────────
const size = fs.statSync(file).size;
console.log(`\n=== ${path.basename(file)} — ${(size / 2 ** 20).toFixed(2)} MB (${size.toLocaleString('en')} bytes) ===\n`);
console.log('Page boxes:');
for (const b of boxReport) for (const [k, v] of Object.entries(b)) if (k !== 'page') console.log(`  p${b.page} ${k.padEnd(9)} ${v}`);
console.log(`\nOutput intent profile: ${iccInfo}`);
console.log(`Colour spaces used: ${[...colourSpaces.entries()].map(([k, v]) => `${k} (${v}×)`).join(', ') || '—'}`);
console.log(`Fonts: ${fonts.map((f) => f.summary).join('; ') || '—'}`);
console.log(`Images: ${images.map((i) => `${i.width}×${i.height} ${i.colorSpace} ${i.bpc} bit ${i.filter}`).join('; ') || '—'}`);
console.log(`Info: ${JSON.stringify(infoVals)}`);
console.log('');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${failed ? `${failed} check(s) FAILED` : `all ${checks.length} structural checks passed`}`);

// K-only ink verdict: forced with --k-only, automatic when every image is DeviceGray.
const kOnly = process.argv.includes('--k-only') || (images.length > 0 && images.every((im) => im.colorSpace === '/DeviceGray'));
if (runTools) runExternalTools(file);
process.exitCode = failed ? 1 : 0;

// ── helpers ───────────────────────────────────────────────────────────────────────────────
function describeFont(dict) {
  const name = get(dict, 'BaseFont')?.decodeText?.() ?? '?';
  const subtype = get(dict, 'Subtype')?.toString();
  let fd = get(dict, 'FontDescriptor');
  if (subtype === '/Type0') {
    const desc = L(get(dict, 'DescendantFonts').get(0));
    fd = get(desc, 'FontDescriptor');
  }
  const fileKey = ['FontFile', 'FontFile2', 'FontFile3'].find((k) => fd?.get(PDFName.of(k)));
  return {
    name,
    embedded: !!fileKey,
    subset: /^[A-Z]{6}\+/.test(name),
    summary: `${name} (${subtype?.slice(1)}${fileKey ? `, ${fileKey}` : ', NOT embedded'}${get(dict, 'ToUnicode') ? ', ToUnicode' : ''})`,
  };
}

function describeImage(dict, stream) {
  const n = (k) => get(dict, k)?.asNumber?.();
  return {
    width: n('Width'),
    height: n('Height'),
    bpc: n('BitsPerComponent'),
    colorSpace: get(dict, 'ColorSpace')?.toString(),
    filter: [get(dict, 'Filter')?.toString(), get(dict, 'DecodeParms') ? `Predictor ${get(get(dict, 'DecodeParms'), 'Predictor')?.toString()}` : '']
      .filter(Boolean)
      .join(' '),
    bytes: stream instanceof PDFRawStream ? stream.getContentsSize() : 0,
  };
}

function pdfDateToXmp(d) {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([+-])(\d{2})'(\d{2})'?$/.exec(d ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}` : undefined;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function findExe(name, globs) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  for (const dir of globs) {
    if (!fs.existsSync(dir.base)) continue;
    for (const d of fs.readdirSync(dir.base)) {
      const p = path.join(dir.base, d, dir.rel);
      if (d.startsWith(dir.prefix) && fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function runExternalTools(pdf) {
  const tools = [
    ['qpdf', ['--check', pdf], [{ base: 'C:/Program Files', prefix: 'qpdf', rel: 'bin/qpdf.exe' }]],
    ['pdfinfo', ['-box', pdf], []],
    ['pdffonts', [pdf], []],
    ['pdfimages', ['-list', pdf], []],
  ];
  for (const [name, args, globs] of tools) {
    const exe = findExe(name, globs);
    console.log(`\n--- ${name} ${args.slice(0, -1).join(' ')} ---`);
    if (!exe) {
      console.log('(not installed)');
      continue;
    }
    const r = spawnSync(exe, args, { encoding: 'utf8' });
    console.log((r.stdout + r.stderr).trim() || `(exit ${r.status}, no output)`);
  }
  const python = process.platform === 'win32' ? 'py' : 'python3';
  for (const [title, script, ...extra] of [
    ['PyMuPDF ink check (render to CMYK)', 'inkcheck.py', ...(kOnly ? ['--k-only'] : [])],
    ['fontTools glyph check of embedded fonts', 'fontcheck.py'],
  ]) {
    console.log(`\n--- ${title} ---`);
    const py = spawnSync(python, ['-I', path.join(here, script), pdf, ...extra], { encoding: 'utf8' });
    console.log((py.stdout + py.stderr).trim() || `(exit ${py.status})`);
  }
}
