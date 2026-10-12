"""Ink check: renders every page to a CMYK pixmap with PyMuPDF and reports per-plate coverage.

K-only means the C, M and Y plates stay empty. Two renders:
  * ICC off: device conversion, DeviceGray -> K = 1 - gray (how PDF/X workflows treat
    DeviceGray with a CMYK output intent). This is the K-only verdict.
  * ICC on: MuPDF's colour-managed conversion through its default profiles, shown for
    information only (that path may build gray from CMY, which a print RIP does not do).

usage: py -I scripts/inkcheck.py <file.pdf> [dpi]
"""

import sys

import numpy as np
import pymupdf


def coverage(pdf: str, dpi: int, icc: bool):
    pymupdf.TOOLS.set_icc(icc)
    out = []
    with pymupdf.open(pdf) as doc:
        warnings = pymupdf.TOOLS.mupdf_warnings()
        for page in doc:
            pix = page.get_pixmap(colorspace=pymupdf.csCMYK, dpi=dpi, alpha=False)
            a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(-1, 4).astype(np.float64) / 255
            out.append(
                {
                    "page": page.number + 1,
                    "size": f"{pix.width}x{pix.height}",
                    "max": a.max(axis=0),
                    "mean": a.mean(axis=0),
                    "tac": a.sum(axis=1).max(),
                }
            )
    return out, warnings


def main():
    pdf = sys.argv[1]
    dpi = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    ok = True
    for icc in (False, True):
        pages, warnings = coverage(pdf, dpi, icc)
        label = "ICC on (info only)" if icc else "ICC off (verdict)"
        for p in pages:
            mx, mean = p["max"], p["mean"]
            cmy_max = mx[:3].max()
            line = (
                f"{label:20} p{p['page']} {p['size']} @ {dpi} dpi | "
                f"max C {mx[0]:.1%} M {mx[1]:.1%} Y {mx[2]:.1%} K {mx[3]:.1%} | "
                f"mean K {mean[3]:.1%} | max total ink (TAC) {p['tac']:.0%}"
            )
            if not icc:
                k_only = cmy_max == 0
                ok = ok and k_only
                line += " | " + ("K-ONLY" if k_only else "CMY INK FOUND")
            print(line)
        if warnings and not icc:
            print(f"MuPDF warnings while opening: {warnings}")
    if not pages:
        ok = False
    print("PASS: K plate only" if ok else "FAIL: ink on C/M/Y plates")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
