// Studio preset: model placement, material, lights, environment, background, lens and look.
// Tweak live in the dev GUI (?dev), then "Copy preset JSON" and paste it over DEFAULT_SCENE.
//
// Rule for anything added here: no neighbourhood effects per tile. Depth of field, anti-aliasing
// and the key light's area are accumulation passes (render/passes.ts); bloom runs on the whole
// accumulated frame (render/bloom.ts). Anything that reads neighbouring pixels inside a tile
// would produce seams at tile borders.

import { DEFAULT_LOOK, type LookConfig } from '../render/look';

export type UpAxis = 'auto' | 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

export interface LightSpec {
  /** Degrees around the vertical axis; 0 = in front of the model (+Z), 90 = from the right (+X). */
  azimuthDeg: number;
  /** Degrees above the horizon. */
  elevationDeg: number;
  intensity: number;
}

export interface LensConfig {
  enabled: boolean;
  /** Aperture as a photographic f-number (smaller = shallower depth of field). */
  fNumber: number;
  /**
   * Real height the statue is assumed to have, in metres. Sets the scale for the aperture:
   * 5.17 is the real David; a smaller value photographs him like a statuette (shallower DOF).
   */
  subjectHeightM: number;
  /** 'surface': focus on the first surface along the view axis; 'target': on the orbit target. */
  focusMode: 'surface' | 'target';
  /** Added to the focus distance, in scene units (+ = further away). */
  focusOffset: number;
}

export interface ScenePreset {
  model: {
    upAxis: UpAxis;
    /** Turn the statue around its vertical axis. */
    rotateYDeg: number;
    /** Normalized height in scene units. */
    height: number;
  };
  material: {
    /** Albedo, display-referred (sRGB) grey. */
    gray: number;
    roughness: number;
    metalness: number;
    /** Wrap lighting: lets direct light reach past the terminator, a cheap marble subsurface. */
    wrap: number;
  };
  key: LightSpec & {
    /** Angular diameter of the key light (soft area shadows via accumulation); 0 = point-like sun. */
    areaDeg: number;
    shadowMapSize: number;
    /** Per-pass penumbra smoothing (shadow-map filter radius). */
    shadowRadius: number;
    shadowBias: number;
    shadowNormalBias: number;
  };
  fill: LightSpec;
  rim: LightSpec;
  /**
   * Dome light: soft light from the whole sphere WITH occlusion (crevices go dark). Each
   * accumulation pass adds one shadowed directional light from a stratified direction; sky =
   * upper hemisphere (studio ceiling, softboxes), ground = lower (bounce from a white floor).
   */
  dome: { sky: number; ground: number; shadowMapSize: number; shadowRadius: number; shadowNormalBias: number };
  /** Image-based light (three's RoomEnvironment). Unoccluded, so keep it low: specular sheen only. */
  environment: { intensity: number; rotationDeg: number };
  /** Background luminance in stops over an 18 % grey (scene-linear, before exposure). */
  backgroundStops: number;
  floor: { enabled: boolean; shadowOpacity: number };
  lens: LensConfig;
  look: LookConfig;
  /** Live viewer: accumulation passes when the view is at rest, and how many to add per frame. */
  viewer: { passes: number; passesPerFrame: number };
  /** App UI behaviour. dollyZoom: the focal-length slider keeps David's size in frame. */
  app: { dollyZoom: boolean };
}

export const DEFAULT_SCENE: ScenePreset = {
  model: { upAxis: 'auto', rotateYDeg: 0, height: 2 },
  material: { gray: 0.86, roughness: 0.5, metalness: 0, wrap: 0 },
  key: {
    azimuthDeg: -78,
    elevationDeg: 48,
    intensity: 2,
    areaDeg: 8,
    shadowMapSize: 4096,
    shadowRadius: 2,
    shadowBias: -0.0002,
    shadowNormalBias: 0.004,
  },
  fill: { azimuthDeg: 55, elevationDeg: 15, intensity: 0.05 },
  rim: { azimuthDeg: 160, elevationDeg: 30, intensity: 0.6 },
  dome: { sky: 0.4, ground: 0.15, shadowMapSize: 2048, shadowRadius: 3, shadowNormalBias: 0.01 },
  environment: { intensity: 0.004, rotationDeg: 0 },
  backgroundStops: 2.6,
  floor: { enabled: true, shadowOpacity: 0.25 },
  lens: { enabled: true, fNumber: 2.8, subjectHeightM: 0.6, focusMode: 'surface', focusOffset: 0 },
  look: DEFAULT_LOOK,
  viewer: { passes: 64, passesPerFrame: 1 },
  app: { dollyZoom: true },
};
