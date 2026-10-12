// Framing of the printed image. This is the *print* camera: its frustum is exactly the crop
// rectangle (media box incl. bleed). The live viewer widens its own fov around it.
// Frame the shot in the viewer, "Copy camera JSON", and paste it over DEFAULT_CAMERA.

export type Vec3 = [number, number, number];

export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Vertical field of view of the media box, in degrees. */
  printFovDeg: number;
}

export const DEFAULT_CAMERA: CameraState = {
  position: [0, 0.1, 4.6],
  target: [0, 0, 0],
  up: [0, 1, 0],
  printFovDeg: 30,
};
