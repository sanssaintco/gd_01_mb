// Loads and validates the output-intent ICC profile. PDF/X-4 needs it embedded, so a missing or
// unsuitable profile aborts the export with a clear message instead of producing a non-X file.

export interface IccProfile {
  bytes: Uint8Array;
  /** Profile description ('desc' tag), used for the OutputIntent /Info entry. */
  description: string;
  version: string;
  /** Number of colour components (4 for CMYK). */
  components: number;
}

export class IccError extends Error {}

export async function loadIcc(url: string): Promise<IccProfile> {
  const file = decodeURI(url.slice(url.lastIndexOf('/') + 1));
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new IccError(`ICC profile could not be loaded (${file}): ${(err as Error).message}`);
  }
  // The Vite dev server answers missing files with index.html (200).
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    await res.body?.cancel();
    throw new IccError(
      `ICC profile missing: ${decodeURI(url)}. PDF/X-4 needs the FOGRA39 output-intent profile ` +
        `embedded; export aborted. Put the profile into public/ or fix ASSETS.icc in src/config/assets.ts.`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseIcc(bytes, file);
}

export function parseIcc(bytes: Uint8Array, name = 'profile'): IccProfile {
  const fail = (why: string) => {
    throw new IccError(`ICC profile ${name} is not usable as a PDF/X-4 output intent: ${why}`);
  };
  if (bytes.length < 132) fail('file too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (sig(36) !== 'acsp') fail('missing "acsp" signature (not an ICC profile)');
  if (v.getUint32(0) !== bytes.length) fail(`size field ${v.getUint32(0)} ≠ file size ${bytes.length}`);
  if (sig(12) !== 'prtr') fail(`device class "${sig(12)}", expected "prtr" (output profile)`);
  if (sig(16) !== 'CMYK') fail(`colour space "${sig(16).trim()}", expected CMYK`);
  const version = `${bytes[8]}.${bytes[9] >> 4}`;
  if (bytes[8] > 4) fail(`ICC version ${version} is newer than PDF 1.6 supports`);
  return { bytes, description: readDescription(bytes, v) ?? name, version, components: 4 };
}

function readDescription(bytes: Uint8Array, v: DataView): string | undefined {
  const count = v.getUint32(128);
  for (let i = 0; i < count; i++) {
    const e = 132 + 12 * i;
    if (String.fromCharCode(...bytes.subarray(e, e + 4)) !== 'desc') continue;
    const off = v.getUint32(e + 4);
    const type = String.fromCharCode(...bytes.subarray(off, off + 4));
    if (type === 'desc') {
      // ICC v2 textDescriptionType: ASCII count (incl. NUL) at +8, text at +12.
      const n = v.getUint32(off + 8);
      return new TextDecoder('latin1').decode(bytes.subarray(off + 12, off + 12 + n - 1));
    }
    if (type === 'mluc') {
      // ICC v4 multiLocalizedUnicodeType: first record, UTF-16BE.
      const len = v.getUint32(off + 20);
      const start = off + v.getUint32(off + 24);
      let s = '';
      for (let j = 0; j < len; j += 2) s += String.fromCharCode(v.getUint16(start + j));
      return s;
    }
  }
  return undefined;
}
