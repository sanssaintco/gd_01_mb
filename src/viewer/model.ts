// Model loading (via worker), normalization (up axis, center, scale) and the placeholder mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ModelMessage, ModelRequest, ModelStats } from './modelWorker';
import type { UpAxis } from '../config/scene';

export interface LoadedModel {
  geometry: THREE.BufferGeometry;
  isPlaceholder: boolean;
  /** Why the placeholder is used, if it is. */
  placeholderReason?: string;
  stats?: ModelStats;
  /** Up axis detected or forced. */
  upAxis: Exclude<UpAxis, 'auto'>;
  /** Bounding box size in source units before scaling. */
  sourceSize: [number, number, number];
}

export function loadStl(
  req: ModelRequest,
  onProgress: (msg: string) => void,
): Promise<{ geometry: THREE.BufferGeometry; stats: ModelStats }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ModelMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        const pct = m.total ? ` ${Math.round((100 * (m.loaded ?? 0)) / m.total)} %` : '';
        onProgress(`${m.stage}${pct}`);
      } else if (m.type === 'done') {
        worker.terminate();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
        g.setIndex(new THREE.BufferAttribute(m.index, 1));
        resolve({ geometry: g, stats: m.stats });
      } else {
        worker.terminate();
        reject(Object.assign(new Error(m.message), { notFound: m.notFound }));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(req);
  });
}

/**
 * Rotates the geometry so its up axis becomes +Y, centers it on the origin and scales it to
 * `height`. 'auto' picks the longest bounding-box axis (a standing
 * figure is much taller than wide).
 */
export function normalizeGeometry(
  g: THREE.BufferGeometry,
  upAxis: UpAxis,
  height: number,
): { upAxis: Exclude<UpAxis, 'auto'>; sourceSize: [number, number, number] } {
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  let axis: Exclude<UpAxis, 'auto'>;
  if (upAxis === 'auto') {
    axis = size.z >= size.x && size.z >= size.y ? 'z' : size.x >= size.y ? 'x' : 'y';
  } else {
    axis = upAxis;
  }
  const toY: Record<Exclude<UpAxis, 'auto'>, THREE.Matrix4> = {
    y: new THREE.Matrix4(),
    '-y': new THREE.Matrix4().makeRotationX(Math.PI),
    z: new THREE.Matrix4().makeRotationX(-Math.PI / 2),
    '-z': new THREE.Matrix4().makeRotationX(Math.PI / 2),
    x: new THREE.Matrix4().makeRotationZ(Math.PI / 2),
    '-x': new THREE.Matrix4().makeRotationZ(-Math.PI / 2),
  };
  g.applyMatrix4(toY[axis]);
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  g.translate(-center.x, -center.y, -center.z);
  const s = height / (box.max.y - box.min.y);
  g.scale(s, s, s);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return { upAxis: axis, sourceSize: [size.x, size.y, size.z] };
}

/** Pedestal + torus knot: enough curvature to judge shading and self-shadowing. */
export function placeholderGeometry(): THREE.BufferGeometry {
  const pedestal = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0),
      new THREE.Vector2(0.42, 0),
      new THREE.Vector2(0.42, 0.06),
      new THREE.Vector2(0.36, 0.09),
      new THREE.Vector2(0.3, 0.12),
      new THREE.Vector2(0.3, 0.5),
      new THREE.Vector2(0.36, 0.53),
      new THREE.Vector2(0.4, 0.58),
      new THREE.Vector2(0.0, 0.58),
    ],
    128,
  );
  const knot = new THREE.TorusKnotGeometry(0.32, 0.11, 600, 96, 2, 3);
  knot.translate(0, 1.1, 0);
  for (const p of [pedestal, knot]) p.deleteAttribute('uv');
  return mergeGeometries([pedestal, knot], false)!;
}
