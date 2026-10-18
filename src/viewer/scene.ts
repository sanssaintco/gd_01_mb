// The studio: model mesh, marble material, key/fill/rim lights, a shadowed dome light (sampled
// one direction per accumulation pass), faint image-based sheen, soft shadows, optional
// shadow-catcher floor, HDR background. Used by the live viewer and the
// tiled print renderer, so both see exactly the same scene.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LightSpec, ScenePreset } from '../config/scene';
import { patchMaterialForMarble, setMarbleWrap } from '../render/marble';
import { patchMaterialForTiling } from '../render/tileNoise';

const LIGHT_DISTANCE = 10;
const MID_GREY = 0.18;

export interface Studio {
  scene: THREE.Scene;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  /** One direction of the dome per pass (shadowed). */
  dome: THREE.DirectionalLight;
  /** Unshadowed stand-in for the dome in the identity pass (while the view moves). */
  hemi: THREE.HemisphereLight;
  floor: THREE.Mesh;
  /** Bounding sphere radius of the normalized model. */
  radius: number;
  apply(preset: ScenePreset): void;
  /** Builds the image-based ambient light (needs the renderer for the PMREM). */
  initEnvironment(renderer: THREE.WebGLRenderer): void;
  /**
   * Moves the key light to a point (u, v) on its disk (unit-disk coordinates, see
   * ScenePreset.key.areaDeg). (0, 0) is the nominal direction. Accumulation passes call this.
   */
  setKeyJitter(u: number, v: number): void;
  /**
   * Points the dome light at sample (u, v) of the unit square (uniform on the sphere; upper half
   * = sky, lower half = ground bounce). u < 0: identity pass, the unshadowed hemisphere stand-in.
   */
  setDomeSample(u: number, v: number): void;
  /**
   * Key-light shadow-map resolution. Pure quality setting: the filter radius is scaled with it,
   * so the penumbra keeps its size in the scene (the preset's softness is defined at 4096).
   */
  setShadowMapSize(size: number): void;
  readonly shadowMapSize: number;
}

/** Map size at which the preset's shadowRadius (softness, in texels) is defined. */
const SOFTNESS_REFERENCE_MAP = 4096;

const gray = (v: number) => new THREE.Color().setRGB(v, v, v, THREE.SRGBColorSpace);

/** Unit vector towards a light at (azimuth, elevation). */
function lightDirection(spec: LightSpec): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(spec.azimuthDeg);
  const el = THREE.MathUtils.degToRad(spec.elevationDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

/** Tilts `dir` by (u, v) × the disk's angular radius (tangent plane, then renormalized). */
function jitterDirection(dir: THREE.Vector3, areaDeg: number, u: number, v: number): THREE.Vector3 {
  if (areaDeg <= 0 || (u === 0 && v === 0)) return dir;
  const r = Math.tan(THREE.MathUtils.degToRad(areaDeg / 2));
  const helper = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(helper, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1);
  return dir.clone().addScaledVector(t1, r * u).addScaledVector(t2, r * v).normalize();
}

function placeLight(light: THREE.DirectionalLight, spec: LightSpec, dir = lightDirection(spec)) {
  light.position.copy(dir).multiplyScalar(LIGHT_DISTANCE);
  light.intensity = spec.intensity;
}

export function createStudio(geometry: THREE.BufferGeometry, preset: ScenePreset): Studio {
  const scene = new THREE.Scene();

  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const radius = geometry.boundingSphere!.radius;
  const minY = geometry.boundingBox!.min.y;

  const key = new THREE.DirectionalLight(0xffffff);
  key.castShadow = true;
  const fill = new THREE.DirectionalLight(0xffffff);
  const rim = new THREE.DirectionalLight(0xffffff);
  const dome = new THREE.DirectionalLight(0xffffff);
  dome.castShadow = true;
  const hemi = new THREE.HemisphereLight();
  scene.add(key, fill, rim, dome, hemi);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 12, radius * 12), new THREE.ShadowMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = minY;
  floor.receiveShadow = true;
  scene.add(floor);

  patchMaterialForMarble(material);
  for (const m of [material, floor.material as THREE.Material]) patchMaterialForTiling(m);

  let current = preset;
  let softness = preset.key.shadowRadius;
  const setShadowMapSize = (size: number) => {
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    key.shadow.radius = (softness * size) / SOFTNESS_REFERENCE_MAP;
    key.shadow.needsUpdate = true;
  };

  const setKeyJitter = (u: number, v: number) => {
    placeLight(key, current.key, jitterDirection(lightDirection(current.key), current.key.areaDeg, u, v));
    fitShadowCamera(key, mesh, minY, current.floor.enabled);
    key.shadow.needsUpdate = true;
  };

  const setDomeSample = (u: number, v: number) => {
    const d = current.dome;
    if (u < 0) {
      // A uniform sphere of directional lights with intensity I gives an up-facing surface I/4.
      dome.intensity = 0;
      hemi.intensity = 1;
      hemi.color.setRGB(d.sky / 4, d.sky / 4, d.sky / 4);
      hemi.groundColor.setRGB(d.ground / 4, d.ground / 4, d.ground / 4);
      return;
    }
    hemi.intensity = 0;
    const y = 1 - 2 * u;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = 2 * Math.PI * v;
    dome.position.set(r * Math.cos(phi), y, r * Math.sin(phi)).multiplyScalar(LIGHT_DISTANCE);
    dome.intensity = y >= 0 ? d.sky : d.ground;
    fitShadowCamera(dome, mesh, minY, current.floor.enabled);
    dome.shadow.needsUpdate = true;
  };

  const studio: Studio = {
    scene,
    mesh,
    material,
    key,
    fill,
    rim,
    dome,
    hemi,
    floor,
    radius,
    setShadowMapSize,
    setKeyJitter,
    setDomeSample,
    get shadowMapSize() {
      return key.shadow.mapSize.x;
    },
    initEnvironment(renderer) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    },
    apply(p: ScenePreset) {
      current = p;
      const bg = MID_GREY * 2 ** p.backgroundStops;
      scene.background = new THREE.Color(bg, bg, bg); // linear working space, may exceed 1
      scene.environmentIntensity = p.environment.intensity;
      scene.environmentRotation.set(0, THREE.MathUtils.degToRad(p.environment.rotationDeg), 0);
      mesh.rotation.y = THREE.MathUtils.degToRad(p.model.rotateYDeg);
      material.color = gray(p.material.gray);
      material.roughness = p.material.roughness;
      material.metalness = p.material.metalness;
      setMarbleWrap(p.material.wrap);

      placeLight(fill, p.fill);
      placeLight(rim, p.rim);
      softness = p.key.shadowRadius;
      setShadowMapSize(p.key.shadowMapSize);
      key.shadow.bias = p.key.shadowBias;
      key.shadow.normalBias = p.key.shadowNormalBias;
      setKeyJitter(0, 0);

      const ds = p.dome.shadowMapSize;
      if (dome.shadow.mapSize.x !== ds) {
        dome.shadow.mapSize.set(ds, ds);
        dome.shadow.map?.dispose();
        dome.shadow.map = null;
      }
      dome.shadow.radius = p.dome.shadowRadius;
      dome.shadow.normalBias = p.dome.shadowNormalBias;
      dome.shadow.bias = -0.0005;
      setDomeSample(-1, -1);

      floor.visible = p.floor.enabled;
      (floor.material as THREE.ShadowMaterial).opacity = p.floor.shadowOpacity;
    },
  };
  studio.apply(preset);
  return studio;
}

/**
 * Fits the key light's orthographic shadow frustum, in light space, around the model's bounding
 * box plus that box projected onto the floor along the light direction. As tight as possible
 * (texel density) without clipping the cast shadow on the floor.
 */
function fitShadowCamera(light: THREE.DirectionalLight, mesh: THREE.Mesh, floorY: number, includeFloor: boolean) {
  mesh.updateMatrixWorld();
  const box = new THREE.Box3().setFromObject(mesh);
  const toLight = light.position.clone().sub(light.target.position).normalize();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    pts.push(c);
    // Skip the floor projection for grazing light: the shadow would be near-infinite.
    if (includeFloor && toLight.y > 0.1) pts.push(c.clone().addScaledVector(toLight, -(c.y - floorY) / toLight.y));
  }
  const cam = light.shadow.camera;
  cam.position.copy(light.position);
  cam.lookAt(light.target.position);
  cam.updateMatrixWorld();
  const lb = new THREE.Box3();
  for (const p of pts) lb.expandByPoint(p.applyMatrix4(cam.matrixWorldInverse));
  const m = 0.02 * lb.getSize(new THREE.Vector3()).length();
  cam.left = lb.min.x - m;
  cam.right = lb.max.x + m;
  cam.bottom = lb.min.y - m;
  cam.top = lb.max.y + m;
  // The camera looks down -z, so distances are -z.
  cam.near = Math.max(0.01, -lb.max.z - m);
  cam.far = -lb.min.z + m;
  cam.updateProjectionMatrix();
}
