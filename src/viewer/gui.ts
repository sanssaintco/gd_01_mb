// Tweak panel (lil-gui ships with three, no extra dependency). Edits the preset object in place,
// re-applies it to the studio and persists it.

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { DEFAULT_CAMERA } from '../config/camera';
import type { ExportConfig } from '../config/export';
import { DEFAULT_RENDER, type RenderConfig } from '../config/render';
import { DEFAULT_SCENE, type LightSpec, type ScenePreset } from '../config/scene';
import { copyText, saveStored } from './storage';
import type { Viewer } from './viewer';

export function buildGui(viewer: Viewer, preset: ScenePreset): GUI {
  const studio = viewer.studio;
  const gui = new GUI({ title: 'David · print studio' });
  const changed = () => {
    studio.apply(preset);
    viewer.requestRender();
    saveStored('scene', preset);
  };

  const framing = gui.addFolder('Framing (print camera)');
  const lens = {
    get printFovDeg() {
      return viewer.printFovDeg;
    },
    set printFovDeg(v: number) {
      viewer.setPrintFov(v);
    },
    get focal() {
      // 35 mm equivalent, portrait: 36 mm sensor side along the long (vertical) edge.
      return `${(18 / Math.tan((viewer.printFovDeg * Math.PI) / 360)).toFixed(0)} mm`;
    },
    copyCamera: () => copyText(JSON.stringify(viewer.getCameraState(), null, 2)),
    resetCamera: () => {
      viewer.setCameraState(structuredClone(DEFAULT_CAMERA));
      viewer.onCameraChange(viewer.getCameraState());
    },
  };
  framing
    .add(lens, 'printFovDeg', 5, 70, 0.1)
    .name('vertical fov °')
    .listen()
    .onFinishChange(() => viewer.onCameraChange(viewer.getCameraState()));
  framing.add(lens, 'focal').name('≈ focal (35 mm)').listen().disable();
  framing.add(lens, 'copyCamera').name('Copy camera JSON');
  framing.add(lens, 'resetCamera').name('Reset camera');

  const model = gui.addFolder('Model & material');
  model.add(preset.model, 'rotateYDeg', -180, 180, 1).name('turn °').onChange(changed);
  model.add(preset.material, 'gray', 0, 1, 0.01).onChange(changed);
  model.add(preset.material, 'roughness', 0, 1, 0.01).onChange(changed);
  model.add(preset.material, 'metalness', 0, 1, 0.01).onChange(changed);

  const light = (name: string, spec: LightSpec, max: number) => {
    const f = gui.addFolder(name);
    f.add(spec, 'azimuthDeg', -180, 180, 1).name('azimuth °').onChange(changed);
    f.add(spec, 'elevationDeg', -30, 90, 1).name('elevation °').onChange(changed);
    f.add(spec, 'intensity', 0, max, 0.01).onChange(changed);
    return f;
  };
  const key = light('Key light', preset.key, 8);
  key.add(preset.key, 'shadowRadius', 0, 16, 0.1).name('shadow softness').onChange(changed);
  key.add(preset.key, 'shadowMapSize', [1024, 2048, 4096, 8192]).name('shadow map (viewer)').onChange(changed);
  key.add(preset.key, 'shadowBias', -0.005, 0.005, 0.0001).name('shadow bias').onChange(changed);
  key.add(preset.key, 'shadowNormalBias', 0, 0.05, 0.0005).name('normal bias').onChange(changed);
  light('Fill light', preset.fill, 4).close();
  light('Rim light', preset.rim, 8).close();

  const env = gui.addFolder('Ambient & background');
  env.add(preset.hemi, 'intensity', 0, 2, 0.01).name('hemi intensity').onChange(changed);
  env.add(preset.hemi, 'skyGray', 0, 1, 0.01).name('hemi sky').onChange(changed);
  env.add(preset.hemi, 'groundGray', 0, 1, 0.01).name('hemi ground').onChange(changed);
  env.add(preset, 'background', 0, 1, 0.01).onChange(changed);
  env.add(preset.floor, 'enabled').name('floor shadow').onChange(changed);
  env.add(preset.floor, 'shadowOpacity', 0, 1, 0.01).name('floor opacity').onChange(changed);
  env.close();

  const presets = gui.addFolder('Preset');
  presets
    .add({ copy: () => copyText(JSON.stringify(preset, null, 2)) }, 'copy')
    .name('Copy preset JSON');
  presets
    .add(
      {
        reset: () => {
          assignDeep(preset, DEFAULT_SCENE);
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          changed();
        },
      },
      'reset',
    )
    .name('Reset to defaults');

  return gui;
}

/** Tone curve, dither and tiling for the print path. The live viewer is not affected. */
export function addPrintFolder(
  gui: GUI,
  cfg: RenderConfig,
  actions: { preview: () => void; renderFull: () => void; seamTest: () => void },
) {
  const changed = () => saveStored('render', cfg);
  const f = gui.addFolder('Print render (tone: print only)');
  const t = cfg.tone;
  f.add(actions, 'preview').name(`▶ Print preview (${Math.round(cfg.previewScale * 100)} %)`);
  f.add(actions, 'renderFull').name('▶ Render full resolution');
  f.add(actions, 'seamTest').name('▶ Seam test');
  f.add(t, 'exposureEV', -3, 3, 0.05).name('exposure EV').onChange(changed);
  f.add(t, 'inBlack', 0, 0.5, 0.005).name('levels: in black').onChange(changed);
  f.add(t, 'inWhite', 0.5, 1, 0.005).name('levels: in white').onChange(changed);
  f.add(t, 'gamma', 0.3, 3, 0.01).name('levels: gamma').onChange(changed);
  f.add(t, 'outBlack', 0, 0.5, 0.005).name('out black (0 = 100 % K)').onChange(changed);
  f.add(t, 'outWhite', 0.5, 1, 0.005).name('out white (1 = paper)').onChange(changed);
  f.add(t.dotGain, 'enabled').name('dot-gain compensation').onChange(changed);
  f.add(t.dotGain, 'tvi50', 0, 0.3, 0.005).name('TVI at 50 %').onChange(changed);
  f.add(cfg.dither, 'amplitude', 0, 4, 0.1).name('dither (LSB)').onChange(changed);
  f.add(cfg.tiles, 'cols', 1, 8, 1).name('tiles: columns').onChange(changed);
  f.add(cfg.tiles, 'rows', 1, 8, 1).name('tiles: rows').onChange(changed);
  f.add(cfg, 'msaaSamples', [0, 2, 4, 8]).name('MSAA samples').onChange(changed);
  f.add(cfg, 'printShadowMap', ['auto', 2048, 4096, 8192]).name('shadow map (print)').onChange(changed);
  f.add({ reset: () => resetRender(cfg, gui, changed) }, 'reset').name('Reset print settings');
  return f;
}

/** PDF/X-4 export: file name, metadata, colour model, test line, signature. */
export function addExportFolder(gui: GUI, cfg: ExportConfig, exportPdf: () => void) {
  const changed = () => saveStored('export', cfg);
  const f = gui.addFolder('PDF/X-4 export');
  f.add({ exportPdf }, 'exportPdf').name('▶ Export PDF');
  f.add(cfg, 'filename').name('file name').onFinishChange(changed);
  f.add(cfg, 'title').name('title').onFinishChange(changed);
  f.add(cfg, 'author').name('author (optional)').onFinishChange(changed);
  f.add(cfg, 'colorModel', ['DeviceGray', 'CMYK-K']).name('colour model').onChange(changed);
  f.add(cfg.text, 'enabled').name('test line').onChange(changed);
  f.add(cfg.text, 'content').name('test line text').onFinishChange(changed);
  f.add(cfg.text, 'sizePt', 6, 72, 0.5).name('test line pt').onChange(changed);
  f.add(cfg.signature, 'enabled').name('signature').onChange(changed);
  f.add(cfg.signature, 'widthMm', 20, 190, 1).name('signature width mm').onChange(changed);
  return f;
}

function resetRender(cfg: RenderConfig, gui: GUI, changed: () => void) {
  assignDeep(cfg, DEFAULT_RENDER);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  changed();
}

/** Copies leaf values in place, so controllers bound to nested objects stay valid. */
function assignDeep(target: object, source: object) {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) assignDeep(t[k] as object, v);
    else t[k] = Array.isArray(v) ? [...v] : v;
  }
}
