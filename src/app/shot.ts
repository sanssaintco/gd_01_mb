// Owns the user's shot: applies it to the viewer and the studio, persists it under its own
// storage key (separate from the developer's preset) and notifies the panels when it changes,
// so the app panel and the dev panel stay in sync.

import { type LightName, LIGHT_NAMES, type Shot, defaultShot } from '../config/shot';
import { saveStored } from '../viewer/storage';
import type { Viewer } from '../viewer/viewer';

export const SHOT_STORAGE_KEY = 'shot.v1';

export class ShotController {
  private listeners = new Set<() => void>();

  constructor(private viewer: Viewer) {}

  /** Current shot, read from the live viewer and preset. */
  get(): Shot {
    const p = this.viewer.preset;
    const lights = {} as Shot['lights'];
    for (const n of LIGHT_NAMES) lights[n] = { azimuthDeg: p[n].azimuthDeg, elevationDeg: p[n].elevationDeg };
    return { camera: this.viewer.getCameraState(), lights };
  }

  /** Applies a whole shot (startup, reset). */
  set(shot: Shot) {
    const p = this.viewer.preset;
    for (const n of LIGHT_NAMES) Object.assign(p[n], shot.lights[n]);
    this.viewer.studio.apply(p);
    this.viewer.setCameraState(shot.camera);
    this.changed();
  }

  setFocal(focalMm: number) {
    this.viewer.setFocal(focalMm, this.viewer.preset.app.dollyZoom);
    this.changed();
  }

  setLight(name: LightName, field: 'azimuthDeg' | 'elevationDeg', value: number) {
    this.viewer.preset[name][field] = value;
    this.viewer.studio.apply(this.viewer.preset);
    this.viewer.requestRender();
    this.changed();
  }

  reset() {
    this.set(defaultShot());
  }

  /** Persists the shot and tells the panels; also call after edits made elsewhere (orbit, dev GUI). */
  changed() {
    saveStored(SHOT_STORAGE_KEY, this.get());
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }
}

/** Copies a shot's light directions into a preset (before the studio is created). */
export function applyShotLights(preset: { [K in LightName]: { azimuthDeg: number; elevationDeg: number } }, shot: Shot) {
  for (const n of LIGHT_NAMES) Object.assign(preset[n], shot.lights[n]);
}
