// Live viewer: renderer, OrbitControls, crop overlay. The stored framing is the *print* camera
// (CameraState); the on-screen camera only widens the fov so the overlay rectangle matches it:
//   tan(viewFov/2) = tan(printFov/2) / k,   k = overlayHeight / canvasHeight

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraState, Vec3 } from '../config/camera';
import type { PageGeometry } from '../config/page';
import { CropOverlay, computeOverlayRect } from './cropOverlay';
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

  private k = 1;
  private dirty = true;
  private paused = false;

  constructor(
    private container: HTMLElement,
    readonly studio: Studio,
    readonly page: PageGeometry,
    state: CameraState,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.append(this.renderer.domElement);

    this.overlay = new CropOverlay(container, page);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
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

  requestRender() {
    this.dirty = true;
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
    const rect = computeOverlayRect(w, h, this.page.aspect);
    this.overlay.layout(rect);
    this.k = rect.height / h;
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
      this.renderer.render(this.studio.scene, this.camera);
      this.dirty = false;
    }
  }
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
