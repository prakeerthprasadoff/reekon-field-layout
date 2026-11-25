import { describe, expect, it } from 'vitest';
import {
  applyOp, diagnoseClosure, extendShape, spaceStatus, formatImperial, formatLength, nextTarget, parseLength, presetShape, replay,
  resolveShape, roleMayApply, type Measurement, type Op, type OpBody, OpZ,
} from './index';

let n = 0;
const id = () => `id${++n}`;
const env = (body: OpBody, role: 'field' | 'office' = 'field'): Op =>
  ({ opId: id(), projectId: 'p1', clientId: 'c1', role, author: role === 'field' ? 'Dana' : 'Marcus', ts: n, ...body }) as Op;

describe('parseLength', () => {
  const inches = (s: string) => parseLength(s)!.mm / 25.4;
  it('parses what the tape sends', () => {
    expect(inches(`12' 4 1/2"`)).toBeCloseTo(148.5);
    expect(inches(`12'4-1/2"`)).toBeCloseTo(148.5);
    expect(inches(`0' 7 3/16"`)).toBeCloseTo(7.1875);
  });
  it('parses typed variants', () => {
    expect(inches(`12'`)).toBeCloseTo(144);
    expect(inches(`4 1/2"`)).toBeCloseTo(4.5);
    expect(inches(`3/8"`)).toBeCloseTo(0.375);
    expect(inches(`148.5in`)).toBeCloseTo(148.5);
    expect(inches(`12-4 1/2`)).toBeCloseTo(148.5);
    expect(inches(`12.5 ft`)).toBeCloseTo(150);
    expect(inches(`12 ft 4 in`)).toBeCloseTo(148);
    expect(inches(`12′ 4½″`.replace('½', ' 1/2'))).toBeCloseTo(148.5);
    expect(parseLength('3.77m')!.mm).toBeCloseTo(3770);
    expect(parseLength('3770', 'metric')!.mm).toBe(3770);
  });
  it('records precision from the input', () => {
    expect(parseLength(`12' 4 1/2"`)!.precisionMm).toBeCloseTo(25.4 / 2);
    expect(parseLength(`4 3/16"`)!.precisionMm).toBeCloseTo(25.4 / 16);
    expect(parseLength('12.345 mm')!.precisionMm).toBeCloseTo(0.001);
  });
  it('rejects junk', () => {
    expect(parseLength('')).toBeNull();
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('4 1/0"')).toBeNull();
  });
});

describe('format', () => {
  it('round-trips the tape string', () => {
    expect(formatImperial(parseLength(`12' 4 1/2"`)!.mm)).toBe(`12' 4 1/2"`);
    expect(formatImperial(144 * 25.4)).toBe(`12'`);
    expect(formatImperial(7.5 * 25.4)).toBe(`7 1/2"`);
    expect(formatImperial(0.25 * 25.4)).toBe(`1/4"`);
  });
  it('respects the reading precision', () => {
    const p = parseLength(`12' 4 1/2"`)!;
    expect(formatLength(p.mm + 1, 'imperial', p.precisionMm)).toBe(`12' 4 1/2"`);
  });
});

function measure(edgeId: string, mm: number): Measurement {
  return { id: id(), target: { kind: 'edge', refId: edgeId }, valueMm: mm, raw: '', source: 'ble-tape', precisionMm: 1.5875, takenAt: 0, takenBy: 'Dana', deviceId: 'd', supersedes: null };
}

describe('resolveShape', () => {
  it('infers unmeasured walls of a rectangle', () => {
    const shape = presetShape('rect', id);
    const m1 = measure(shape.edges[0].id, 5000);
    const m2 = measure(shape.edges[1].id, 3000);
    shape.edges[0].measurementId = m1.id;
    shape.edges[1].measurementId = m2.id;
    const rs = resolveShape(shape, { [m1.id]: m1, [m2.id]: m2 });
    expect(rs.edges[2].lengthMm).toBeCloseTo(5000);
    expect(rs.edges[3].lengthMm).toBeCloseTo(3000);
    expect(rs.closureGapMm).toBeCloseTo(0);
    expect(rs.areaMm2).toBeCloseTo(15e6);
    expect(rs.edges[2].status).toBe('estimated');
  });
  it('reports closure error when every wall is measured and they disagree', () => {
    const shape = presetShape('rect', id);
    const ms = [5000, 3000, 5010, 3000].map((v, i) => measure(shape.edges[i].id, v));
    ms.forEach((m, i) => (shape.edges[i].measurementId = m.id));
    const rs = resolveShape(shape, Object.fromEntries(ms.map((m) => [m.id, m])));
    expect(rs.closureGapMm).toBeCloseTo(10);
  });
  it('names the walls that disagree', () => {
    const shape = presetShape('rect', id);
    const ms = [5000, 3000, 5006.35, 3000].map((v, i) => measure(shape.edges[i].id, v));
    ms.forEach((m, i) => (shape.edges[i].measurementId = m.id));
    const d = diagnoseClosure(resolveShape(shape, Object.fromEntries(ms.map((m) => [m.id, m]))))!;
    expect(d.axes).toHaveLength(1);
    expect(d.axes[0].long).toEqual([2]); // wall 3 is the long one
    expect(d.axes[0].short).toEqual([0]);
    expect(d.axes[0].offMm).toBeCloseTo(6.35);
    expect(d.suspects).toEqual([0, 2]); // the side walls aren't blamed
  });
  it('closes an L-shape from partial measurements', () => {
    const shape = presetShape('L', id);
    const m = measure(shape.edges[0].id, 5000);
    shape.edges[0].measurementId = m.id;
    const rs = resolveShape(shape, { [m.id]: m });
    expect(rs.closureGapMm).toBeLessThan(1e-6);
  });
});

describe('extendShape', () => {
  it('adds a bump-out onto the middle of a wall and keeps other readings', () => {
    const shape = presetShape('rect', id);
    const m1 = measure(shape.edges[1].id, 3048);
    shape.edges[1].measurementId = m1.id;
    const ms = { [m1.id]: m1 };
    const before = resolveShape(shape, ms);
    // Wall 1 runs along y=0 (heading 0); outside is -y.
    const r = extendShape(shape, ms, {}, { edgeIndex: 0, t: 1000 }, [{ x: 1000, y: -1000 }, { x: 2000, y: -1000 }], { edgeIndex: 0, t: 2000 }, id);
    if ('error' in r) throw new Error(r.error);
    const after = resolveShape(r.shape, ms);
    expect(r.shape.closed).toBe(true);
    expect(after.areaMm2 - before.areaMm2).toBeCloseTo(1e6, -2);
    expect(after.closureGapMm).toBeLessThan(1);
    expect(r.shape.edges.find((e) => e.id === shape.edges[1].id)?.measurementId).toBe(m1.id);
  });
  it('grows an open run from its end', () => {
    const shape = presetShape('fence', id);
    const n = shape.edges.length;
    const end = resolveShape(shape, {}).vertices[n];
    const r = extendShape(shape, {}, {}, { edgeIndex: n - 1, t: shape.edges[n - 1].lengthMm }, [{ x: end.x + 2000, y: end.y }], null, id);
    if ('error' in r) throw new Error(r.error);
    expect(r.shape.edges).toHaveLength(n + 1);
  });
  it('refuses to finish where it started', () => {
    const shape = presetShape('rect', id);
    const r = extendShape(shape, {}, {}, { edgeIndex: 0, t: 1000 }, [{ x: 1000, y: -500 }], { edgeIndex: 0, t: 1000 }, id);
    expect('error' in r).toBe(true);
  });
});

describe('applyOp', () => {
  const setup = () => {
    let doc = applyOp(null, env({ type: 'createProject', name: 'Smith', unitSystem: 'imperial' }));
    doc = applyOp(doc, env({ type: 'createSpace', spaceId: 's1', name: 'Kitchen', kind: 'room' }));
    const shape = presetShape('rect', id);
    doc = applyOp(doc, env({ type: 'setShape', spaceId: 's1', shape }));
    return { doc, shape };
  };

  it('records a measurement, retake supersedes, undo restores', () => {
    let { doc, shape } = setup();
    const e0 = shape.edges[0].id;
    const a = measure(e0, 3000);
    const b = measure(e0, 3010);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: a }));
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: b }));
    const s = doc.spaces.s1;
    expect(s.shape!.edges[0].measurementId).toBe(b.id);
    expect(s.measurements[b.id].supersedes).toBe(a.id);
    doc = applyOp(doc, env({ type: 'removeMeasurement', spaceId: 's1', measurementId: b.id }));
    expect(doc.spaces.s1.shape!.edges[0].measurementId).toBe(a.id);
  });

  it('flag lifecycle: office raises, field retake resolves, undo re-opens', () => {
    let { doc, shape } = setup();
    const a = measure(shape.edges[1].id, 3000);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: a }));
    const flag = { id: 'f1', measurementId: a.id, target: a.target, raisedBy: 'Marcus', raisedAt: 1, reason: 'looks-off' as const, status: 'open' as const };
    doc = applyOp(doc, env({ type: 'raiseFlag', spaceId: 's1', flag }, 'office'));
    expect(nextTarget(doc.spaces.s1)).toEqual(a.target); // flagged goes first
    const b = measure(shape.edges[1].id, 3100);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: b }));
    expect(doc.spaces.s1.flags.f1.status).toBe('remeasured');
    expect(doc.spaces.s1.flags.f1.resolvingMeasurementId).toBe(b.id);
    doc = applyOp(doc, env({ type: 'removeMeasurement', spaceId: 's1', measurementId: b.id }));
    expect(doc.spaces.s1.flags.f1.status).toBe('open');
  });

  it('removing a wall of a closed shape opens that side without moving the rest', () => {
    let { doc, shape } = setup();
    const m = measure(shape.edges[0].id, 5000);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: m }));
    const before = resolveShape(doc.spaces.s1.shape!, doc.spaces.s1.measurements);
    doc = applyOp(doc, env({ type: 'removeEdge', spaceId: 's1', edgeId: shape.edges[1].id }));
    const s = doc.spaces.s1;
    expect(s.shape!.closed).toBe(false);
    expect(s.shape!.edges.map((e) => e.id)).toEqual([shape.edges[2].id, shape.edges[3].id, shape.edges[0].id]);
    const after = resolveShape(s.shape!, s.measurements);
    // Wall 3 (formerly inferred) keeps the length it had while closed.
    expect(after.edges[0].lengthMm).toBeCloseTo(before.edges[2].lengthMm);
    expect(s.measurements[m.id]).toBeDefined();
    // Middle wall of an open run can't be removed
    expect(() => applyOp(doc, env({ type: 'removeEdge', spaceId: 's1', edgeId: shape.edges[3].id }))).toThrow();
  });

  it('deletes a space, and a deleted job refuses further edits', () => {
    let { doc } = setup();
    doc = applyOp(doc, env({ type: 'createSpace', spaceId: 's2', name: 'Deck', kind: 'deck' }));
    doc = applyOp(doc, env({ type: 'deleteSpace', spaceId: 's1' }));
    expect(doc.spaceOrder).toEqual(['s2']);
    expect(doc.spaces.s1).toBeUndefined();
    doc = applyOp(doc, env({ type: 'deleteProject' }));
    expect(doc.deleted).toBe(true);
    expect(() => applyOp(doc, env({ type: 'renameSpace', spaceId: 's2', name: 'X' }))).toThrow();
    expect(roleMayApply('office', 'deleteProject')).toBe(false);
    doc = applyOp(doc, env({ type: 'restoreProject' }));
    expect(doc.deleted).toBe(false);
    expect(doc.spaceOrder).toEqual(['s2']); // comes back as it was
    expect(() => applyOp(doc, env({ type: 'restoreProject' }))).toThrow();
  });

  it('sliding a window along its wall clears its old from-corner reading', () => {
    let { doc, shape } = setup();
    const e0 = shape.edges[0].id;
    const feature = { id: 'w1', type: 'window' as const, anchor: { edgeId: e0, offsetMm: 600 }, sizes: { width: 900 }, dims: { offset: null, width: null }, props: {} };
    doc = applyOp(doc, env({ type: 'addFeature', spaceId: 's1', feature }));
    const m = { ...measure('w1', 610), target: { kind: 'feature' as const, refId: 'w1', dim: 'offset' } };
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: m }));
    expect(doc.spaces.s1.features.w1.dims.offset).toBe(m.id);
    doc = applyOp(doc, env({ type: 'moveFeature', spaceId: 's1', featureId: 'w1', anchor: { edgeId: e0, offsetMm: 1500 } }));
    expect(doc.spaces.s1.features.w1.dims.offset).toBeNull();
    expect((doc.spaces.s1.features.w1.anchor as { offsetMm: number }).offsetMm).toBe(1500);
  });

  it('clears one item (retakes included) or every reading in the space', () => {
    let { doc, shape } = setup();
    const [e0, e1] = [shape.edges[0].id, shape.edges[1].id];
    for (const [e, v] of [[e0, 3000], [e0, 3010], [e1, 2000]] as const) {
      doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: measure(e, v) }));
    }
    doc = applyOp(doc, env({ type: 'clearMeasurements', spaceId: 's1', target: { kind: 'edge', refId: e0 } }));
    let s = doc.spaces.s1;
    expect(s.shape!.edges[0].measurementId).toBeNull(); // not "back to 3000"
    expect(Object.keys(s.measurements)).toHaveLength(1);
    doc = applyOp(doc, env({ type: 'clearMeasurements', spaceId: 's1' }));
    s = doc.spaces.s1;
    expect(Object.keys(s.measurements)).toHaveLength(0);
    expect(s.shape!.edges.every((e) => e.measurementId === null)).toBe(true);
    expect(() => applyOp(doc, env({ type: 'clearMeasurements', spaceId: 's1' }))).toThrow();
  });

  it('setting a size by eye replaces that reading', () => {
    let { doc, shape } = setup();
    const feature = { id: 'w2', type: 'window' as const, anchor: { edgeId: shape.edges[0].id, offsetMm: 600 }, sizes: { width: 900, sill: 900 }, dims: { offset: null, width: null, sill: null }, props: {} };
    doc = applyOp(doc, env({ type: 'addFeature', spaceId: 's1', feature }));
    const m = { ...measure('w2', 950), target: { kind: 'feature' as const, refId: 'w2', dim: 'sill' } };
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: m }));
    doc = applyOp(doc, env({ type: 'setFeatureSizes', spaceId: 's1', featureId: 'w2', sizes: { sill: 1100 } }));
    const f = doc.spaces.s1.features.w2;
    expect(f.dims.sill).toBeNull();
    expect(f.sizes.sill).toBe(1100);
    expect(f.dims.width).toBeNull(); // untouched dims stay as they were
  });

  it('restoreSpace undoes to a snapshot but keeps newer office flags', () => {
    let { doc, shape } = setup();
    const a = measure(shape.edges[0].id, 3000);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: a }));
    const snap = doc.spaces.s1;
    const flag = { id: 'fx', measurementId: a.id, target: a.target, raisedBy: 'Marcus', raisedAt: 1, reason: 'looks-off' as const, status: 'open' as const };
    doc = applyOp(doc, env({ type: 'raiseFlag', spaceId: 's1', flag }, 'office'));
    const b = measure(shape.edges[1].id, 2000);
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: b }));
    doc = applyOp(doc, env({ type: 'restoreSpace', spaceId: 's1', space: snap }));
    expect(doc.spaces.s1.measurements[b.id]).toBeUndefined(); // the field's change is undone
    expect(doc.spaces.s1.measurements[a.id]).toBeDefined();
    expect(doc.spaces.s1.flags.fx.status).toBe('open');
  });

  it('is good to go only when everything is measured and the walls meet', () => {
    let { doc, shape } = setup();
    const vals = [5000, 3000, 5000, 3000];
    for (let i = 0; i < 3; i++) doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: measure(shape.edges[i].id, vals[i]) }));
    expect(spaceStatus(doc.spaces.s1).ready).toBe(false); // one wall left
    const bad = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: measure(shape.edges[3].id, 3020) }));
    expect(spaceStatus(bad.spaces.s1)).toMatchObject({ ready: false, closes: false });
    doc = applyOp(doc, env({ type: 'recordMeasurement', spaceId: 's1', measurement: measure(shape.edges[3].id, 3000) }));
    expect(spaceStatus(doc.spaces.s1)).toMatchObject({ ready: true, closes: true, measured: 4, total: 4 });
  });

  it('enforces roles', () => {
    expect(roleMayApply('office', 'raiseFlag')).toBe(true);
    expect(roleMayApply('office', 'recordMeasurement')).toBe(false);
    expect(roleMayApply('field', 'raiseFlag')).toBe(false);
    expect(roleMayApply('field', 'setShape')).toBe(true);
  });

  it('replay skips invalid ops and keeps going', () => {
    const errors: string[] = [];
    const doc = replay(
      [
        env({ type: 'createProject', name: 'X', unitSystem: 'metric' }),
        env({ type: 'renameSpace', spaceId: 'nope', name: 'Y' }),
        env({ type: 'createSpace', spaceId: 's1', name: 'Deck', kind: 'deck' }),
      ],
      null,
      (op) => errors.push(op.type),
    );
    expect(errors).toEqual(['renameSpace']);
    expect(doc!.spaceOrder).toEqual(['s1']);
  });

  it('validates ops with zod', () => {
    const op = env({ type: 'createSpace', spaceId: 's1', name: 'Deck', kind: 'deck' });
    expect(OpZ.safeParse(op).success).toBe(true);
    expect(OpZ.safeParse({ ...op, kind: 'castle' }).success).toBe(false);
  });
});
