// Workaround for a bug in @pdf-lib/fontkit 1.1.1's TrueType subsetter (TTFSubset):
//
// _addGlyph copies each glyph's raw bytes unpadded. For subsets under 64 KB, loca.preEncode then
// switches to the *short* loca format, which stores offset / 2 and therefore needs every glyph
// to start on an even byte. Fonts like Fira Sans use long loca with odd-length glyphs, so after
// the first odd glyph every following glyph is read from a wrong offset: in the exported PDF
// most characters of the test line were simply missing (verified with poppler and fontTools).
//
// The fix pads each copied glyph to an even length with a zero byte (valid TrueType; many fonts
// pad their glyphs anyway), so short-loca offsets stay exact. Applied once per page load.

interface SubsetProto {
  _addGlyph(this: SubsetInstance, gid: number): number;
  __evenGlyphPadding?: true;
}
interface SubsetInstance {
  glyf: Array<Uint8Array & { constructor: { alloc?: (n: number) => Uint8Array } }>;
  offset: number;
}
interface FontkitLike {
  create(bytes: Uint8Array): { createSubset(): object };
}

export function patchFontkitSubsetPadding(fontkit: FontkitLike, ttfBytes: Uint8Array) {
  const proto = Object.getPrototypeOf(fontkit.create(ttfBytes).createSubset()) as SubsetProto;
  if (proto.__evenGlyphPadding || typeof proto._addGlyph !== 'function') return; // patched or CFF subset
  const addGlyph = proto._addGlyph;
  proto._addGlyph = function (gid) {
    const index = addGlyph.call(this, gid);
    const buf = this.glyf[index];
    if (buf.length % 2 === 1) {
      // Keep the buffer type fontkit uses (its Buffer polyfill), zero-filled.
      const padded = buf.constructor.alloc ? buf.constructor.alloc(buf.length + 1) : new Uint8Array(buf.length + 1);
      for (let i = 0; i < buf.length; i++) padded[i] = buf[i];
      padded[buf.length] = 0;
      this.glyf[index] = padded as SubsetInstance['glyf'][number];
      this.offset += 1;
    }
    return index;
  };
  proto.__evenGlyphPadding = true;
}
