// The studio: model mesh, monochrome material, key/fill/rim/hemisphere lights, soft shadows,
// optional shadow-catcher floor, neutral background. Used by the live viewer and the tiled
// print renderer, so both see exactly the same scene.

import * as THREE from 'three';
import type { LightSpec, ScenePreset } from '../config/scene';

const LIGHT_DISTANCE = 10;

export interface Studio {
  scene: THREE.Scene;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  floor: THREE.Mesh;
  /** Bounding sphere radius of the normalized model. */
  radius: number;
  apply(preset: ScenePreset): void;
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

function placeLight(light: THREE.DirectionalLight, spec: LightSpec) {
  const az = THREE.MathUtils.degToRad(spec.azimuthDeg);
  const el = THREE.MathUtils.degToRad(spec.elevationDeg);
  light.position.set(
    LIGHT_DISTANCE * Math.sin(az) * Math.cos(el),
    LIGHT_DISTANCE * Math.sin(el),
    LIGHT_DISTANCE * Math.cos(az) * Math.cos(el),
  );
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
  const hemi = new THREE.HemisphereLight();
  scene.add(key, fill, rim, hemi);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 12, radius * 12), new THREE.ShadowMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = minY;
  floor.receiveShadow = true;
  scene.add(floor);

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

  const studio: Studio = {
    scene,
    mesh,
    material,
    key,
    fill,
    rim,
    hemi,
    floor,
    radius,
    setShadowMapSize,
    get shadowMapSize() {
      return key.shadow.mapSize.x;
    },
    apply(p: ScenePreset) {
      scene.background = gray(p.background);
      mesh.rotation.y = THREE.MathUtils.degToRad(p.model.rotateYDeg);
      material.color = gray(p.material.gray);
      material.roughness = p.material.roughness;
      material.metalness = p.material.metalness;

      placeLight(key, p.key);
      placeLight(fill, p.fill);
      placeLight(rim, p.rim);
      softness = p.key.shadowRadius;
      setShadowMapSize(p.key.shadowMapSize);
      key.shadow.bias = p.key.shadowBias;
      key.shadow.normalBias = p.key.shadowNormalBias;
      fitShadowCamera(key, mesh, minY, p.floor.enabled);
      key.shadow.needsUpdate = true;

      hemi.intensity = p.hemi.intensity;
      hemi.color = gray(p.hemi.skyGray);
      hemi.groundColor = gray(p.hemi.groundGray);

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
