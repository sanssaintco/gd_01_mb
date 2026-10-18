"""Ink check: renders every page to a CMYK pixmap with PyMuPDF and reports per-plate coverage.

Two renders:
  * ICC off: device values as written (DeviceCMYK passes through, DeviceGray -> K = 1 - gray,
    as PDF/X workflows treat DeviceGray with a CMYK output intent). This is the verdict.
  * ICC on: MuPDF's colour-managed conversion through its default profiles, shown for
    information only (that path may rebuild colours from other plates, which a RIP does not do).

Verdict: maximum total ink (TAC) within --tac (default 300 %, Coated FOGRA39 300); with --k-only
also no ink on C, M or Y (the K-only colour models).

usage: py -I scripts/inkcheck.py <file.pdf> [dpi] [--k-only] [--tac 300]
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
            tac = a.sum(axis=1)
            darkest = a[tac.argmax()]
            out.append(
                {
                    "page": page.number + 1,
                    "size": f"{pix.width}x{pix.height}",
                    "max": a.max(axis=0),
                    "mean": a.mean(axis=0),
                    "tac": tac.max(),
                    "darkest": darkest,
                }
            )
    return out, warnings


def main():
    args = [a for a in sys.argv[1:]]
    k_only = "--k-only" in args
    tac_limit = 3.0
    if "--tac" in args:
        tac_limit = float(args[args.index("--tac") + 1]) / 100
        del args[args.index("--tac") : args.index("--tac") + 2]
    args = [a for a in args if a != "--k-only"]
    pdf = args[0]
    dpi = int(args[1]) if len(args) > 1 else 150
    ok = True
    pages = []
    for icc in (False, True):
        pages, warnings = coverage(pdf, dpi, icc)
        label = "ICC on (info only)" if icc else "ICC off (verdict)"
        for p in pages:
            mx, mean, dk = p["max"], p["mean"], p["darkest"]
            cmy_max = mx[:3].max()
            line = (
                f"{label:20} p{p['page']} {p['size']} @ {dpi} dpi | "
                f"max C {mx[0]:.1%} M {mx[1]:.1%} Y {mx[2]:.1%} K {mx[3]:.1%} | "
                f"mean C {mean[0]:.1%} M {mean[1]:.1%} Y {mean[2]:.1%} K {mean[3]:.1%} | "
                f"max total ink (TAC) {p['tac']:.0%} at C {dk[0]:.0%} M {dk[1]:.0%} Y {dk[2]:.0%} K {dk[3]:.0%}"
            )
            if not icc:
                tac_ok = p["tac"] <= tac_limit + 0.5 / 255
                line += " | " + ("TAC OK" if tac_ok else f"TAC OVER {tac_limit:.0%}")
                ok = ok and tac_ok
                line += " | " + ("K-ONLY" if cmy_max == 0 else "CMYK")
                if k_only:
                    ok = ok and cmy_max == 0
            print(line)
        if warnings and not icc:
            print(f"MuPDF warnings while opening: {warnings}")
    if not pages:
        ok = False
    verdict = f"TAC <= {tac_limit:.0%}" + (", K plate only" if k_only else "")
    print(f"PASS: {verdict}" if ok else f"FAIL: expected {verdict}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
