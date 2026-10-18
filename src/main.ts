// Wires model loading, studio, viewer, the app panel and the dev GUI. Exposes window.__app for
// the headless scripts.
// URL params: ?dev                developer mode: full control panel, status line (also Shift+D)
//             ?model=placeholder  force the placeholder mesh
//             ?stl=<url>          load a different STL (e.g. to test the missing-file fallback)
//             ?fresh              ignore stored shot/preset (reproducible runs)
//             ?page=A4|A2         page preset (default: PAGE in config/page.ts, i.e. A2)

import * as THREE from 'three';
import { AppPanel, STUDENT_STORAGE_KEY } from './app/appPanel';
import { SHOT_STORAGE_KEY, ShotController, applyShotLights } from './app/shot';
import { ASSETS } from './config/assets';
import { DEFAULT_CAMERA } from './config/camera';
import { PAGE, PAGE_PRESETS, type PageName, derivePage } from './config/page';
import { DEFAULT_SCENE, type ScenePreset } from './config/scene';
import { defaultShot } from './config/shot';
import { EMPTY_STUDENT } from './config/student';
import { setupPrint } from './printUi';
import { SCENE_STORAGE_KEY, buildGui } from './viewer/gui';
import { type LoadedModel, loadStl, normalizeGeometry, placeholderGeometry } from './viewer/model';
import { createStudio } from './viewer/scene';
import { loadStored } from './viewer/storage';
import { Viewer } from './viewer/viewer';

const params = new URLSearchParams(location.search);
// Absolute: the worker would resolve a relative URL against its own script, not this page.
const stlUrl = new URL(params.get('stl') ?? ASSETS.stl, location.href).href;
const statusEl = document.getElementById('status')!;
const bannerEl = document.getElementById('banner')!;
const setStatus = (msg: string) => {
  statusEl.textContent = msg;
};

async function loadModel(preset: ScenePreset['model']): Promise<LoadedModel> {
  let geometry: THREE.BufferGeometry;
  let stats;
  let placeholderReason: string | undefined;
  if (params.get('model') === 'placeholder') {
    geometry = placeholderGeometry();
    placeholderReason = 'forced by ?model=placeholder';
  } else {
    try {
      ({ geometry, stats } = await loadStl({ url: stlUrl, tolerance: ASSETS.stlMergeTolerance }, setStatus));
    } catch (err) {
      const e = err as Error & { notFound?: boolean };
      geometry = placeholderGeometry();
      placeholderReason = e.notFound ? `STL not found at ${decodeURI(stlUrl)}` : `STL failed: ${e.message}`;
      console.warn(`[david-print] ${placeholderReason}; using placeholder mesh`);
    }
  }
  const { upAxis, sourceSize } = normalizeGeometry(geometry, preset.upAxis, preset.height);
  return { geometry, isPlaceholder: !!placeholderReason, placeholderReason, stats, upAxis, sourceSize };
}

async function main() {
  const t0 = performance.now();
  const pageParam = params.get('page');
  const page = derivePage(
    pageParam && pageParam in PAGE_PRESETS ? PAGE_PRESETS[pageParam as PageName] : PAGE,
  );
  const preset = loadStored(SCENE_STORAGE_KEY, DEFAULT_SCENE);
  // The user's shot (camera + light directions); older sessions stored only the camera.
  const storedShot = loadStored(SHOT_STORAGE_KEY, { ...defaultShot(), camera: loadStored('camera', DEFAULT_CAMERA) });
  applyShotLights(preset, storedShot);

  const model = await loadModel(preset.model);
  if (model.isPlaceholder) {
    bannerEl.textContent = `Placeholder mesh: ${model.placeholderReason}`;
    bannerEl.hidden = false;
  }

  const studio = createStudio(model.geometry, preset);
  const viewer = new Viewer(document.getElementById('stage')!, studio, page, storedShot.camera, preset);
  const shot = new ShotController(viewer);
  viewer.onCameraChange = () => shot.changed();
  const accumEl = document.getElementById('accum')!;
  viewer.onAccumulate = (n, total) => {
    if (document.body.classList.contains('dev')) accumEl.textContent = n < total ? `refining ${n}/${total}` : `${n} passes`;
    else accumEl.textContent = n < total ? 'Refining image…' : '';
  };
  const gui = buildGui(viewer, preset, { onShotEdit: () => shot.changed() });
  const student = loadStored(STUDENT_STORAGE_KEY, EMPTY_STUDENT);
  const print = setupPrint(viewer, page, gui, setStatus, student);
  const s = page.spec;
  new AppPanel(document.getElementById('app')!, {
    shot,
    student,
    formatLabel: `${s.name} · ${s.trimW_mm} × ${s.trimH_mm} mm`,
    exportPdf: (onProgress) => print.exportPdf({ quiet: true, onProgress }),
  });

  // Developer mode: ?dev in the URL, toggled with Shift+D.
  const setDev = (on: boolean) => {
    document.body.classList.toggle('dev', on);
    gui.show(on);
  };
  setDev(params.has('dev'));
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
    if (e.shiftKey && e.code === 'KeyD' && !typing) setDev(!document.body.classList.contains('dev'));
  });

  const gl = viewer.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = {
    three: THREE.REVISION,
    webgl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxSamples: gl.getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES),
    page,
    model: {
      isPlaceholder: model.isPlaceholder,
      placeholderReason: model.placeholderReason,
      upAxis: model.upAxis,
      sourceSize: model.sourceSize,
      triangles: (model.geometry.index?.count ?? 0) / 3,
      vertices: model.geometry.attributes.position.count,
      boundingSphereRadius: studio.radius,
      stats: model.stats,
    },
    msTotal: performance.now() - t0,
  };
  console.info('[david-print] ready', info);

  const tris = info.model.triangles.toLocaleString('en');
  setStatus(
    `${model.isPlaceholder ? 'placeholder' : 'David'} · ${tris} tris · ` +
      `${(info.msTotal / 1000).toFixed(1)} s · ${info.webgl}`,
  );

  Object.assign(window, { __app: { ready: true, info, viewer, studio, preset, print, shot, student } });
}

main().catch((err) => {
  setStatus(`Error: ${err}`);
  console.error(err);
  Object.assign(window, { __app: { ready: true, error: String(err) } });
});
