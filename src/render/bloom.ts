// Bloom on the GPU: soft-knee threshold → downsample pyramid → one separable gaussian per bloom
// component at the pyramid level where its sigma is a few texels → weighted sum.
//
// Sigmas are fractions of a reference height (the frame height in pixels), so a ~1000 px viewer
// frame and the 7087 px A2 render get the same bloom. Runs on a whole frame only, never per tile.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { type BloomConfig, bloomComponents } from './look';

export interface BloomInput {
  texture: THREE.Texture;
  width: number;
  height: number;
  /** Multiplier from the texture's values to exposed luminance (e.g. 1/N × exposure). */
  scale: number;
  /** Frame height in pixels of `texture` that the config's sigmas refer to. */
  refHeightPx: number;
  /**
   * Sub-rectangle of the texture (uv, origin bottom-left) that is the frame. Outside it, the
   * input is treated as edge-clamped frame content, like the print. Default: the whole texture.
   */
  frameUv?: { x: number; y: number; w: number; h: number };
}

const MAX_RADIUS = 48;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

// 4 bilinear taps = a 4×4 tent around the 2×2 block under the output pixel.
const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec4 uFrame;
uniform float uScale;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
float lum(vec2 uv) {
  uv = clamp(uv, uFrame.xy + 0.5 * uTexel, uFrame.xy + uFrame.zw - 0.5 * uTexel);
  return dot(texture2D(tSrc, uv).rgb, ${LUMA}) * uScale;
}
void main() {
  vec2 uv = uFrame.xy + vUv * uFrame.zw;
  float y = 0.25 * (lum(uv + uTexel * vec2(-1.0, -1.0)) + lum(uv + uTexel * vec2(1.0, -1.0)) +
                    lum(uv + uTexel * vec2(-1.0, 1.0)) + lum(uv + uTexel * vec2(1.0, 1.0)));
  float k = max(uKnee, 1e-5);
  float soft = clamp(y - uThreshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  float w = max(soft, y - uThreshold) / max(y, 1e-6);
  gl_FragColor = vec4(vec3(y * clamp(w, 0.0, 1.0)), 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float y = 0.25 * (texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).r + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).r +
                    texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).r + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).r);
  gl_FragColor = vec4(vec3(y), 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
#define MAX_RADIUS ${MAX_RADIUS}
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uSigma;
uniform int uRadius;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -MAX_RADIUS; i <= MAX_RADIUS; i++) {
    if (i < -uRadius || i > uRadius) continue;
    float x = float(i);
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    sum += w * texture2D(tSrc, vUv + uStep * x).r;
    wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / wsum), 1.0);
}`;

const COMBINE_FRAG = /* glsl */ `
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform sampler2D t3;
uniform sampler2D t4;
uniform float uW[5];
varying vec2 vUv;
void main() {
  float y = uW[0] * texture2D(t0, vUv).r + uW[1] * texture2D(t1, vUv).r + uW[2] * texture2D(t2, vUv).r +
            uW[3] * texture2D(t3, vUv).r + uW[4] * texture2D(t4, vUv).r;
  gl_FragColor = vec4(vec3(y), 1.0);
}`;

const material = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });

function makeTarget(w: number, h: number) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

export class Bloom {
  private quad = new FullScreenQuad();
  private prefilter = material(PREFILTER_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    uScale: { value: 1 },
    uThreshold: { value: 1 },
    uKnee: { value: 0.5 },
  });
  private down = material(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  private blur = material(BLUR_FRAG, {
    tSrc: { value: null },
    uStep: { value: new THREE.Vector2() },
    uSigma: { value: 1 },
    uRadius: { value: 1 },
  });
  private combine = material(COMBINE_FRAG, {
    t0: { value: null },
    t1: { value: null },
    t2: { value: null },
    t3: { value: null },
    t4: { value: null },
    uW: { value: [0, 0, 0, 0, 0] },
  });
  /** Pyramid: levels[0] is half the frame resolution, each next level half again. */
  private levels: THREE.WebGLRenderTarget[] = [];
  /** Per component: ping (horizontal) and pong (result) at its level's size. */
  private comps: Array<{ ping: THREE.WebGLRenderTarget; pong: THREE.WebGLRenderTarget }> = [];
  private output?: THREE.WebGLRenderTarget;
  private size = { w: 0, h: 0 };

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Returns the bloom (exposed luminance in .r) for the frame, at half resolution. */
  render(input: BloomInput, cfg: BloomConfig): THREE.Texture {
    const frame = input.frameUv ?? { x: 0, y: 0, w: 1, h: 1 };
    const fw = Math.round(input.width * frame.w);
    const fh = Math.round(input.height * frame.h);
    this.ensureLevels(Math.ceil(fw / 2), Math.ceil(fh / 2));
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;

    const pf = this.prefilter.uniforms;
    pf.tSrc.value = input.texture;
    pf.uTexel.value.set(1 / input.width, 1 / input.height);
    pf.uFrame.value.set(frame.x, frame.y, frame.w, frame.h);
    pf.uScale.value = input.scale;
    pf.uThreshold.value = cfg.threshold;
    pf.uKnee.value = cfg.knee;
    this.pass(this.prefilter, this.levels[0]);
    for (let l = 1; l < this.levels.length; l++) {
      const src = this.levels[l - 1];
      this.down.uniforms.tSrc.value = src.texture;
      this.down.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
      this.pass(this.down, this.levels[l]);
    }

    const comps = bloomComponents(cfg);
    const cu = this.combine.uniforms;
    comps.forEach((c, k) => {
      const sigmaPx = c.sigma * input.refHeightPx; // in frame pixels
      // Level i has scale 2^(i+1); pick the coarsest level where sigma is still ≥ 2 texels.
      let li = Math.floor(Math.log2(Math.max(sigmaPx, 1) / 2)) - 1;
      li = Math.max(0, Math.min(this.levels.length - 1, li));
      const level = this.levels[li];
      const sigma = Math.min(sigmaPx / 2 ** (li + 1), MAX_RADIUS / 3);
      const target = this.ensureComp(k, level.width, level.height);
      const b = this.blur.uniforms;
      b.uSigma.value = Math.max(sigma, 0.3);
      b.uRadius.value = Math.min(MAX_RADIUS, Math.ceil(3 * sigma));
      b.tSrc.value = level.texture;
      b.uStep.value.set(1 / level.width, 0);
      this.pass(this.blur, target.ping);
      b.tSrc.value = target.ping.texture;
      b.uStep.value.set(0, 1 / level.height);
      this.pass(this.blur, target.pong);
      cu[`t${k}`].value = target.pong.texture;
      cu.uW.value[k] = c.weight;
    });
    this.pass(this.combine, this.output!);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    return this.output!.texture;
  }

  /** Reads the last result back (float luminance, rows bottom-up), for the CPU print path. */
  readOutput(): { data: Float32Array; width: number; height: number } {
    const out = this.output!;
    const raw = new Uint16Array(out.width * out.height * 4);
    this.renderer.readRenderTargetPixels(out, 0, 0, out.width, out.height, raw);
    const data = new Float32Array(out.width * out.height);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.fromHalfFloat(raw[i * 4]);
    return { data, width: out.width, height: out.height };
  }

  dispose() {
    for (const t of this.levels) t.dispose();
    for (const c of this.comps) {
      c.ping.dispose();
      c.pong.dispose();
    }
    this.output?.dispose();
    for (const m of [this.prefilter, this.down, this.blur, this.combine]) m.dispose();
    this.quad.dispose();
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  private ensureLevels(w: number, h: number) {
    if (this.size.w === w && this.size.h === h) return;
    for (const t of this.levels) t.dispose();
    this.levels = [];
    let lw = w;
    let lh = h;
    while (this.levels.length < 10) {
      this.levels.push(makeTarget(lw, lh));
      if (Math.min(lw, lh) <= 8) break;
      lw = Math.ceil(lw / 2);
      lh = Math.ceil(lh / 2);
    }
    this.output?.dispose();
    this.output = makeTarget(w, h);
    this.size = { w, h };
  }

  private ensureComp(k: number, w: number, h: number) {
    const c = this.comps[k];
    if (c && c.ping.width === w && c.ping.height === h) return c;
    c?.ping.dispose();
    c?.pong.dispose();
    this.comps[k] = { ping: makeTarget(w, h), pong: makeTarget(w, h) };
    return this.comps[k];
  }
}
