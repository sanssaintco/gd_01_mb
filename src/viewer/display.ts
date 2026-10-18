// Live viewer image pipeline: every pass renders the scene into a linear HDR (MSAA, half float)
// target and adds it to a float accumulation target; present() divides by the pass count, adds
// bloom, applies exposure → tone curve → colour ramp (one LUT texture) and writes sRGB to the
// canvas. Same math as the print path (render/look.ts), only on the GPU.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Bloom } from '../render/bloom';
import { type LookConfig, TONE_LUT_MAX, TONE_LUT_MIN, makeDisplayLut } from '../render/look';

const LUT_SIZE = 4096;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`;

const PRESENT_FRAG = /* glsl */ `
uniform sampler2D tAcc;
uniform sampler2D tBloom;
uniform sampler2D tLut;
uniform float uScale;
uniform float uBloom;
uniform vec4 uFrame;
uniform vec2 uLutRange;
uniform float uLutSize;
varying vec2 vUv;
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
void main() {
  float y = dot(texture2D(tAcc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722)) * uScale;
  if (uBloom > 0.0) y += uBloom * texture2D(tBloom, clamp((vUv - uFrame.xy) / uFrame.zw, 0.0, 1.0)).r;
  float x = log2(max(y, 1e-12) / 0.18);
  float u = clamp((x - uLutRange.x) / (uLutRange.y - uLutRange.x), 0.0, 1.0);
  vec3 c = texture2D(tLut, vec2((u * (uLutSize - 1.0) + 0.5) / uLutSize, 0.5)).rgb;
  // Triangular dither of ±1 LSB against banding in the large smooth areas.
  c += (hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 17.0) - 1.0) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

export class LookDisplay {
  /** Passes accumulated so far. */
  count = 0;
  private sceneRT: THREE.WebGLRenderTarget;
  private accRT: THREE.WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private copy = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: COPY_FRAG,
    uniforms: { tSrc: { value: null } },
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });
  private present_ = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: PRESENT_FRAG,
    uniforms: {
      tAcc: { value: null },
      tBloom: { value: null },
      tLut: { value: null },
      uScale: { value: 1 },
      uBloom: { value: 0 },
      uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
      uLutRange: { value: new THREE.Vector2(TONE_LUT_MIN, TONE_LUT_MAX) },
      uLutSize: { value: LUT_SIZE },
    },
    depthTest: false,
    depthWrite: false,
  });
  private lut: THREE.DataTexture;
  private lutKey = '';
  private bloom: Bloom;

  constructor(
    private renderer: THREE.WebGLRenderer,
    samples = 4,
  ) {
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      console.warn('[display] EXT_color_buffer_float missing: accumulation in half float');
    }
    const full = renderer.extensions.has('EXT_color_buffer_float');
    // Bilinear reads of the accumulation (bloom prefilter) need float filtering for FloatType.
    const accFilter =
      !full || renderer.extensions.has('OES_texture_float_linear') ? THREE.LinearFilter : THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: Math.min(samples, renderer.capabilities.maxSamples),
      depthBuffer: true,
    });
    this.accRT = new THREE.WebGLRenderTarget(1, 1, {
      type: full ? THREE.FloatType : THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: accFilter,
      magFilter: accFilter,
    });
    this.lut = new THREE.DataTexture(new Uint16Array(LUT_SIZE * 4), LUT_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.lut.minFilter = this.lut.magFilter = THREE.LinearFilter;
    this.lut.wrapS = this.lut.wrapT = THREE.ClampToEdgeWrapping;
    this.bloom = new Bloom(renderer);
  }

  setSize(w: number, h: number) {
    this.sceneRT.setSize(w, h);
    this.accRT.setSize(w, h);
    this.count = 0;
  }

  reset() {
    this.count = 0;
  }

  /** Renders one pass of the scene and adds it to the accumulation. */
  addPass(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    r.setRenderTarget(this.accRT);
    if (this.count === 0) {
      const prevClear = r.getClearColor(new THREE.Color());
      const prevAlpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.setClearColor(prevClear, prevAlpha);
    }
    r.autoClear = false;
    this.copy.uniforms.tSrc.value = this.sceneRT.texture;
    this.quad.material = this.copy;
    this.quad.render(r);
    this.count++;

    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
  }

  /**
   * Writes the current accumulation to the canvas through the look.
   * `frame`: the print frame inside the canvas (uv, origin bottom-left) and its height in pixels.
   */
  present(look: LookConfig, frame: { x: number; y: number; w: number; h: number; heightPx: number }) {
    if (this.count === 0) return;
    this.updateLut(look);
    const exposure = 2 ** look.tone.exposureEV;
    const scale = exposure / this.count;
    const u = this.present_.uniforms;
    u.tAcc.value = this.accRT.texture;
    u.tLut.value = this.lut;
    u.uScale.value = scale;
    u.uFrame.value.set(frame.x, frame.y, frame.w, frame.h);
    u.uBloom.value = 0;
    if (look.bloom.enabled && look.bloom.intensity > 0) {
      u.tBloom.value = this.bloom.render(
        {
          texture: this.accRT.texture,
          width: this.accRT.width,
          height: this.accRT.height,
          scale,
          refHeightPx: frame.heightPx,
          frameUv: frame,
        },
        look.bloom,
      );
      u.uBloom.value = look.bloom.intensity;
    }
    const r = this.renderer;
    r.setRenderTarget(null);
    this.quad.material = this.present_;
    this.quad.render(r);
  }

  private updateLut(look: LookConfig) {
    const key = JSON.stringify([look.tone, look.ramp]);
    if (key === this.lutKey) return;
    const lut = makeDisplayLut(look, LUT_SIZE);
    const data = this.lut.image.data as Uint16Array;
    for (let i = 0; i < lut.length; i++) data[i] = THREE.DataUtils.toHalfFloat(lut[i]);
    this.lut.needsUpdate = true;
    this.lutKey = key;
  }
}
