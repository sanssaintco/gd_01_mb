// Studio preset: model placement, material, lights, background.
// Tweak live in the GUI, then "Copy preset JSON" and paste it over DEFAULT_SCENE.
//
// Rule for anything added here: no screen-space effects (SSAO, bloom, screen-space DOF).
// They read neighbouring pixels and therefore produce seams at tile borders.

export type UpAxis = 'auto' | 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

export interface LightSpec {
  /** Degrees around the vertical axis; 0 = in front of the model (+Z), 90 = from the right (+X). */
  azimuthDeg: number;
  /** Degrees above the horizon. */
  elevationDeg: number;
  intensity: number;
}

export interface ScenePreset {
  model: {
    upAxis: UpAxis;
    /** Turn the statue around its vertical axis. */
    rotateYDeg: number;
    /** Normalized height in scene units. */
    height: number;
  };
  material: { gray: number; roughness: number; metalness: number };
  key: LightSpec & {
    shadowMapSize: number;
    /** Penumbra softness (shadow-map filter radius). */
    shadowRadius: number;
    shadowBias: number;
    shadowNormalBias: number;
  };
  fill: LightSpec;
  rim: LightSpec;
  hemi: { intensity: number; skyGray: number; groundGray: number };
  /** Background gray, 0 = black, 1 = white (display-referred). */
  background: number;
  floor: { enabled: boolean; shadowOpacity: number };
}

export const DEFAULT_SCENE: ScenePreset = {
  model: { upAxis: 'auto', rotateYDeg: 0, height: 2 },
  material: { gray: 0.8, roughness: 0.6, metalness: 0 },
  key: {
    azimuthDeg: -40,
    elevationDeg: 40,
    intensity: 2.6,
    shadowMapSize: 4096,
    shadowRadius: 4,
    shadowBias: -0.0002,
    shadowNormalBias: 0.004,
  },
  fill: { azimuthDeg: 55, elevationDeg: 15, intensity: 0.5 },
  rim: { azimuthDeg: 160, elevationDeg: 30, intensity: 1.8 },
  hemi: { intensity: 0.35, skyGray: 1.0, groundGray: 0.25 },
  background: 0.42,
  floor: { enabled: true, shadowOpacity: 0.35 },
};
