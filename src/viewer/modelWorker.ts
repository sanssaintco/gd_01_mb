// Loads and prepares the STL off the main thread:
// fetch → STLLoader.parse → drop flat normals → mergeVertices → computeVertexNormals.

import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export interface ModelRequest {
  url: string;
  tolerance: number;
}

export type ModelMessage =
  | { type: 'progress'; stage: string; loaded?: number; total?: number }
  | {
      type: 'done';
      position: Float32Array;
      normal: Float32Array;
      index: Uint32Array;
      stats: ModelStats;
    }
  | { type: 'error'; message: string; notFound: boolean };

export interface ModelStats {
  bytes: number;
  trianglesIn: number;
  verticesIn: number;
  verticesMerged: number;
  msDownload: number;
  msParse: number;
  msMerge: number;
  msNormals: number;
}

const post = (msg: ModelMessage, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (e: MessageEvent<ModelRequest>) => {
  const { url, tolerance } = e.data;
  try {
    let t = performance.now();
    const res = await fetch(url);
    // The Vite dev server answers unknown paths with index.html (200), so HTML also means "missing".
    const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
    if (!res.ok || isHtml) {
      await res.body?.cancel();
      post({ type: 'error', message: `HTTP ${res.status} for ${url}`, notFound: res.status === 404 || isHtml });
      return;
    }
    const buf = await readWithProgress(res);
    const msDownload = performance.now() - t;

    post({ type: 'progress', stage: 'parsing STL' });
    t = performance.now();
    const geometry = new STLLoader().parse(buf);
    const msParse = performance.now() - t;
    const verticesIn = geometry.attributes.position.count;

    // STL normals are per-face. If they stay, mergeVertices sees different normals at shared
    // positions and merges nothing, so the mesh stays faceted.
    post({ type: 'progress', stage: `merging ${verticesIn.toLocaleString('en')} vertices` });
    t = performance.now();
    geometry.deleteAttribute('normal');
    const merged = mergeVertices(geometry, tolerance);
    geometry.dispose();
    const msMerge = performance.now() - t;

    post({ type: 'progress', stage: 'computing smooth normals' });
    t = performance.now();
    merged.computeVertexNormals();
    const msNormals = performance.now() - t;

    const position = merged.attributes.position.array as Float32Array;
    const normal = merged.attributes.normal.array as Float32Array;
    const index = Uint32Array.from(merged.index!.array);
    post(
      {
        type: 'done',
        position,
        normal,
        index,
        stats: {
          bytes: buf.byteLength,
          trianglesIn: verticesIn / 3,
          verticesIn,
          verticesMerged: merged.attributes.position.count,
          msDownload,
          msParse,
          msMerge,
          msNormals,
        },
      },
      [position.buffer, normal.buffer, index.buffer],
    );
  } catch (err) {
    post({ type: 'error', message: String(err), notFound: false });
  }
};

async function readWithProgress(res: Response): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('content-length')) || undefined;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastPost > 100) {
      post({ type: 'progress', stage: 'downloading', loaded, total });
      lastPost = now;
    }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}
