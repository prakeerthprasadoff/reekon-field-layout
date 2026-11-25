// Grow an existing plan: Dana starts on a wall or corner, taps new corners, ends on a wall,
// and the new run is spliced into the outline. Walls that aren't touched keep their ids and
// readings; a wall that gets split keeps its id for the first part (its old reading no longer
// describes the wall, so it is unlinked) and doors/windows past the split move to the new part.
import { dist, headingOf, resolveShape, unitVector, type Pt } from './geometry';
import type { Edge, Feature, Measurement, Shape } from './schema';

/** A point on the existing outline: `t` mm along edge `edgeIndex` from its start corner. */
export interface BoundaryHit { edgeIndex: number; t: number }

export interface ExtendResult {
  shape: Shape;
  /** Doors/windows whose wall was split: re-anchor them (edge id + offset). */
  featureMoves: { featureId: string; edgeId: string; offsetMm: number }[];
}

interface Seg { edge: Edge; start: Pt; end: Pt; src: number; partStart: number }

export function extendShape(
  shape: Shape,
  measurements: Record<string, Measurement>,
  features: Record<string, Feature>,
  a: BoundaryHit,
  corners: Pt[],
  b: BoundaryHit | null,
  newId: () => string,
): ExtendResult | { error: string } {
  if (!shape.edges.length) return { error: 'There is no plan to extend yet' };
  const rs = resolveShape(shape, measurements);
  // Freeze inferred lengths so untouched walls stay where they are drawn.
  const segs: Seg[] = rs.edges.map((e, i) => ({
    edge: { ...shape.edges[i], lengthMm: Math.max(1, e.lengthMm) }, start: e.start, end: e.end, src: i, partStart: 0,
  }));
  const anchors = new Map<string, { edgeId: string; offsetMm: number }>();
  for (const f of Object.values(features)) if ('edgeId' in f.anchor) anchors.set(f.id, { ...f.anchor });
  const moved = new Set<string>();

  const pointOf = (h: BoundaryHit): Pt => {
    const e = rs.edges[h.edgeIndex];
    const u = unitVector(e.headingDeg);
    return { x: e.start.x + u.x * h.t, y: e.start.y + u.y * h.t };
  };

  /** Make `h` a corner of the outline (splitting a wall if needed). */
  const insert = (h: BoundaryHit) => {
    const k = segs.findIndex((s) => s.src === h.edgeIndex && h.t >= s.partStart - 1 && h.t <= s.partStart + s.edge.lengthMm + 1);
    if (k < 0) return;
    const seg = segs[k];
    const local = h.t - seg.partStart;
    const L = seg.edge.lengthMm;
    if (local < 25 || local > L - 25) return; // close enough to an existing corner
    const p = pointOf(h);
    const first: Edge = { ...seg.edge, lengthMm: local, measurementId: null };
    const second: Edge = { ...seg.edge, id: newId(), lengthMm: L - local, measurementId: null };
    segs.splice(k, 1,
      { edge: first, start: seg.start, end: p, src: seg.src, partStart: seg.partStart },
      { edge: second, start: p, end: seg.end, src: seg.src, partStart: seg.partStart + local });
    for (const [fid, an] of anchors) {
      if (an.edgeId === seg.edge.id && an.offsetMm >= local) { anchors.set(fid, { edgeId: second.id, offsetMm: an.offsetMm - local }); moved.add(fid); }
    }
  };

  const pa = pointOf(a);
  const pb = b ? pointOf(b) : null;
  insert(a);
  if (b) insert(b);
  const n = segs.length;
  const vertexAt = (p: Pt) => {
    const all = shape.closed ? segs.map((s) => s.start) : [...segs.map((s) => s.start), segs[n - 1].end];
    let best = -1, bestD = Infinity;
    all.forEach((v, i) => { const d = dist(v, p); if (d < bestD) { bestD = d; best = i; } });
    return best;
  };
  const runEdges = (pts: Pt[]): Edge[] =>
    pts.slice(1).map((p, i) => ({ id: newId(), headingDeg: headingOf(pts[i], p), headingSource: 'drawn' as const, lengthMm: dist(pts[i], p), measurementId: null }))
      .filter((e) => e.lengthMm >= 25);
  const ia = vertexAt(pa);
  const result = (s: Shape): ExtendResult => ({
    shape: s,
    featureMoves: [...moved].map((fid) => ({ featureId: fid, ...anchors.get(fid)! })),
  });

  if (shape.closed) {
    if (!pb) return { error: 'Finish on a wall of the plan' };
    const ib = vertexAt(pb);
    if (ia === ib) return { error: 'Finish on a different spot than where you started' };
    if (corners.length === 0) return { error: 'Add at least one new corner' };
    const around = (from: number, to: number) => { const out: Edge[] = []; for (let k = from; k !== to; k = (k + 1) % n) out.push(segs[k].edge); return out; };
    // Two ways to splice the new run in; "extend" means keep the one that adds area.
    const optA: Shape = { origin: { ...pa }, closed: true, edges: [...runEdges([pa, ...corners, pb]), ...around(ib, ia)] };
    const optB: Shape = { origin: { ...pb }, closed: true, edges: [...runEdges([pb, ...[...corners].reverse(), pa]), ...around(ia, ib)] };
    const areaA = resolveShape(optA, measurements).areaMm2;
    const areaB = resolveShape(optB, measurements).areaMm2;
    return result(areaA >= areaB ? optA : optB);
  }

  // Open run (fence): grow from either end; finishing on the other end closes it.
  if (corners.length === 0) return { error: 'Add at least one new corner' };
  const atEnd = ia === n, atStart = ia === 0;
  if (!atEnd && !atStart) return { error: 'Start from an end of the run' };
  const tail = pb ? [pb] : [];
  if (atEnd) {
    const closes = !!pb && vertexAt(pb) === 0;
    return result({ origin: { ...shape.origin }, closed: closes, edges: [...segs.map((s) => s.edge), ...runEdges([pa, ...corners, ...tail])] });
  }
  const pts = [...tail, ...[...corners].reverse(), pa];
  return result({ origin: { ...pts[0] }, closed: false, edges: [...runEdges(pts), ...segs.map((s) => s.edge)] });
}
