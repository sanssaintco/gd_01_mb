"""Font integrity check: extracts every embedded TrueType font program (FontFile2) and parses
every glyph with fontTools. Catches broken subsets that pdffonts still reports as fine (e.g.
misaligned short-loca offsets, which made most characters of a line disappear).

usage: py -I scripts/fontcheck.py <file.pdf>
"""

import io
import sys

import pymupdf
from fontTools.ttLib import TTFont


def main():
    ok = True
    found = 0
    with pymupdf.open(sys.argv[1]) as doc:
        for xref in range(1, doc.xref_length()):
            obj = doc.xref_object(xref) or ""
            if "/FontFile2" not in obj:
                continue
            found += 1
            name = doc.xref_get_key(xref, "FontName")[1]
            ff = int(doc.xref_get_key(xref, "FontFile2")[1].split()[0])
            font = TTFont(io.BytesIO(doc.xref_stream(ff)))
            glyf = font["glyf"]
            upm = font["head"].unitsPerEm
            bad = []
            for gname in font.getGlyphOrder():
                try:
                    g = glyf[gname]
                    if g.numberOfContours == 0:
                        continue
                    if g.isComposite():
                        g.getComponentNames(glyf)
                    else:
                        g.getCoordinates(glyf)
                    if not (-2 * upm < g.xMin <= g.xMax < 4 * upm and -2 * upm < g.yMin <= g.yMax < 4 * upm):
                        bad.append(f"{gname}: bbox {g.xMin},{g.yMin},{g.xMax},{g.yMax}")
                except Exception as e:  # noqa: BLE001 - any parse failure means a broken glyph
                    bad.append(f"{gname}: {e}")
            n = len(font.getGlyphOrder())
            status = "OK" if not bad else f"{len(bad)} BROKEN"
            print(f"{name}: {n} glyphs, loca format {font['head'].indexToLocFormat}, glyphs {status}")
            for b in bad[:10]:
                print(f"    {b}")
            ok = ok and not bad
    if not found:
        print("no embedded TrueType fonts")
    print("PASS: embedded fonts parse cleanly" if ok else "FAIL: broken glyphs in embedded font")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
