// three.js (r186) rotates its PCF soft-shadow samples with interleaved-gradient noise keyed on
// gl_FragCoord, i.e. on pixel coordinates *within the current render target*. With tiles, the
// pattern would restart in every tile and show up as seams in the shadow penumbrae. The patch
// adds the tile's global pixel origin, so every tile sees the noise of the full virtual image.
// With origin (0, 0) — the live viewer — the shader is identical to the stock one.

import * as THREE from 'three';

const NOISE_CALL = 'interleavedGradientNoise( gl_FragCoord.xy )';
const origin = { value: new THREE.Vector2(0, 0) };
const patched = new WeakSet<THREE.Material>();

export function patchMaterialForTiling(material: THREE.Material): boolean {
  if (patched.has(material)) return true;
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!chunk.includes(NOISE_CALL)) {
    console.warn('[tileNoise] three.js shadow chunk changed; global shadow-noise patch not applied');
    return false;
  }
  const patchedChunk =
    'uniform vec2 uTileOrigin;\n' +
    chunk.replaceAll(NOISE_CALL, 'interleavedGradientNoise( gl_FragCoord.xy + uTileOrigin )');
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uTileOrigin = origin;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', patchedChunk);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|tile-origin-v1`;
  material.needsUpdate = true;
  patched.add(material);
  return true;
}

/** Global pixel position of the render target's bottom-left pixel (GL convention: y up). */
export function setTileOrigin(x: number, y: number) {
  origin.value.set(x, y);
}
