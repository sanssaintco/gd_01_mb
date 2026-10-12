// SVG → flattened absolute vector paths. All transforms (viewBox → mm, ancestor <g transform>,
// the path's own transform) are folded into one matrix and applied to the coordinates, so the
// PDF receives plain absolute m / l / c / h segments in millimetres. Arcs and quadratics become
// cubics first, which keeps the result exact under any affine transform.

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG/PDF convention). */
export type Matrix = [number, number, number, number, number, number];

export type Segment =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

export interface FlatShape {
  segments: Segment[];
  /** Bounding box in mm (y down, SVG orientation), from the end and control points. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  pathCount: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export async function loadSvgShape(url: string): Promise<FlatShape> {
  const res = await fetch(url);
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`SVG not found: ${decodeURI(url)}`);
  }
  return flattenSvg(await res.text());
}

export function flattenSvg(text: string): FlatShape {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg') throw new Error('not an SVG document');
  const root = rootMatrix(svg);
  const segments: Segment[] = [];
  const paths = Array.from(doc.getElementsByTagName('path'));
  for (const p of paths) {
    let m = parseTransform(p.getAttribute('transform'));
    for (let el = p.parentElement; el && el !== svg; el = el.parentElement) {
      m = multiply(parseTransform(el.getAttribute('transform')), m);
    }
    m = multiply(root, m);
    for (const s of toAbsoluteCubic(p.getAttribute('d') ?? '')) segments.push(applyMatrix(s, m));
  }
  return { segments, bbox: bboxOf(segments), pathCount: paths.length };
}

/** viewBox → millimetres, from the width/height attributes (mm, cm, in, pt, px at 96 dpi). */
function rootMatrix(svg: Element): Matrix {
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const w = toMm(svg.getAttribute('width'));
  const h = toMm(svg.getAttribute('height'));
  if (vb.length !== 4 || vb.some(Number.isNaN)) return w ? [w, 0, 0, w, 0, 0] : IDENTITY;
  const sx = w ? w / vb[2] : 1;
  const sy = h ? h / vb[3] : sx;
  return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
}

function toMm(v: string | null): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([\d.+-eE]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const per = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 }[m[2] ?? 'px'] ?? 25.4 / 96;
  return n * per;
}

export function parseTransform(t: string | null): Matrix {
  let m = IDENTITY;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let r = re.exec(t); r; r = re.exec(t)) {
    const a = r[2].trim().split(/[\s,]+/).map(Number);
    let n: Matrix;
    switch (r[1]) {
      case 'matrix':
        n = a as Matrix;
        break;
      case 'translate':
        n = [1, 0, 0, 1, a[0], a[1] ?? 0];
        break;
      case 'scale':
        n = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
        break;
      case 'rotate': {
        const rad = (a[0] * Math.PI) / 180;
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        const rot: Matrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
        n = multiply(multiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        n = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        n = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, n);
  }
  return m;
}

/** m1 · m2 (apply m2 first, then m1). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}

function applyMatrix(s: Segment, m: Matrix): Segment {
  const t = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  switch (s.op) {
    case 'Z':
      return s;
    case 'C': {
      const [x1, y1] = t(s.x1, s.y1);
      const [x2, y2] = t(s.x2, s.y2);
      const [x, y] = t(s.x, s.y);
      return { op: 'C', x1, y1, x2, y2, x, y };
    }
    default: {
      const [x, y] = t(s.x, s.y);
      return { op: s.op, x, y };
    }
  }
}

function bboxOf(segs: Segment[]) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  };
  for (const s of segs) {
    if (s.op === 'Z') continue;
    if (s.op === 'C') {
      add(s.x1, s.y1);
      add(s.x2, s.y2);
    }
    add(s.x, s.y);
  }
  return b;
}

/** Parses path data into absolute M / L / C / Z (H, V → L; S, Q, T → C; A → C). */
export function toAbsoluteCubic(d: string): Segment[] {
  const tokens = tokenize(d);
  const out: Segment[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0; // subpath start
  let sy = 0;
  let lastC: [number, number] | undefined; // last cubic control point (for S)
  let lastQ: [number, number] | undefined; // last quadratic control point (for T)
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || isCommand(t)) throw new Error(`bad path data near token ${i}`);
    return Number(t);
  };
  const flag = () => {
    // Arc flags may be written without separators ("a1 1 0 01 5 5"): take one character.
    const t = tokens[i];
    if (t === undefined) throw new Error('bad arc flag');
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) {
      tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    i++;
    return t === '1';
  };
  const quadToCubic = (qx: number, qy: number, ex: number, ey: number) => {
    out.push({
      op: 'C',
      x1: x + (2 / 3) * (qx - x),
      y1: y + (2 / 3) * (qy - y),
      x2: ex + (2 / 3) * (qx - ex),
      y2: ey + (2 / 3) * (qy - ey),
      x: ex,
      y: ey,
    });
  };

  while (i < tokens.length) {
    if (isCommand(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error('path data must start with a command');
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    let nextC: [number, number] | undefined;
    let nextQ: [number, number] | undefined;
    switch (C) {
      case 'M': {
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push({ op: 'M', x, y });
        cmd = rel ? 'l' : 'L'; // implicit lineto for further pairs
        break;
      }
      case 'L':
        x = ox + num();
        y = oy + num();
        out.push({ op: 'L', x, y });
        break;
      case 'H':
        x = ox + num();
        out.push({ op: 'L', x, y });
        break;
      case 'V':
        y = oy + num();
        out.push({ op: 'L', x, y });
        break;
      case 'C': {
        const x1 = ox + num();
        const y1 = oy + num();
        const x2 = ox + num();
        const y2 = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ op: 'C', x1, y1, x2, y2, x, y });
        nextC = [x2, y2];
        break;
      }
      case 'S': {
        const [x1, y1] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const x2 = ox + num();
        const y2 = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ op: 'C', x1, y1, x2, y2, x, y });
        nextC = [x2, y2];
        break;
      }
      case 'Q': {
        const qx = ox + num();
        const qy = oy + num();
        const ex = ox + num();
        const ey = oy + num();
        quadToCubic(qx, qy, ex, ey);
        [x, y] = [ex, ey];
        nextQ = [qx, qy];
        break;
      }
      case 'T': {
        const [qx, qy] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const ex = ox + num();
        const ey = oy + num();
        quadToCubic(qx, qy, ex, ey);
        [x, y] = [ex, ey];
        nextQ = [qx, qy];
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const ex = ox + num();
        const ey = oy + num();
        for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) out.push(c);
        [x, y] = [ex, ey];
        break;
      }
      case 'Z':
        out.push({ op: 'Z' });
        [x, y] = [sx, sy];
        break;
      default:
        throw new Error(`unsupported path command "${cmd}"`);
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return out;
}

/** A single command letter. A plain /[a-zA-Z]/ test would also match the exponent in "-1e-4". */
const isCommand = (t: string) => /^[a-zA-Z]$/.test(t);

function tokenize(d: string): string[] {
  return d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

/** SVG endpoint arc → cubic Béziers (≤ 90° each), per SVG 1.1 implementation notes F.6.5/F.6.6. */
function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Segment[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ op: 'L', x: x2, y: y2 }];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const n = Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9);
  const step = dTheta / n;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => {
    const ct = Math.cos(t);
    const st = Math.sin(t);
    return {
      x: cx + rx * ct * cos - ry * st * sin,
      y: cy + rx * ct * sin + ry * st * cos,
      dx: -rx * st * cos - ry * ct * sin,
      dy: -rx * st * sin + ry * ct * cos,
    };
  };
  const out: Segment[] = [];
  for (let j = 0; j < n; j++) {
    const a = point(theta1 + j * step);
    const b = point(theta1 + (j + 1) * step);
    const last = j === n - 1;
    out.push({
      op: 'C',
      x1: a.x + alpha * a.dx,
      y1: a.y + alpha * a.dy,
      x2: b.x - alpha * b.dx,
      y2: b.y - alpha * b.dy,
      x: last ? x2 : b.x,
      y: last ? y2 : b.y,
    });
  }
  return out;
}
