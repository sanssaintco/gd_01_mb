# gd_01_mb · David print

STL of Michelangelo's David → lit monochrome three.js render → tiled offscreen capture →
K-only PDF/X-4 (pdf-lib), built entirely in the browser.

**Live:** https://sanssaintco.github.io/gd_01_mb/

## Use

- Use a desktop browser with WebGL 2 and float render targets. It has been tested in Microsoft
  Edge on Windows. The page downloads the 60 MB model when it opens. Phones and tablets will
  probably run out of memory at full resolution.
- Orbit to frame the shot. The crop rectangle is the printed page: the red line is the trim and
  the dashed blue line is the 5 mm safety margin.
- **PDF/X-4 export → Export PDF** renders DIN A2 at 300 dpi (5031×7087 px) and saves a PDF of
  about 16.5 MB to the downloads folder.
- Nothing is uploaded. Rendering and PDF assembly run in your browser.
- The file is built to PDF/X-4 and passes the checks below. Still, preflight it (Acrobat, callas)
  before it goes to print.
- The browser remembers settings.

URL params:
- `?page=A4` switches to the A4 prototype. The default page is DIN A2 (`PAGE` in `src/config/page.ts`).
- `?model=placeholder` forces the placeholder mesh, and `?stl=<url>` loads another STL.
- `?fresh` ignores the stored camera, preset and settings.

## Develop

Requires Node 24.

```
npm ci
npm run dev          # http://127.0.0.1:5173
npm run typecheck
npm run build        # → dist/
npm run preview      # serves dist/
npm run headless -- viewer [--placeholder | --stl <url>] [--camera '<json>'] [--name <tag>] [--out <dir>]
npm run headless -- preview | seams | render      # same options
npm run headless -- export [--color-model CMYK-K] [--icc <url>] [--to <dir>]
npm run check -- exports/Nachname_Matrikel-Nr_Projektname.pdf --expect A2
```

The headless driver runs the app in Microsoft Edge (Playwright). It can target three servers:
- the dev server (default)
- the production build, served under `/gd_01_mb/` like GitHub Pages (`--dist`; run
  `npm run build` first)
- a deployed site (`--url https://sanssaintco.github.io/gd_01_mb/`)

`export` saves the PDF to `exports/`, which git ignores.

`npm run check` also runs qpdf, poppler (`pdfinfo`, `pdffonts`, `pdfimages`) and Python (`py`)
with PyMuPDF and fontTools, if they are installed.

From Git Bash, set `MSYS_NO_PATHCONV=1` before passing `--stl /path`; otherwise MSYS rewrites the
path to a Windows path.

## Deployment

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
`npm ci` → typecheck → build → GitHub Pages.

One-time setup: in Settings → Pages, set Source to "GitHub Actions".

`base: './'` in `vite.config.ts` makes the build work under any path. GitHub Pages serves it at
`/gd_01_mb/`.

## Assets

Assets are in `public/`; their paths are in `src/config/assets.ts`. See [Credits and licences](#credits-and-licences).

- `David_(Michelangelo).stl`: if it is missing, a placeholder mesh is used and a red banner says so.
- `Coated_Fogra39L_VIGC_300.icc`: the FOGRA39 output-intent profile. Without it, the export stops.
- `Fira_Sans/FiraSans-Regular.ttf`: the test-line font. It is subset-embedded in the PDF.
- `Michelangelo_Signature2.svg`: flattened into vector paths in the PDF.

## Framing and presets

The crop rectangle is the print camera's frustum (media box incl. bleed; red = trim, dashed blue =
5 mm safety). Orbit to frame the shot. "Copy camera JSON" and "Copy preset JSON" in the panel
produce values to paste into `src/config/camera.ts` / `src/config/scene.ts`.

## Print render

Panel folder "Print render":
- **Print preview (25 %)** runs the real tiled pipeline at a quarter of the resolution.
- **Render full resolution** renders the page at 300 dpi: A2 = 5031×7087 px (A4 = 2551×3579). The result is kept
  for the PDF export. The PNG download is for inspection only.
- **Seam test** renders the same view as one image and as 1×1 / 2×2 / 3×3 tiles, then compares them. It also
  runs a deliberately misaligned case, which must be flagged.

The tone controls (exposure, levels, output range, optional dot-gain compensation, dither) apply to
the print only, not to the live viewer. At the defaults, the print matches the viewer.

How it works (`src/render/`):
- Each tile goes into an offscreen 4× MSAA float render target, using `setViewOffset` on one
  virtual camera. It is read back, converted to luminance, tone-mapped and dithered, then
  written into one preallocated `Uint8Array`.
- The dither noise depends only on the global pixel position.
- three.js's soft-shadow noise is patched to use global pixel positions too (`tileNoise.ts`).
- The shadow map is rendered once per job.
- `renderRegion()` renders a sub-rectangle of a virtual image, which is the hook for A2 and multi-sheet
  mosaics. `passes` is the hook for accumulation DOF; only 1 is implemented.
- **GPU memory guard:** a float tile with 4× MSAA needs about 100 B per pixel on the GPU.
  The requested grid is refined until no tile exceeds `maxTileMegapixels` (2.5 Mpx). A4 2×2 stays 2×2; A2
  2×2 becomes 3×5.
- **Shadow map for print:** `printShadowMap: 'auto'` picks the next power of two at or above the image's long side
  (A4 4096, A2 8192), roughly one shadow texel per print pixel. The softness setting is defined at 4096 and
  scaled with the map size, so the penumbra looks the same at any resolution.

## PDF/X-4 export

Panel folder "PDF/X-4 export":
- **Export PDF** renders the full resolution and builds the PDF in the browser. The file goes to the
  browser's download folder; `npm run headless -- export` writes it to `exports/`.
- **File name** defaults to `Nachname_Matrikel-Nr_Projektname.pdf`. Also settable: title, optional author,
  colour model, the test line and the signature width.

The file:
- **Page:** PDF 1.6, one page, DIN A2. MediaBox = BleedBox 426×600 mm; TrimBox 420×594 mm. With
  `?page=A4`: 216×303 / 210×297 mm.
- **Image:** 8-bit DeviceGray, 5031×7087 px at 300 ppi, Flate with PNG predictor, filling the bleed. The file is
  about 16.5 MB, of which about 7.6 MB is the ICC profile.
- **Text:** one line in subset-embedded Fira Sans Regular, `0 g`, top-left on the 5 mm safety line.
- **Signature:** the SVG as flattened vector paths (`0 g`), 80 mm wide, bottom-centre on the safety line.
- **Output intent:** `/GTS_PDFX`, FOGRA39, with `Coated_Fogra39L_VIGC_300.icc` embedded.
- **Metadata:** Info dict + XMP (pdfxid PDF/X-4, identical dates/title/producer); trailer `/ID`; Trapped False.
- **No transparency** and no RGB/Lab/ICCBased colour spaces.
- **Colour model `CMYK-K`** (optional): the same as DeviceCMYK with C=M=Y=0 (`0 0 0 1 k`).

Checks (`npm run check -- <file.pdf>`):
- 36 structural checks in Node. `--expect A2` makes the DIN format a hard check.
- `qpdf --check`, `pdfinfo -box`, `pdffonts`, `pdfimages -list`.
- A PyMuPDF CMYK render (C/M/Y must be 0).
- A fontTools parse of every embedded glyph.

Workarounds for pdf-lib 1.17.1 / @pdf-lib/fontkit 1.1.1:
- **Header:** the writers hardcode `%PDF-1.7`, so the saved header is patched to 1.6. Same length; the
  file uses no 1.7 features.
- **Font subsetting:** the TrueType subsetter writes unpadded glyphs with short `loca` offsets, so most
  glyphs came out broken. `src/pdf/fontkitPatch.ts` pads each glyph to an even length.
- **Empty page entries:** page normalization adds an empty `/Annots` and an empty `/ExtGState`; both
  are removed.
- **Images:** `embedPng` would produce DeviceRGB + SMask, so the image is a raw XObject.

## Layout

- `src/config`: page spec (A4/A2 presets), scene/light preset, camera, asset paths
- `src/viewer`: STL worker, normalization, studio scene, viewer, crop overlay, GUI
- `src/render`: tiled capture, tone/dither, seam test, shadow-noise patch
- `src/pdf`: PDF/X-4 export (boxes, image, font, SVG flattening, Info/XMP, output intent, /ID)
- `scripts`: headless driver (Vite + Edge via Playwright), PDF checker, ink and font checks (Python)
- `public`: model, ICC profile, font, signature (copied into the build unchanged)
- `.github/workflows`: build and deploy to GitHub Pages

## Credits and licences

The MIT licence in [LICENSE](LICENSE) covers the **code**, which is everything outside `public/`.
The files in `public/` are third-party works under their own terms. They are included unaltered.

- **`David_(Michelangelo).stl`**: *David* by Michelangelo, 3D scan by
  [Scan the World](https://www.myminifactory.com/scantheworld/) (MyMiniFactory), via
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:David_(Michelangelo).stl). Licensed
  under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Renders of the model, including PDFs exported from this app, may count as adaptations. To be
  safe, credit Scan the World and share them under CC BY-SA 4.0.
- **`Michelangelo_Signature2.svg`**: Michelangelo's signature, vectorized by Connormah. Public
  domain ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Michelangelo_Signature2.svg)).
- **`Fira_Sans/FiraSans-Regular.ttf`**: Fira Sans, © 2012–2015 The Mozilla Foundation and
  Telefonica S.A. Licensed under the [SIL Open Font License 1.1](public/Fira_Sans/OFL.txt).
- **`Coated_Fogra39L_VIGC_300.icc`**: © X-Rite, Inc., obtained from the International Color
  Consortium. Its terms: "This profile is made available by VIGC, with permission of X-rite, and
  may be used, embedded, exchanged, and shared without restriction. It may not be altered or sold
  without written permission of VIGC."
