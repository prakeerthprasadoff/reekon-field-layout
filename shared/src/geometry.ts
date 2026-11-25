import type { Edge, Feature, FeatureType, Measurement, Shape, Space, Target } from './schema';

export interface Pt { x: number; y: number }

/** cos/sin that are exact for multiples of 90deg, so rectilinear shapes close with zero float error. */
export function unitVector(headingDeg: number): Pt {
  const d = ((headingDeg % 360) + 360) % 360;
  if (d === 0) return { x: 1, y: 0 };
  if (d === 90) return { x: 0, y: 1 };
  if (d === 180) return { x: -1, y: 0 };
  if (d === 270) return { x: 0, y: -1 };
  const r = (d * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

export function headingOf(a: Pt, b: Pt): number {
  return ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
}

export function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Snap to the nearest multiple of `step` if within `tolerance` degrees. */
export function snapAngle(deg: number, step = 90, tolerance = 3): number {
  const n = Math.round(deg / step) * step;
  return Math.abs(deg - n) <= tolerance ? normalizeDeg(n) : normalizeDeg(deg);
}

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Projection of p onto segment ab, as a distance from a (clamped to the segment). */
export function projectOnSegment(p: Pt, a: Pt, b: Pt): number {
  const L = dist(a, b);
  if (L === 0) return 0;
  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L);
  return Math.max(0, Math.min(1, t)) * L;
}

export type EdgeStatus = 'measured' | 'estimated';

export interface ResolvedEdge {
  id: string;
  index: number;
  start: Pt;
  end: Pt;
  headingDeg: number;
  lengthMm: number;
  status: EdgeStatus;
  measurement?: Measurement;
}

export interface ResolvedShape {
  vertices: Pt[];
  edges: ResolvedEdge[];
  closed: boolean;
  /** Distance between where the walk ends and where it started (closed shapes only). */
  closureGapMm: number;
  areaMm2: number;
  perimeterMm: number;
  centroid: Pt;
}

const MIN_EDGE_MM = 50;

/**
 * Turn the edge list into concrete geometry.
 * Measured edges use the measurement. For closed shapes, unmeasured edges are adjusted by the
 * minimum-norm change that closes the polygon (least squares), so measuring two walls of a
 * rectangle correctly infers the other two. Whatever gap remains (e.g. all walls measured but
 * they don't agree) is reported as the closure error.
 */
export function resolveShape(shape: Shape, measurements: Record<string, Measurement>): ResolvedShape {
  const n = shape.edges.length;
  const lengths: number[] = [];
  const measured: boolean[] = [];
  const units = shape.edges.map((e) => unitVector(e.headingDeg));

  shape.edges.forEach((e, i) => {
    const m = e.measurementId ? measurements[e.measurementId] : undefined;
    measured[i] = !!m;
    lengths[i] = m ? m.valueMm : e.lengthMm;
  });

  if (shape.closed && n >= 3) {
    const free = shape.edges.map((_, i) => i).filter((i) => !measured[i]);
    if (free.length > 0) {
      let gx = 0, gy = 0;
      for (let i = 0; i < n; i++) { gx += lengths[i] * units[i].x; gy += lengths[i] * units[i].y; }
      // Solve (U U^T + eps I) lambda = -g, delta_j = u_j . lambda
      let a = 1e-9, b = 0, d = 1e-9;
      for (const j of free) { a += units[j].x ** 2; b += units[j].x * units[j].y; d += units[j].y ** 2; }
      const det = a * d - b * b;
      const lx = (-gx * d + gy * b) / det;
      const ly = (gx * b - gy * a) / det;
      for (const j of free) {
        lengths[j] = Math.max(MIN_EDGE_MM, lengths[j] + units[j].x * lx + units[j].y * ly);
      }
    }
  }

  const vertices: Pt[] = [{ ...shape.origin }];
  const edges: ResolvedEdge[] = [];
  let cur = { ...shape.origin };
  shape.edges.forEach((e, i) => {
    const next = { x: cur.x + units[i].x * lengths[i], y: cur.y + units[i].y * lengths[i] };
    edges.push({
      id: e.id, index: i, start: cur, end: next, headingDeg: e.headingDeg, lengthMm: lengths[i],
      status: measured[i] ? 'measured' : 'estimated',
      measurement: e.measurementId ? measurements[e.measurementId] : undefined,
    });
    vertices.push(next);
    cur = next;
  });

  const closureGapMm = shape.closed && n >= 3 ? dist(cur, shape.origin) : 0;
  const poly = shape.closed ? vertices.slice(0, -1) : vertices;
  let area2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    area2 += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  const areaMm2 = shape.closed ? Math.abs(area2) / 2 : 0;
  const centroid = shape.closed && Math.abs(area2) > 1e-6
    ? { x: cx / (3 * area2), y: cy / (3 * area2) }
    : averagePoint(vertices);

  return {
    vertices, edges, closed: shape.closed, closureGapMm, areaMm2,
    perimeterMm: lengths.reduce((s, l) => s + l, 0), centroid,
  };
}

export interface ClosureAxis {
  /** Unit direction (world) the walk overshoots in. */
  dir: Pt;
  /** Overshoot along `dir`, mm (> 0). */
  offMm: number;
  /** Indices of walls running along +dir: together they're `offMm` longer than `short`. */
  long: number[];
  /** Indices of walls running against dir. */
  short: number[];
}

export interface ClosureDiagnosis {
  gapMm: number;
  /** Corner where the last wall should have met the first, and where it actually ends. */
  start: Pt;
  end: Pt;
  axes: ClosureAxis[];
  /** Every wall involved in a disagreement (edge indices, ascending). */
  suspects: number[];
}

/**
 * Explain a closure gap in terms the crew can act on. The gap is split along the layout's own
 * grid (first wall's direction and its perpendicular). Along each axis, the walls running one way
 * must add up to the walls running back; whichever side is longer, and by how much, is reported.
 * For a rectangle that reads as "Wall 1 is 1/4" longer than Wall 3".
 */
export function diagnoseClosure(rs: ResolvedShape, tolMm = 3): ClosureDiagnosis | null {
  if (!rs.closed || rs.edges.length < 3 || rs.closureGapMm <= tolMm) return null;
  const start = rs.vertices[0];
  const end = rs.vertices[rs.vertices.length - 1];
  const g = { x: end.x - start.x, y: end.y - start.y };
  const units = rs.edges.map((e) => unitVector(e.headingDeg));

  const axisFor = (d: Pt, along: number): ClosureAxis => {
    const dir = along > 0 ? d : { x: -d.x, y: -d.y };
    const long: number[] = [], short: number[] = [];
    units.forEach((u, i) => {
      const k = u.x * dir.x + u.y * dir.y;
      if (k > 0.5) long.push(i);
      else if (k < -0.5) short.push(i);
    });
    return { dir, offMm: Math.abs(along), long, short };
  };

  const a0 = units[0];
  const axes: ClosureAxis[] = [];
  for (const d of [a0, { x: -a0.y, y: a0.x }]) {
    const along = g.x * d.x + g.y * d.y;
    if (Math.abs(along) > tolMm) axes.push(axisFor(d, along));
  }
  // Gap split evenly across both axes, each part under tolerance: report it along the gap itself.
  if (axes.length === 0) {
    const L = Math.hypot(g.x, g.y);
    axes.push(axisFor({ x: g.x / L, y: g.y / L }, L));
  }
  const suspects = [...new Set(axes.flatMap((a) => [...a.long, ...a.short]))].sort((a, b) => a - b);
  return { gapMm: rs.closureGapMm, start, end, axes, suspects };
}

function averagePoint(ps: Pt[]): Pt {
  if (ps.length === 0) return { x: 0, y: 0 };
  return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
}

// ---------- Features ----------

export interface DimSpec { key: string; label: string; defaultMm: number }

/** Which dimensions each feature type collects, in the order Dana is asked for them. */
export const FEATURE_DIMS: Record<FeatureType, DimSpec[]> = {
  door: [
    { key: 'offset', label: 'From corner', defaultMm: 305 },
    { key: 'width', label: 'Width', defaultMm: 914 },
    { key: 'height', label: 'Height', defaultMm: 2032 },
  ],
  window: [
    { key: 'offset', label: 'From corner', defaultMm: 610 },
    { key: 'width', label: 'Width', defaultMm: 914 },
    { key: 'height', label: 'Height', defaultMm: 1219 },
    { key: 'sill', label: 'Sill height', defaultMm: 914 },
  ],
  opening: [
    { key: 'offset', label: 'From corner', defaultMm: 305 },
    { key: 'width', label: 'Width', defaultMm: 914 },
  ],
  steps: [
    { key: 'offset', label: 'From corner', defaultMm: 305 },
    { key: 'width', label: 'Width', defaultMm: 1219 },
    { key: 'rise', label: 'Total rise', defaultMm: 533 },
  ],
  post: [{ key: 'size', label: 'Post size', defaultMm: 140 }],
  wall: [{ key: 'length', label: 'Length', defaultMm: 1829 }],
};

export const FEATURE_LABEL: Record<FeatureType, string> = {
  door: 'Door', window: 'Window', opening: 'Opening', post: 'Post', steps: 'Steps', wall: 'Partition',
};

export const ON_EDGE_TYPES: FeatureType[] = ['door', 'window', 'opening', 'steps'];

export function featureSize(f: Feature, dim: string, measurements: Record<string, Measurement>): { mm: number; measured: boolean } {
  const mid = f.dims[dim];
  const m = mid ? measurements[mid] : undefined;
  if (m) return { mm: m.valueMm, measured: true };
  if (dim === 'offset' && 'edgeId' in f.anchor) return { mm: f.anchor.offsetMm, measured: false };
  return { mm: f.sizes[dim] ?? 0, measured: false };
}

export interface ResolvedFeature {
  feature: Feature;
  /** On-edge: segment along the wall. Free: p0 = p1 = position (post) or wall run. */
  p0: Pt;
  p1: Pt;
  /** Unit normal pointing into the space (on-edge features). */
  inward: Pt;
  edgeId?: string;
}

export function resolveFeature(f: Feature, rs: ResolvedShape, measurements: Record<string, Measurement>): ResolvedFeature | null {
  if ('edgeId' in f.anchor) {
    const anchor = f.anchor;
    const e = rs.edges.find((x) => x.id === anchor.edgeId);
    if (!e) return null;
    const u = unitVector(e.headingDeg);
    const offset = Math.min(featureSize(f, 'offset', measurements).mm, e.lengthMm);
    const width = Math.min(featureSize(f, 'width', measurements).mm, Math.max(0, e.lengthMm - offset));
    const p0 = { x: e.start.x + u.x * offset, y: e.start.y + u.y * offset };
    const p1 = { x: p0.x + u.x * width, y: p0.y + u.y * width };
    let inward = { x: -u.y, y: u.x };
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    if ((rs.centroid.x - mid.x) * inward.x + (rs.centroid.y - mid.y) * inward.y < 0) inward = { x: -inward.x, y: -inward.y };
    return { feature: f, p0, p1, inward, edgeId: e.id };
  }
  const pos = { x: f.anchor.x, y: f.anchor.y };
  if (f.type === 'wall') {
    const u = unitVector(Number(f.props.headingDeg ?? 0));
    const L = featureSize(f, 'length', measurements).mm;
    return { feature: f, p0: pos, p1: { x: pos.x + u.x * L, y: pos.y + u.y * L }, inward: { x: -u.y, y: u.x } };
  }
  return { feature: f, p0: pos, p1: pos, inward: { x: 0, y: -1 } };
}

// ---------- Measurement targets (Dana's queue) ----------

export interface TargetInfo {
  target: Target;
  label: string;
  measured: boolean;
  flagged: boolean;
}

export const targetKey = (t: Target) => `${t.kind}:${t.refId}:${t.dim ?? ''}`;
export const sameTarget = (a: Target, b: Target) => targetKey(a) === targetKey(b);

export function measurementForTarget(space: Space, t: Target): Measurement | undefined {
  if (t.kind === 'edge') {
    const e = space.shape?.edges.find((x) => x.id === t.refId);
    return e?.measurementId ? space.measurements[e.measurementId] : undefined;
  }
  const f = space.features[t.refId];
  const mid = f && t.dim ? f.dims[t.dim] : null;
  return mid ? space.measurements[mid] : undefined;
}

/** Every measurable thing in a space, in the order Dana walks them: walls, then features. */
export function listTargets(space: Space): TargetInfo[] {
  const openFlags = Object.values(space.flags).filter((f) => f.status === 'open');
  const isFlagged = (t: Target) => openFlags.some((f) => sameTarget(f.target, t));
  const out: TargetInfo[] = [];
  space.shape?.edges.forEach((e: Edge, i) => {
    const t: Target = { kind: 'edge', refId: e.id };
    out.push({ target: t, label: `Wall ${i + 1}`, measured: !!e.measurementId, flagged: isFlagged(t) });
  });
  const counters: Partial<Record<FeatureType, number>> = {};
  for (const f of featuresInOrder(space)) {
    counters[f.type] = (counters[f.type] ?? 0) + 1;
    for (const d of FEATURE_DIMS[f.type]) {
      if (d.key === 'offset' && !('edgeId' in f.anchor)) continue;
      const t: Target = { kind: 'feature', refId: f.id, dim: d.key };
      out.push({
        target: t,
        label: `${FEATURE_LABEL[f.type]} ${counters[f.type]} · ${d.label}`,
        measured: !!f.dims[d.key],
        flagged: isFlagged(t),
      });
    }
  }
  return out;
}

export function featuresInOrder(space: Space): Feature[] {
  // Object key order is insertion order for non-numeric keys, and survives JSON round-trips.
  return Object.values(space.features);
}

/** Next thing to measure: open flags first, then the first unmeasured target after `after`. */
export function nextTarget(space: Space, after?: Target): Target | null {
  const all = listTargets(space);
  const flagged = all.find((t) => t.flagged);
  if (flagged) return flagged.target;
  const startIdx = after ? all.findIndex((t) => sameTarget(t.target, after)) + 1 : 0;
  for (let k = 0; k < all.length; k++) {
    const t = all[(startIdx + k) % all.length];
    if (!t.measured) return t.target;
  }
  return null;
}

export function targetLabel(space: Space, t: Target): string {
  return listTargets(space).find((x) => sameTarget(x.target, t))?.label ?? 'Unknown';
}

// ---------- Readiness ----------

export interface SpaceStatus {
  measured: number;
  total: number;
  /** Closed shapes: do the walls meet (within tolerance)? null for open runs / no shape. */
  closes: boolean | null;
  openFlags: number;
  /** Everything measured, walls meet, nothing flagged: safe to estimate from. */
  ready: boolean;
}

export function spaceStatus(space: Space, tolMm = 3): SpaceStatus {
  const targets = listTargets(space);
  const measured = targets.filter((t) => t.measured).length;
  const openFlags = Object.values(space.flags).filter((f) => f.status === 'open').length;
  let closes: boolean | null = null;
  if (space.shape?.closed && space.shape.edges.length >= 3) {
    closes = resolveShape(space.shape, space.measurements).closureGapMm <= tolMm;
  }
  const ready = targets.length > 0 && measured === targets.length && closes !== false && openFlags === 0;
  return { measured, total: targets.length, closes, openFlags, ready };
}
