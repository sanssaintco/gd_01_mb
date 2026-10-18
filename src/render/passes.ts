// Accumulation passes: every pass renders the scene once with a sub-pixel shift (anti-aliasing),
// a point on the lens aperture (depth of field), a point on the key light's disk (soft area
// shadows) and one direction of the dome light (soft sky light with occlusion); the average of
// N passes is the image. All of it is geometric, i.e. tile-safe.
//
// The sequence is deterministic (low-discrepancy, fixed order), so a tiled render and a
// one-piece render of the same N passes are identical, and pass 0 is always the identity.

import * as THREE from 'three';
import type { LensConfig } from '../config/scene';

/**
 * One accumulation pass. Sub-pixel shift in pixels (−0.5..0.5), lens and light points on the unit
 * disk, dome sample in the unit square (−1 = identity pass: no dome sample, see Studio.setDomeSample).
 */
export interface Pass {
  subpixelX: number;
  subpixelY: number;
  lensU: number;
  lensV: number;
  lightU: number;
  lightV: number;
  domeU: number;
  domeV: number;
  weight: number;
}

export const IDENTITY_PASS: Pass = { subpixelX: 0, subpixelY: 0, lensU: 0, lensV: 0, lightU: 0, lightV: 0, domeU: -1, domeV: -1, weight: 1 };

/** Pass i of the sequence (i = 0 is the identity). */
export function passAt(i: number): Pass {
  if (i === 0) return IDENTITY_PASS;
  const [lu, lv] = concentricDisk(halton(i, 2), halton(i, 3));
  const [gu, gv] = concentricDisk(halton(i, 5), halton(i, 7));
  // R2 sequence for the pixel jitter (decorrelated from the Halton bases above).
  const a1 = 0.7548776662466927;
  const a2 = 0.5698402909980532;
  return {
    subpixelX: ((0.5 + a1 * i) % 1) - 0.5,
    subpixelY: ((0.5 + a2 * i) % 1) - 0.5,
    lensU: lu,
    lensV: lv,
    lightU: gu,
    lightV: gv,
    domeU: halton(i, 11),
    domeV: halton(i, 13),
    weight: 1,
  };
}

export function makePasses(n: number): Pass[] {
  return Array.from({ length: Math.max(1, Math.floor(n)) }, (_, i) => passAt(i));
}

function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Shirley–Chiu concentric mapping of the unit square onto the unit disk (area-preserving). */
function concentricDisk(u: number, v: number): [number, number] {
  const a = 2 * u - 1;
  const b = 2 * v - 1;
  if (a === 0 && b === 0) return [0, 0];
  let r: number;
  let phi: number;
  if (Math.abs(a) > Math.abs(b)) {
    r = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

// ---------------------------------------------------------------------------------------------
// Thin lens.

/** 35 mm-equivalent focal length for a vertical fov (portrait: the 36 mm side is vertical). */
export const focalFromFov = (fovDeg: number) => 18 / Math.tan((fovDeg * Math.PI) / 360);
export const fovFromFocal = (focalMm: number) => (360 / Math.PI) * Math.atan(18 / focalMm);

export interface LensState {
  /** Aperture radius in scene units. */
  apertureRadius: number;
  /** Distance from the camera to the plane of sharp focus, in scene units (along the view axis). */
  focusDistance: number;
}

/**
 * Aperture from photographic settings: diameter = focal / f-number, converted to scene units via
 * the subject's assumed real height (the model is `modelHeight` units tall). A smaller subject
 * (a statuette on a table) gives a shallower depth of field at the same framing.
 */
export function apertureRadius(lens: LensConfig, printFovDeg: number, modelHeight: number): number {
  if (!lens.enabled || lens.fNumber <= 0) return 0;
  const diameterM = focalFromFov(printFovDeg) / lens.fNumber / 1000;
  return 0.5 * diameterM * (modelHeight / lens.subjectHeightM);
}

/**
 * Moves `cam` to the pass's point on the aperture disk and skews its frustum so that the focus
 * plane stays registered. Call after updateProjectionMatrix() (and after setViewOffset). With
 * `pixel`, also applies the sub-pixel shift for a render target of that size (the tiler shifts
 * via setViewOffset instead).
 */
export function applyPass(
  cam: THREE.PerspectiveCamera,
  pass: Pass,
  lens: LensState,
  pixel?: { widthPx: number; heightPx: number },
) {
  const e = cam.projectionMatrix.elements;
  let dx = 0; // NDC shift, applied to every depth
  let dy = 0;
  if (lens.apertureRadius > 0 && (pass.lensU !== 0 || pass.lensV !== 0)) {
    const ox = pass.lensU * lens.apertureRadius;
    const oy = pass.lensV * lens.apertureRadius;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    cam.position.addScaledVector(right, ox).addScaledVector(up, oy);
    cam.updateMatrixWorld();
    // The move shifts a point at depth d by −P00·ox/d in NDC; cancel that at the focus distance.
    dx += (e[0] * ox) / lens.focusDistance;
    dy += (e[5] * oy) / lens.focusDistance;
  }
  if (pixel) {
    dx += (2 * pass.subpixelX) / pixel.widthPx;
    dy += (2 * pass.subpixelY) / pixel.heightPx;
  }
  if (dx !== 0 || dy !== 0) {
    // ndc = (P·x) / −z: the third column times z/−z adds a constant −P[col2] to NDC.
    e[8] -= dx;
    e[9] -= dy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
}
