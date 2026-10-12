// Flate compression via the browser's native CompressionStream('deflate'), which produces zlib
// streams, exactly what PDF's FlateDecode expects. Non-blocking even for A2-size images.

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PNG "Paeth" row filter for an 8-bit image with `channels` interleaved samples per pixel. Used
 * with /DecodeParms << /Predictor 15 /Colors n /BitsPerComponent 8 /Columns w >>; every row is
 * prefixed with its filter type byte (4 = Paeth). Shrinks dithered photographic content
 * noticeably compared with plain Flate.
 */
export function paethFilter(src: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let o = y * (stride + 1);
    out[o++] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? src[row + i - channels] : 0;
      const b = y > 0 ? src[prev + i] : 0;
      const c = y > 0 && i >= channels ? src[prev + i - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[o++] = (src[row + i] - pred) & 0xff;
    }
  }
  return out;
}
