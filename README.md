# gd_01_mb · David print

STL of Michelangelo's David → high-key three.js render (accumulated passes, depth of field, soft
area and dome light, bloom) → tiled offscreen capture → CMYK PDF/X-4 (pdf-lib), built entirely in
the browser.

**Live:** https://sanssaintco.github.io/gd_01_mb/

## Use

- Use a desktop browser with WebGL 2 and float render targets. It has been tested in Microsoft
  Edge on Windows. The page downloads the 60 MB model when it opens. Phones and tablets will
  probably run out of memory at full resolution.
- **Your details:** enter forename, surname and student number. They name the PDF
  (`Surname_StudentNumber_01_MB.pdf`) and go into its metadata (Author, Subject). Export stays
  locked until all three are filled in.
- **Framing:** drag to orbit, scroll to zoom, right-drag to pan. The focal-length slider (24–135 mm,
  35 mm equivalent) keeps David's size in the frame and changes only the perspective. The crop
  rectangle is the printed page; the red line is the trim.
- **Light:** direction and height of the key, fill and rim light.
- **Export PDF** renders DIN A2 at 300 dpi (5031×7087 px, 32 passes) and saves a PDF of about
  18 MB to the downloads folder. It takes about a minute.
- Nothing is uploaded. Rendering and PDF assembly run in your browser.
- The file is built to PDF/X-4 and passes the checks below. Still, preflight it (Acrobat, callas)
  before it goes to print.
- The browser remembers your details and your shot (camera and light directions).

URL params:
- `?dev` opens the developer mode: the full control panel, the status line and technical crop
  labels. **Shift+D** toggles it at any time.
- `?page=A4` switches to the A4 prototype. The default page is DIN A2 (`PAGE` in `src/config/page.ts`).
- `?model=placeholder` forces the placeholder mesh, and `?stl=<url>` loads another STL.
- `?fresh` ignores everything stored (shot, details, preset, settings).

## The look

The image imitates high-key photography of a marble statue. One pipeline, shared by the live
viewer and the print (`src/render/look.ts`):

```
scene (linear HDR) → N jittered passes (anti-aliasing · lens · key-light area · dome direction)
                   → + bloom on the whole frame (radii relative to the frame height)
                   → exposure → filmic tone curve → tone t ∈ [0, 1]
                   → colour ramp t → Lab, from #2b2a28 (darkest) to #deddde (brightest)
                   → viewer: Lab → sRGB  |  print: Lab → FOGRA39 B2A1 → CMYK
```

- **Accumulation** (`passes.ts`): a deterministic low-discrepancy sequence. Each pass shifts the
  camera by a sub-pixel, moves it on a thin-lens aperture (depth of field, focus on the first
  surface at frame centre), moves the key light on its disk (soft area shadows) and points the
  **dome light** at the next direction of a sphere (soft ambient light with occlusion).
- **Live viewer:** one sharp pass while the view moves; at rest it keeps adding passes (64 by
  default) and refines within seconds.
- **Bloom** (`bloom.ts`): soft-knee threshold, downsample pyramid, one separable gaussian per
  component, weighted sum. The same GPU code runs in the viewer and on the stitched print frame.
- **Tone curve:** two cubic Hermite segments in log space (toe, pivot, shoulder), monotone by
  construction.
- **Marble shading** (`marble.ts`): optional wrap lighting on the diffuse term.

## Two interfaces

- **App UI** (default, `src/app/`): details, framing, focal length, light directions, reset,
  export. Nothing else.
- **Developer UI** (`?dev`, lil-gui): every setting: lens, tone curve, ramp colours, bloom,
  material, lights incl. intensities, dome, background, accumulation, print quality, export.
  "Copy camera JSON" and "Copy preset JSON" produce values to paste into
  `src/config/camera.ts` / `src/config/scene.ts`.
- The user's **shot** (camera, focal length, light directions) is stored separately from the
  developer's **preset**, so neither overwrites the other.

## Develop

Requires Node 24.

```
npm ci
npm run dev          # http://127.0.0.1:5173  (add ?dev for the developer UI)
npm run typecheck
npm run build        # → dist/
npm run preview      # serves dist/
npm run headless -- viewer [--dev] [--first] [--crop] [--camera '<json>'] [--name <tag>] [--out <dir>]
npm run headless -- preview | seams | render      # same options
npm run headless -- export [--color-model CMYK|DeviceGray|CMYK-K] [--icc <url>] [--to <dir>]
npm run check -- exports/<file>.pdf --expect A2
node scripts/icc-crosscheck.mjs                   # ICC transforms vs LittleCMS (Pillow)
```

The headless driver runs the app in Microsoft Edge (Playwright). It can target three servers:
- the dev server (default)
- the production build, served under `/gd_01_mb/` like GitHub Pages (`--dist`; run
  `npm run build` first)
- a deployed site (`--url https://sanssaintco.github.io/gd_01_mb/`)

`viewer` waits until the accumulation has converged (`--first`: after the first sharp pass).
`--crop` screenshots only the print frame. `--setup '<js>'` and `--eval '<js>'` run code in the
page (with `app` = `window.__app`) before and after the action; `--eval` returns its result.

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
- `Coated_Fogra39L_VIGC_300.icc`: the FOGRA39 output-intent profile; its B2A1/A2B1 tables also
  drive the CMYK conversion. Without it, the export stops.
- `Fira_Sans/FiraSans-Regular.ttf`: the test-line font. It is subset-embedded in the PDF.
- `Michelangelo_Signature2.svg`: flattened into vector paths in the PDF.

## Print render

Developer UI, folder "Print render":
- **Print preview (25 %)** runs the real tiled pipeline at a quarter of the resolution.
- **Render full resolution** renders the page at 300 dpi: A2 = 5031×7087 px (A4 = 2551×3579). The PNG
  download is for inspection only.
- **Seam test** renders the same view (8 passes, bloom) as one image and as 1×1 / 2×2 / 3×3 tiles,
  then compares them. It also runs a deliberately misaligned case, which must be flagged.
- Settings: print passes (default 32), bloom resolution, dither.

How it works (`src/render/tiler.ts`):
- **Passes outside, tiles inside.** Per pass the lights move, the shadow maps are rendered once, and
  every tile is rendered from one virtual camera via `setViewOffset` into an offscreen 4× MSAA
  float target, read back and added to one full-frame float luminance buffer.
- Only then does anything look at neighbouring pixels: bloom on the stitched frame (box-downsampled
  to ≤ 2048 px, the shared GPU bloom, bilinear upsample), then tone curve and TPDF dither into an
  8-bit tone index. The dither noise depends only on the global pixel position.
- three.js's soft-shadow noise is patched to use global pixel positions too (`tileNoise.ts`).
- `renderRegion()` renders a sub-rectangle of a virtual image, which is the hook for multi-sheet
  mosaics.
- **GPU memory guard:** a float tile with 4× MSAA needs about 100 B per pixel on the GPU.
  The requested grid is refined until no tile exceeds `maxTileMegapixels` (2.5 Mpx). A4 2×2 stays 2×2; A2
  2×2 becomes 3×5.
- **Shadow map for print:** `printShadowMap: 'auto'` picks the next power of two at or above the image's long side
  (A4 4096, A2 8192), roughly one shadow texel per print pixel. The softness setting is scaled with the
  map size, so the penumbra looks the same at any resolution.

## PDF/X-4 export

The file:
- **Page:** PDF 1.6, one page, DIN A2. MediaBox = BleedBox 426×600 mm; TrimBox 420×594 mm. With
  `?page=A4`: 216×303 / 210×297 mm.
- **Image:** 8-bit **DeviceCMYK**, 5031×7087 px at 300 ppi, Flate with PNG predictor, filling the bleed.
  The tone index goes through the ramp and the profile's B2A1 table (relative colorimetric,
  `src/pdf/iccLut.ts`: lut16 parser with LittleCMS-style tetrahedral interpolation). Ramp ends:
  #deddde ≈ C15 M12 Y12 K0, #2b2a28 ≈ C56 M49 Y49 K92; max total ink ≈ 245 %.
- **Text:** one line in subset-embedded Fira Sans Regular, `0 0 0 1 k`, top-left on the 5 mm safety line.
- **Signature:** the SVG as flattened vector paths (`0 0 0 1 k`), 80 mm wide, bottom-centre on the safety line.
- **Output intent:** `/GTS_PDFX`, FOGRA39, with `Coated_Fogra39L_VIGC_300.icc` embedded.
- **Metadata:** Info dict + XMP (pdfxid PDF/X-4, identical dates/title/author/subject/producer);
  trailer `/ID`; Trapped False.
- **No transparency** and no RGB/Lab/ICCBased colour spaces.
- **Fallback colour models** (developer UI): `DeviceGray` and `CMYK-K` print on the K plate only; the
  K curve reproduces the ramp's lightness, the tints are lost.

Checks (`npm run check -- <file.pdf>`):
- 36 structural checks in Node. `--expect A2` makes the DIN format a hard check.
- `qpdf --check`, `pdfinfo -box`, `pdffonts`, `pdfimages -list`.
- A PyMuPDF CMYK render: total ink ≤ 300 %; K plate only for DeviceGray files (or `--k-only`).
- A fontTools parse of every embedded glyph.

`node scripts/icc-crosscheck.mjs` compares the in-browser ICC transforms with LittleCMS: the poster
ramp within ΔE 0.5 (measured 0.26), CMYK → sRGB within 2 steps (measured 1).

Workarounds for pdf-lib 1.17.1 / @pdf-lib/fontkit 1.1.1:
- **Header:** the writers hardcode `%PDF-1.7`, so the saved header is patched to 1.6. Same length; the
  file uses no 1.7 features.
- **Font subsetting:** the TrueType subsetter writes unpadded glyphs with short `loca` offsets, so most
  glyphs came out broken. `src/pdf/fontkitPatch.ts` pads each glyph to an even length.
- **Empty page entries:** page normalization adds an empty `/Annots` and an empty `/ExtGState`; both
  are removed.
- **Images:** `embedPng` would produce DeviceRGB + SMask, so the image is a raw XObject.

## Layout

- `src/app`: app UI panel, the user's shot (camera + light directions)
- `src/config`: page spec (A4/A2 presets), scene/look preset, camera, shot, student details, asset paths
- `src/viewer`: STL worker, normalization, studio scene, viewer with progressive accumulation,
  display pipeline, crop overlay, developer GUI
- `src/render`: look (tone curve, ramp, colour maths), passes, bloom, marble shading, inks, tiled
  capture, tone/dither, seam test, shadow-noise patch
- `src/pdf`: PDF/X-4 export (boxes, image, font, SVG flattening, Info/XMP, output intent, /ID), ICC tables
- `scripts`: headless driver (Vite + Edge via Playwright), PDF checker, ICC cross-check, ink and
  font checks (Python)
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
