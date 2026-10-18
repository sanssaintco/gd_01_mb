// Marble shading patch for MeshStandardMaterial (three r186): wrap lighting on the direct diffuse
// term, (N·L + w) / (1 + w), so light reaches a little past the terminator, which reads like
// subsurface scattering. w = 0 is the stock shader. Per-pixel only, so tile-safe.

import * as THREE from 'three';

const DIFFUSE_LINE =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
const WRAPPED_LINE =
  'float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + uMarbleWrap ) / ( 1.0 + uMarbleWrap ) );\n' +
  '\treflectedLight.directDiffuse += wrapNL * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

const wrap = { value: 0 };
const patched = new WeakSet<THREE.Material>();

export function setMarbleWrap(w: number) {
  wrap.value = Math.max(0, w);
}

export function patchMaterialForMarble(material: THREE.Material): boolean {
  if (patched.has(material)) return true;
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(DIFFUSE_LINE)) {
    console.warn('[marble] three.js lighting chunk changed; wrap lighting not applied');
    return false;
  }
  const patchedChunk = 'uniform float uMarbleWrap;\n' + chunk.replace(DIFFUSE_LINE, WRAPPED_LINE);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uMarbleWrap = wrap;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', patchedChunk);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|marble-v1`;
  material.needsUpdate = true;
  patched.add(material);
  return true;
}
