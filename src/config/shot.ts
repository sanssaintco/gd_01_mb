// The "shot": everything the app user controls. Framing (print camera incl. focal length) and
// the directions of the key, fill and rim lights. Everything else (light intensities, look,
// lens, material…) is the developer's preset (config/scene.ts) and is not part of the shot.

import { type CameraState, DEFAULT_CAMERA } from './camera';
import { DEFAULT_SCENE, type LightSpec, type ScenePreset } from './scene';

export type LightName = 'key' | 'fill' | 'rim';
export const LIGHT_NAMES: LightName[] = ['key', 'fill', 'rim'];

export type LightDirection = Pick<LightSpec, 'azimuthDeg' | 'elevationDeg'>;

export interface Shot {
  camera: CameraState;
  lights: Record<LightName, LightDirection>;
}

/** Ranges of the app's controls. */
export const SHOT_LIMITS = {
  focalMm: { min: 24, max: 135 },
  azimuthDeg: { min: -180, max: 180 },
  elevationDeg: { min: -30, max: 90 },
  /** Orbit distance from the target, scene units (the statue is 2 units tall). */
  distance: { min: 0.4, max: 30 },
};

/** The default shot: the code defaults for camera and light directions. */
export function defaultShot(scene: ScenePreset = DEFAULT_SCENE): Shot {
  const dir = (s: LightSpec): LightDirection => ({ azimuthDeg: s.azimuthDeg, elevationDeg: s.elevationDeg });
  return {
    camera: structuredClone(DEFAULT_CAMERA),
    lights: { key: dir(scene.key), fill: dir(scene.fill), rim: dir(scene.rim) },
  };
}
