// XMP metadata packet for PDF/X-4. Every value that also exists in the Info dictionary (title,
// author, subject, creator tool, producer, dates, trapped) is passed in once and written to both, so they
// cannot drift apart.

export interface DocMeta {
  title: string;
  author: string;
  /** Info /Subject ↔ dc:description. */
  subject?: string;
  creatorTool: string;
  producer: string;
  /** XMP notation, identical instant to the Info dictionary dates. */
  createDate: string;
  modifyDate: string;
  documentId: string;
  instanceId: string;
}

export function buildXmp(m: DocMeta): Uint8Array {
  const e = escapeXml;
  const creator = m.author
    ? `\n      <dc:creator><rdf:Seq><rdf:li>${e(m.author)}</rdf:li></rdf:Seq></dc:creator>`
    : '';
  const description = m.subject
    ? `\n      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${e(m.subject)}</rdf:li></rdf:Alt></dc:description>`
    : '';
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
        xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${e(m.title)}</rdf:li></rdf:Alt></dc:title>${creator}${description}
      <xmp:CreateDate>${m.createDate}</xmp:CreateDate>
      <xmp:ModifyDate>${m.modifyDate}</xmp:ModifyDate>
      <xmp:MetadataDate>${m.modifyDate}</xmp:MetadataDate>
      <xmp:CreatorTool>${e(m.creatorTool)}</xmp:CreatorTool>
      <pdf:Producer>${e(m.producer)}</pdf:Producer>
      <pdf:Trapped>False</pdf:Trapped>
      <xmpMM:DocumentID>${m.documentId}</xmpMM:DocumentID>
      <xmpMM:InstanceID>${m.instanceId}</xmpMM:InstanceID>
      <xmpMM:VersionID>1</xmpMM:VersionID>
      <xmpMM:RenditionClass>default</xmpMM:RenditionClass>
      <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
${padding()}<?xpacket end="w"?>`;
  return new TextEncoder().encode(xml);
}

/** Recommended in-place-edit padding (about 2 KB of whitespace). */
function padding() {
  return (' '.repeat(99) + '\n').repeat(20);
}

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
