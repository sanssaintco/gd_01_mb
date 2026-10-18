// Live viewer: renderer, OrbitControls, crop overlay, progressive accumulation. The stored framing
// is the *print* camera (CameraState); the on-screen camera only widens the fov so the overlay
// rectangle matches it:
//   tan(viewFov/2) = tan(printFov/2) / k,   k = overlayHeight / canvasHeight
//
// While the view moves, every frame is a single sharp pass. At rest the viewer keeps adding
// jittered passes (anti-aliasing, depth of field, key-light area, dome directions) until
// preset.viewer.passes.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraState, Vec3 } from '../config/camera';
import type { PageGeometry } from '../config/page';
import type { ScenePreset } from '../config/scene';
import { SHOT_LIMITS } from '../config/shot';
import { type LensState, applyPass, apertureRadius, focalFromFov, fovFromFocal, passAt } from '../render/passes';
import { CropOverlay, type OverlayRect, computeOverlayRect } from './cropOverlay';
import { LookDisplay } from './display';
import type { Studio } from './scene';

const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera();
  readonly controls: OrbitControls;
  readonly overlay: CropOverlay;
  printFovDeg: number;
  /** Called after the user changes the framing (end of a drag/zoom). */
  onCameraChange: (s: CameraState) => void = () => {};
  /** Called whenever passes were added: (accumulated, target). */
  onAccumulate: (n: number, total: number) => void = () => {};

  private display: LookDisplay;
  private passCamera = new THREE.PerspectiveCamera();
  private raycaster = new THREE.Raycaster();
  rect: OverlayRect = { left: 0, top: 0, width: 1, height: 1 };
  private k = 1;
  private dirty = true;
  private presentDirty = false;
  private paused = false;
  private focus = { key: '', distance: 1 };

  constructor(
    private container: HTMLElement,
    readonly studio: Studio,
    readonly page: PageGeometry,
    state: CameraState,
    readonly preset: ScenePreset,
  ) {
    // No canvas MSAA: the scene is rendered into an MSAA float target, the canvas only gets the
    // final full-screen pass.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.append(this.renderer.domElement);
    studio.initEnvironment(this.renderer);
    this.display = new LookDisplay(this.renderer);

    this.overlay = new CropOverlay(container, page);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = SHOT_LIMITS.distance.min;
    this.controls.maxDistance = SHOT_LIMITS.distance.max;
    this.controls.addEventListener('end', () => this.onCameraChange(this.getCameraState()));

    this.printFovDeg = state.printFovDeg;
    this.setCameraState(state);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  getCameraState(): CameraState {
    const r = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];
    return {
      position: r(this.camera.position),
      target: r(this.controls.target),
      up: r(this.camera.up),
      printFovDeg: round(this.printFovDeg),
    };
  }

  setCameraState(s: CameraState) {
    this.camera.position.set(...s.position);
    this.camera.up.set(...s.up);
    this.controls.target.set(...s.target);
    this.printFovDeg = s.printFovDeg;
    this.updateFov();
    this.controls.update();
    this.requestRender();
  }

  setPrintFov(fovDeg: number) {
    this.printFovDeg = fovDeg;
    this.updateFov();
    this.requestRender();
  }

  /** 35 mm-equivalent focal length of the print camera. */
  get focalMm(): number {
    return focalFromFov(this.printFovDeg);
  }

  /**
   * Changes the focal length. With `dolly`, the camera moves along its line of sight so the
   * subject keeps its size in the frame and only the perspective changes (like swapping lenses
   * and stepping back); otherwise it zooms in place.
   */
  setFocal(focalMm: number, dolly: boolean) {
    if (dolly) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const d = THREE.MathUtils.clamp(
        offset.length() * (focalMm / this.focalMm),
        SHOT_LIMITS.distance.min,
        SHOT_LIMITS.distance.max,
      );
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), d);
    }
    this.printFovDeg = fovFromFocal(focalMm);
    this.updateFov();
    this.controls.update();
    this.requestRender();
  }

  /** Print camera with the media aspect, as used by the tiled renderer. */
  makePrintCamera(): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(this.printFovDeg, this.page.aspect, this.camera.near, this.camera.far);
    c.position.copy(this.camera.position);
    c.up.copy(this.camera.up);
    c.lookAt(this.controls.target);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  }

  /** Thin-lens state for the current framing: aperture from the preset, focus by autofocus. */
  lensState(): LensState {
    return {
      apertureRadius: apertureRadius(this.preset.lens, this.printFovDeg, this.preset.model.height),
      focusDistance: this.focusDistance(),
    };
  }

  /** The scene changed: restart the accumulation. */
  requestRender() {
    this.dirty = true;
  }

  /** Only the look (tone, ramp, bloom) changed: re-present the accumulation as is. */
  requestPresent() {
    this.presentDirty = true;
  }

  get accumulated() {
    return this.display.count;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.requestRender();
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.display.setSize(buf.x, buf.y);
    this.rect = computeOverlayRect(w, h, this.page.aspect);
    this.overlay.layout(this.rect);
    this.k = this.rect.height / h;
    this.camera.aspect = w / h;
    this.updateFov();
    this.requestRender();
  }

  private updateFov() {
    this.camera.fov = deg(2 * Math.atan(Math.tan(rad(this.printFovDeg) / 2) / this.k));
    // Tight clip planes around the model keep depth precision high.
    const d = this.camera.position.distanceTo(this.controls.target);
    const r = this.studio.radius;
    this.camera.near = Math.max(0.05, 0.5 * (d - 1.5 * r));
    this.camera.far = d + 7 * r; // floor extends 6 r from the center
    this.camera.updateProjectionMatrix();
  }

  private tick() {
    if (this.paused) return;
    const moved = this.controls.update();
    if (moved) this.updateFov();
    if (moved || this.dirty) {
      this.display.reset();
      this.dirty = false;
    }
    const total = moved ? 1 : Math.max(1, Math.floor(this.preset.viewer.passes));
    const perFrame = Math.max(1, Math.floor(this.preset.viewer.passesPerFrame));
    let added = 0;
    while (this.display.count < total && added < perFrame) {
      this.renderPass(this.display.count);
      added++;
    }
    if (added) {
      // Leave the studio in its nominal state for anyone else rendering it (print jobs).
      if (this.preset.key.areaDeg > 0) this.studio.setKeyJitter(0, 0);
      this.studio.setDomeSample(-1, -1);
    }
    if (added || this.presentDirty) {
      this.present();
      this.presentDirty = false;
      if (added) this.onAccumulate(this.display.count, total);
    }
  }

  private renderPass(i: number) {
    const pass = passAt(i);
    if (this.preset.key.areaDeg > 0) this.studio.setKeyJitter(pass.lightU, pass.lightV);
    this.studio.setDomeSample(pass.domeU, pass.domeV);
    const cam = this.passCamera;
    cam.copy(this.camera);
    cam.updateMatrixWorld();
    const lens = i === 0 ? { apertureRadius: 0, focusDistance: 1 } : this.lensState();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    applyPass(cam, pass, lens, { widthPx: buf.x, heightPx: buf.y });
    this.display.addPass(this.studio.scene, cam);
  }

  private present() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const r = this.rect;
    this.display.present(this.preset.look, {
      x: r.left / w,
      y: 1 - (r.top + r.height) / h,
      w: r.width / w,
      h: r.height / h,
      heightPx: r.height * this.renderer.getPixelRatio(),
    });
  }

  /**
   * Distance to the plane of sharp focus. 'surface': the first hit of the view axis on the model
   * (falls back to the orbit target); cached until the framing or the lens settings change.
   */
  private focusDistance(): number {
    const lens = this.preset.lens;
    const key = JSON.stringify([this.getCameraState(), lens.focusMode, this.preset.model.rotateYDeg]);
    if (key !== this.focus.key) {
      let d = this.camera.position.distanceTo(this.controls.target);
      if (lens.focusMode === 'surface') {
        this.studio.mesh.updateMatrixWorld();
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        const hit = this.raycaster.intersectObject(this.studio.mesh, false)[0];
        if (hit) d = hit.distance;
      }
      this.focus = { key, distance: d };
    }
    return Math.max(0.01, this.focus.distance + lens.focusOffset);
  }
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
