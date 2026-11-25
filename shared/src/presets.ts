import type { Edge, Shape } from './schema';
import { dist, headingOf, type Pt } from './geometry';
import { MM_PER_FOOT } from './units';

export type PresetKind = 'rect' | 'L' | 'U' | 'fence';

const ft = (n: number) => n * MM_PER_FOOT;

/** Walk definitions: [heading, feet]. Headings in y-down screen space (90 = down). */
const PRESET_WALKS: Record<PresetKind, { closed: boolean; walk: [number, number][] }> = {
  rect: { closed: true, walk: [[0, 12], [90, 10], [180, 12], [270, 10]] },
  L: { closed: true, walk: [[0, 14], [90, 6], [180, 6], [90, 6], [180, 8], [270, 12]] },
  U: { closed: true, walk: [[0, 16], [90, 12], [180, 5], [270, 6], [180, 6], [90, 6], [180, 5], [270, 12]] },
  fence: { closed: false, walk: [[0, 16]] },
};

export const PRESET_LABEL: Record<PresetKind, string> = {
  rect: 'Rectangle', L: 'L-shape', U: 'U-shape', fence: 'Fence line',
};

export function presetShape(kind: PresetKind, newId: () => string): Shape {
  const p = PRESET_WALKS[kind];
  const edges: Edge[] = p.walk.map(([h, f]) => ({
    id: newId(), headingDeg: h, headingSource: 'preset', lengthMm: ft(f), measurementId: null,
  }));
  return { origin: { x: 0, y: 0 }, closed: p.closed, edges };
}

/** Build a shape from tapped corners. Closed shapes get a final edge back to the first corner. */
export function shapeFromCorners(corners: Pt[], closed: boolean, newId: () => string): Shape {
  const pts = closed ? [...corners, corners[0]] : corners;
  const edges: Edge[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const L = dist(pts[i], pts[i + 1]);
    if (L < 1) continue;
    edges.push({ id: newId(), headingDeg: headingOf(pts[i], pts[i + 1]), headingSource: 'drawn', lengthMm: L, measurementId: null });
  }
  return { origin: { ...corners[0] }, closed, edges };
}
