// PDF/X-4 document-level structures, written as raw PDF objects (pdf-lib has no API for them):
// header version, Info dictionary, XMP metadata, OutputIntent with embedded ICC, trailer /ID.

import { PDFDocument, PDFHeader, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { formatDates } from './dates';
import { deflate } from './deflate';
import type { IccProfile } from './icc';
import { buildXmp } from './xmp';

export interface PdfxMeta {
  title: string;
  author: string;
  creator: string;
  producer: string;
  date: Date;
}

export interface OutputIntentSpec {
  outputConditionIdentifier: string;
  outputCondition: string;
  registryName: string;
}

/** PDF literal string. pdf-lib's PDFString.of writes the value raw, so ( ) \ are escaped here. */
export function literal(s: string) {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(`non-ASCII literal string: ${s}`);
  return PDFString.of(s.replace(/[\\()]/g, '\\$&'));
}

/**
 * PDF/X-4 is based on PDF 1.6. pdf-lib's writers hardcode "%PDF-1.7" (they ignore
 * context.header), so the saved bytes are patched: same length, so no xref offset moves. The file
 * uses no PDF 1.7 features (no object streams; nothing newer than 1.6), so 1.6 is truthful.
 */
export function patchHeaderTo16(bytes: Uint8Array): Uint8Array {
  const expected = PDFHeader.forVersion(1, 7).toString().slice(0, 8);
  const actual = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (actual !== expected) throw new Error(`unexpected PDF header "${actual}"`);
  bytes[7] = '6'.charCodeAt(0);
  return bytes;
}

/** Info dictionary and XMP from the same values; dates are identical in both notations. */
export function writeMetadata(doc: PDFDocument, m: PdfxMeta) {
  const ctx = doc.context;
  const dates = formatDates(m.date);
  const info = ctx.obj({
    Title: PDFHexString.fromText(m.title),
    Creator: PDFHexString.fromText(m.creator),
    Producer: PDFHexString.fromText(m.producer),
    CreationDate: literal(dates.pdf),
    ModDate: literal(dates.pdf),
    Trapped: PDFName.of('False'),
    GTS_PDFXVersion: literal('PDF/X-4'),
  });
  if (m.author) info.set(PDFName.of('Author'), PDFHexString.fromText(m.author));
  ctx.trailerInfo.Info = ctx.register(info);

  const xmp = buildXmp({
    title: m.title,
    author: m.author,
    creatorTool: m.creator,
    producer: m.producer,
    createDate: dates.xmp,
    modifyDate: dates.xmp,
    documentId: `uuid:${crypto.randomUUID()}`,
    instanceId: `uuid:${crypto.randomUUID()}`,
  });
  // Uncompressed, so the metadata stays readable by tools that scan for the packet.
  const meta = ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(meta));
  return dates;
}

export async function writeOutputIntent(doc: PDFDocument, icc: IccProfile, spec: OutputIntentSpec) {
  const ctx = doc.context;
  const profile = ctx.stream(await deflate(icc.bytes), { N: icc.components, Filter: 'FlateDecode' });
  const profileRef = ctx.register(profile);
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFX',
    OutputConditionIdentifier: literal(spec.outputConditionIdentifier),
    OutputCondition: literal(spec.outputCondition),
    RegistryName: literal(spec.registryName),
    Info: literal(icc.description),
    DestOutputProfile: profileRef,
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
  return { compressedBytes: profile.getContentsSize() };
}

/** Trailer /ID: two identical 16-byte strings for a newly created file. */
export function writeTrailerId(doc: PDFDocument) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  return id;
}
