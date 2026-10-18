// Developer panel (lil-gui ships with three, no extra dependency); shown with ?dev or Shift+D.
// Edits the preset object in place, re-applies it to the studio and persists it. Light
// directions and the camera are also part of the user's shot, so edits to them are reported via
// onShotEdit and the sliders follow changes made in the app panel.

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { DEFAULT_CAMERA } from '../config/camera';
import { EXPORT_STORAGE_KEY, type ExportConfig } from '../config/export';
import { DEFAULT_RENDER, RENDER_STORAGE_KEY, type RenderConfig } from '../config/render';
import { DEFAULT_SCENE, type LightSpec, type ScenePreset } from '../config/scene';
import { copyText, saveStored } from './storage';
import type { Viewer } from './viewer';

/** localStorage key of the studio preset (bumped when its meaning changes, so stale values don't load). */
export const SCENE_STORAGE_KEY = 'scene.v2';

export function buildGui(viewer: Viewer, preset: ScenePreset, hooks: { onShotEdit: () => void }): GUI {
  const studio = viewer.studio;
  const gui = new GUI({ title: 'David · print studio' });
  const changed = () => {
    studio.apply(preset);
    viewer.requestRender();
    saveStored(SCENE_STORAGE_KEY, preset);
  };
  /** Look-only change (tone, ramp, bloom): no re-render, only re-present. */
  const lookChanged = () => {
    viewer.requestPresent();
    saveStored(SCENE_STORAGE_KEY, preset);
  };
  /** Lens or accumulation change: restart the accumulation, scene unchanged. */
  const restart = () => {
    viewer.requestRender();
    saveStored(SCENE_STORAGE_KEY, preset);
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
      hooks.onShotEdit();
    },
  };
  framing
    .add(lens, 'printFovDeg', 5, 70, 0.1)
    .name('vertical fov °')
    .listen()
    .onFinishChange(hooks.onShotEdit);
  framing.add(lens, 'focal').name('≈ focal (35 mm)').listen().disable();
  framing.add(lens, 'copyCamera').name('Copy camera JSON');
  framing.add(lens, 'resetCamera').name('Reset camera');

  const lensF = gui.addFolder('Lens & depth of field');
  const lp = preset.lens;
  lensF.add(lp, 'enabled').name('depth of field').onChange(restart);
  lensF.add(lp, 'fNumber', 0.7, 22, 0.1).name('f-number').onChange(restart);
  lensF.add(lp, 'subjectHeightM', 0.1, 6, 0.01).name('subject height m').onChange(restart);
  lensF.add(lp, 'focusMode', ['surface', 'target']).name('focus on').onChange(restart);
  lensF.add(lp, 'focusOffset', -2, 2, 0.005).name('focus offset').onChange(restart);

  const look = preset.look;
  const toneF = gui.addFolder('Look: exposure & tone curve');
  const t = look.tone;
  toneF.add(t, 'exposureEV', -4, 4, 0.05).name('exposure EV').onChange(lookChanged);
  toneF.add(t, 'pivot', 0.05, 0.95, 0.005).name('18 % grey → tone').onChange(lookChanged);
  toneF.add(t, 'contrast', 0, 0.6, 0.005).name('contrast (tone/stop)').onChange(lookChanged);
  toneF.add(t, 'whiteStops', 0.2, 8, 0.05).name('white point (stops)').onChange(lookChanged);
  toneF.add(t, 'blackStops', -12, -0.5, 0.05).name('black point (stops)').onChange(lookChanged);
  toneF.add(t, 'shoulder', 0, 3, 0.01).name('shoulder hardness').onChange(lookChanged);
  toneF.add(t, 'toe', 0, 3, 0.01).name('toe hardness').onChange(lookChanged);

  const rampF = gui.addFolder('Look: colour ramp');
  const rp = look.ramp;
  rampF.addColor(rp, 'light').name('brightest').onChange(lookChanged);
  rampF.addColor(rp, 'dark').name('darkest').onChange(lookChanged);
  rampF.add(rp, 'tintBias', 0.1, 4, 0.01).name('tint bias').onChange(lookChanged);
  rampF.add(rp.mid, 'enabled').name('mid hue stop').onChange(lookChanged);
  rampF.addColor(rp.mid, 'color').name('mid hue').onChange(lookChanged);
  rampF.add(rp.mid, 'position', 0.05, 0.95, 0.01).name('mid position').onChange(lookChanged);

  const bloomF = gui.addFolder('Look: bloom');
  const b = look.bloom;
  bloomF.add(b, 'enabled').onChange(lookChanged);
  bloomF.add(b, 'intensity', 0, 3, 0.01).onChange(lookChanged);
  bloomF.add(b, 'threshold', 0, 4, 0.01).name('threshold (lum)').onChange(lookChanged);
  bloomF.add(b, 'knee', 0, 2, 0.01).onChange(lookChanged);
  bloomF.add(b, 'radius', 0.005, 0.5, 0.001).name('radius (× height)').onChange(lookChanged);
  bloomF.add(b, 'falloff', 0.2, 2, 0.01).name('wide/narrow ratio').onChange(lookChanged);

  const model = gui.addFolder('Model & marble material');
  model.add(preset.model, 'rotateYDeg', -180, 180, 1).name('turn °').onChange(changed);
  model.add(preset.material, 'gray', 0, 1, 0.01).name('albedo (sRGB)').onChange(changed);
  model.add(preset.material, 'roughness', 0, 1, 0.01).onChange(changed);
  model.add(preset.material, 'metalness', 0, 1, 0.01).onChange(changed);
  model.add(preset.material, 'wrap', 0, 1, 0.01).name('wrap (subsurface)').onChange(changed);

  const light = (name: string, spec: LightSpec, max: number) => {
    const f = gui.addFolder(name);
    // Directions are part of the user's shot: listen() follows the app panel.
    const shotEdit = () => {
      changed();
      hooks.onShotEdit();
    };
    f.add(spec, 'azimuthDeg', -180, 180, 1).name('azimuth ° (shot)').listen().onChange(shotEdit);
    f.add(spec, 'elevationDeg', -30, 90, 1).name('elevation ° (shot)').listen().onChange(shotEdit);
    f.add(spec, 'intensity', 0, max, 0.01).onChange(changed);
    return f;
  };
  const key = light('Key light', preset.key, 12);
  key.add(preset.key, 'areaDeg', 0, 40, 0.5).name('light size °').onChange(changed);
  key.add(preset.key, 'shadowRadius', 0, 16, 0.1).name('shadow filter').onChange(changed);
  key.add(preset.key, 'shadowMapSize', [1024, 2048, 4096, 8192]).name('shadow map (viewer)').onChange(changed);
  key.add(preset.key, 'shadowBias', -0.005, 0.005, 0.0001).name('shadow bias').onChange(changed);
  key.add(preset.key, 'shadowNormalBias', 0, 0.05, 0.0005).name('normal bias').onChange(changed);
  light('Fill light', preset.fill, 6).close();
  light('Rim light', preset.rim, 12).close();

  const env = gui.addFolder('Dome, ambient & background');
  env.add(preset.dome, 'sky', 0, 8, 0.01).name('dome sky').onChange(changed);
  env.add(preset.dome, 'ground', 0, 4, 0.01).name('dome ground bounce').onChange(changed);
  env.add(preset.dome, 'shadowRadius', 0, 16, 0.1).name('dome shadow filter').onChange(changed);
  env.add(preset.dome, 'shadowMapSize', [512, 1024, 2048, 4096]).name('dome shadow map').onChange(changed);
  env.add(preset.dome, 'shadowNormalBias', 0, 0.05, 0.0005).name('dome normal bias').onChange(changed);
  env.add(preset.environment, 'intensity', 0, 2, 0.005).name('environment sheen').onChange(changed);
  env.add(preset.environment, 'rotationDeg', -180, 180, 1).name('environment turn °').onChange(changed);
  env.add(preset, 'backgroundStops', -4, 6, 0.05).name('background (stops)').onChange(changed);
  env.add(preset.floor, 'enabled').name('floor shadow').onChange(changed);
  env.add(preset.floor, 'shadowOpacity', 0, 1, 0.01).name('floor opacity').onChange(changed);
  env.close();

  const acc = gui.addFolder('Viewer accumulation');
  acc.add(preset.viewer, 'passes', 1, 256, 1).name('passes at rest').onChange(restart);
  acc.add(preset.viewer, 'passesPerFrame', 1, 8, 1).name('passes per frame').onChange(restart);
  acc.close();

  const app = gui.addFolder('App UI');
  app.add(preset.app, 'dollyZoom').name('focal keeps subject size').onChange(changed);
  app.close();

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
          hooks.onShotEdit();
        },
      },
      'reset',
    )
    .name('Reset to defaults');

  return gui;
}

/** Quality, tiling and dither of the print path. The look itself is shared with the viewer. */
export function addPrintFolder(
  gui: GUI,
  cfg: RenderConfig,
  actions: { preview: () => void; renderFull: () => void; seamTest: () => void },
) {
  const changed = () => saveStored(RENDER_STORAGE_KEY, cfg);
  const f = gui.addFolder('Print render');
  f.add(actions, 'preview').name(`▶ Print preview (${Math.round(cfg.previewScale * 100)} %)`);
  f.add(actions, 'renderFull').name('▶ Render full resolution');
  f.add(actions, 'seamTest').name('▶ Seam test');
  f.add(cfg, 'passes', 1, 256, 1).name('passes (print)').onChange(changed);
  f.add(cfg, 'bloomBaseLongSide', [512, 1024, 2048, 4096]).name('bloom resolution').onChange(changed);
  f.add(cfg.dither, 'amplitude', 0, 4, 0.1).name('dither (tone steps)').onChange(changed);
  f.add(cfg.tiles, 'cols', 1, 8, 1).name('tiles: columns').onChange(changed);
  f.add(cfg.tiles, 'rows', 1, 8, 1).name('tiles: rows').onChange(changed);
  f.add(cfg, 'msaaSamples', [0, 2, 4, 8]).name('MSAA samples').onChange(changed);
  f.add(cfg, 'printShadowMap', ['auto', 2048, 4096, 8192]).name('shadow map (print)').onChange(changed);
  f.add({ reset: () => resetRender(cfg, gui, changed) }, 'reset').name('Reset print settings');
  return f;
}

/** PDF/X-4 export: file name, metadata, colour model, test line, signature. */
export function addExportFolder(gui: GUI, cfg: ExportConfig, exportPdf: () => void) {
  const changed = () => saveStored(EXPORT_STORAGE_KEY, cfg);
  const f = gui.addFolder('PDF/X-4 export');
  f.add({ exportPdf }, 'exportPdf').name('▶ Export PDF');
  f.add(cfg, 'filename').name('file name').onFinishChange(changed);
  f.add(cfg, 'title').name('title').onFinishChange(changed);
  f.add(cfg, 'author').name('author (optional)').onFinishChange(changed);
  f.add(cfg, 'colorModel', ['CMYK', 'DeviceGray', 'CMYK-K']).name('colour model').onChange(changed);
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
