// Headless driver: serves the app, opens it in Microsoft Edge (Playwright, no bundled browser
// download) and runs one action.
//
//   node scripts/headless.mjs viewer [--placeholder | --stl <url>] [--camera '<CameraState JSON>'] [--name <tag>] [--out <dir>]
//
//   node scripts/headless.mjs preview [...]
//   node scripts/headless.mjs seams  [...]
//   node scripts/headless.mjs render [...]
//   node scripts/headless.mjs export [--icc <url>] [--color-model CMYK|DeviceGray|CMYK-K] [--to <dir>] [...]
//
// viewer: waits until the model is loaded and the accumulation has converged (--first: after the
//         first sharp pass), prints load stats + WebGL renderer, saves a screenshot.
// preview: runs the print preview (as the GUI button does) and screenshots the page.
// seams:  one-piece vs. tiled render comparison; saves the diff image.
// render: full-resolution tiled render; saves a 25 % preview and a 1:1 crop at the tile junction.
// export: the "Export PDF" path incl. browser download; saves to exports/ (or --to).
//
// Target (any action):
//   (default)      the Vite dev server
//   --dist         the production build in dist/ (run `npm run build` first), served under
//                  /gd_01_mb/ like GitHub Pages serves it
//   --url <site>   an already deployed site, e.g. https://sanssaintco.github.io/gd_01_mb/
// Mode: --dev opens the developer mode (?dev).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [action = 'viewer', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const outDir = path.resolve(opt('--out', path.join(os.tmpdir(), 'david-print-headless')));
fs.mkdirSync(outDir, { recursive: true });

function savePng(dataUrl, name) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return file;
}

let server;
let baseUrl = opt('--url');
if (baseUrl) {
  if (!baseUrl.endsWith('/')) baseUrl += '/';
} else if (flag('--dist')) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('no dist/ build: run `npm run build` first');
  server = await preview({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    base: '/gd_01_mb/',
    preview: { host: '127.0.0.1', port: 5175, strictPort: false },
    logLevel: 'warn',
  });
  baseUrl = server.resolvedUrls.local[0];
} else {
  server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    // Own port, so this also runs while `npm run dev` holds 5173.
    server: { port: 5174, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  // Prefer the real GPU (ANGLE/D3D11); SwiftShader stays allowed as a fallback.
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[browser ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
  });

  const q = new URLSearchParams({ fresh: '1' });
  if (flag('--dev')) q.set('dev', '1');
  if (flag('--placeholder')) q.set('model', 'placeholder');
  if (opt('--stl')) q.set('stl', opt('--stl'));
  if (opt('--icc')) q.set('icc', opt('--icc'));
  if (opt('--page')) q.set('page', opt('--page'));
  const t0 = Date.now();
  await page.goto(`${baseUrl}?${q}`);
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 600_000 });
  const info = await page.evaluate(() => window.__app.info ?? { error: window.__app.error });
  info.target = baseUrl;
  info.msWallClock = Date.now() - t0;

  const camera = opt('--camera');
  if (camera) await page.evaluate((s) => window.__app.viewer.setCameraState(JSON.parse(s)), camera);
  // --setup '<js>': experiment hook, runs in the page with `app` = window.__app before the action.
  const setup = opt('--setup');
  if (setup) await page.evaluate((src) => new (Object.getPrototypeOf(async () => {}).constructor)('app', src)(window.__app), setup);

  if (action === 'viewer') {
    // Wait until the accumulation has converged (all passes at rest), or two frames with --first.
    if (flag('--first')) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    } else {
      const t1 = Date.now();
      await page.waitForFunction(
        () => window.__app.viewer.accumulated >= window.__app.preset.viewer.passes,
        null,
        { timeout: 300_000, polling: 100 },
      );
      info.msConverge = Date.now() - t1;
    }
    const tag = opt('--name', info.model?.isPlaceholder ? 'placeholder' : 'david');
    const shot = path.join(outDir, `viewer-${tag}.png`);
    // --crop: only the print frame (the crop overlay's media box).
    // The overlay rect is relative to #stage, which starts right of the app panel.
    const clip = flag('--crop')
      ? await page.evaluate(() => {
          const r = window.__app.viewer.rect;
          const s = document.getElementById('stage').getBoundingClientRect();
          return { x: s.left + r.left, y: s.top + r.top, width: r.width, height: r.height };
        })
      : undefined;
    await page.screenshot({ path: shot, clip: clip && { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
    info.screenshot = shot;
  } else if (action === 'preview') {
    // Same path as the "Print preview" button; screenshot of the page with the panel open.
    await page.evaluate(() => window.__app.print.preview());
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shot = path.join(outDir, `preview-panel.png`);
    await page.screenshot({ path: shot });
    info.screenshot = shot;
  } else if (action === 'export') {
    const model = opt('--color-model');
    if (model) await page.evaluate((m) => (window.__app.print.exportCfg.colorModel = m), model);
    const download = page.waitForEvent('download', { timeout: 300_000 });
    download.catch(() => {}); // no download on the error path
    const res = await page
      .evaluate(() => window.__app.print.exportPdf())
      .catch((e) => ({ error: e.message.replace(/^.*?Error: /s, '') }));
    if (res.error) {
      info.export = { error: res.error };
    } else {
      const dl = await download;
      const dir = path.resolve(opt('--to', path.join(root, 'exports')));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, dl.suggestedFilename());
      await dl.saveAs(file);
      info.export = { ...res, file };
    }
  } else if (action === 'seams') {
    const rep = await page.evaluate(() => window.__app.print.seamTest());
    info.seams = { ...rep, diffImage: savePng(rep.diffImage, 'seam-diff.png') };
  } else if (action === 'render') {
    const rep = await page.evaluate(() => window.__app.print.fullReport());
    const mem = await page.evaluate(() => performance.memory?.usedJSHeapSize);
    info.render = {
      stats: rep.stats,
      tone: rep.tone,
      jsHeapMB: mem ? Math.round(mem / 2 ** 20) : undefined,
      preview: savePng(rep.preview, `render-${opt('--name', 'full')}-25pct.png`),
      junction: { x: rep.junction.x, y: rep.junction.y, png: savePng(rep.junction.png, `render-${opt('--name', 'full')}-junction.png`) },
    };
  } else {
    throw new Error(`unknown action "${action}"`);
  }

  // --eval '<js>': experiment hook (async, may await), runs after the action with `app`; its return value goes to info.eval.
  const evalSrc = opt('--eval');
  if (evalSrc) info.eval = await page.evaluate((src) => new (Object.getPrototypeOf(async () => {}).constructor)('app', src)(window.__app), evalSrc);

  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
  await server?.close();
}
