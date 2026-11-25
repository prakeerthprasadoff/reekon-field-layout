import { OFFICE_OPS, type Flag, type Op, type ProjectDoc, type Role, type Space, type Target } from './schema';
import { measurementForTarget, resolveShape, sameTarget } from './geometry';

export class OpError extends Error {}

export function roleMayApply(role: Role, type: Op['type']): boolean {
  const officeOp = (OFFICE_OPS as Set<string>).has(type);
  return role === 'office' ? officeOp : !officeOp;
}

function emptySpace(id: string, name: string, kind: Space['kind'], at: number): Space {
  return { id, name, kind, createdAt: at, shape: null, features: {}, measurements: {}, flags: {} };
}

/** Link (or unlink) a measurement id on whatever the target points at. Returns the new space. */
function setTargetLink(space: Space, t: Target, measurementId: string | null): Space {
  if (t.kind === 'edge') {
    if (!space.shape) throw new OpError('space has no shape');
    const edges = space.shape.edges.map((e) => (e.id === t.refId ? { ...e, measurementId } : e));
    if (!edges.some((e) => e.id === t.refId)) throw new OpError(`edge ${t.refId} not found`);
    return { ...space, shape: { ...space.shape, edges } };
  }
  const f = space.features[t.refId];
  if (!f || !t.dim) throw new OpError(`feature target ${t.refId}/${t.dim} not found`);
  return { ...space, features: { ...space.features, [f.id]: { ...f, dims: { ...f.dims, [t.dim]: measurementId } } } };
}

function mapFlags(space: Space, fn: (f: Flag) => Flag): Space {
  const flags: Record<string, Flag> = {};
  for (const [k, f] of Object.entries(space.flags)) flags[k] = fn(f);
  return { ...space, flags };
}

/** Drop measurements and flags that no longer point at an existing edge/feature. */
function pruneOrphans(space: Space): Space {
  const edgeIds = new Set(space.shape?.edges.map((e) => e.id) ?? []);
  const alive = (t: Target) => (t.kind === 'edge' ? edgeIds.has(t.refId) : !!space.features[t.refId]);
  const measurements = Object.fromEntries(Object.entries(space.measurements).filter(([, m]) => alive(m.target)));
  const flags = Object.fromEntries(Object.entries(space.flags).filter(([, f]) => alive(f.target)));
  return { ...space, measurements, flags };
}

/**
 * Pure reducer shared by device and server. Throws OpError for ops that don't make sense
 * against the current document; the server rejects those, the device drops them.
 */
export function applyOp(doc: ProjectDoc | null, op: Op): ProjectDoc {
  if (op.type === 'createProject') {
    if (doc) throw new OpError('project already exists');
    return { id: op.projectId, name: op.name, address: op.address, unitSystem: op.unitSystem, createdAt: op.ts, spaces: {}, spaceOrder: [] };
  }
  if (!doc) throw new OpError('project does not exist');
  if (op.type === 'restoreProject') {
    if (!doc.deleted) throw new OpError('job is not deleted');
    return { ...doc, deleted: false };
  }
  if (doc.deleted) throw new OpError('job was deleted');

  if (op.type === 'deleteProject') return { ...doc, deleted: true };

  if (op.type === 'createSpace') {
    if (doc.spaces[op.spaceId]) throw new OpError('space already exists');
    return {
      ...doc,
      spaces: { ...doc.spaces, [op.spaceId]: emptySpace(op.spaceId, op.name, op.kind, op.ts) },
      spaceOrder: [...doc.spaceOrder, op.spaceId],
    };
  }

  const space = doc.spaces[op.spaceId];
  if (!space) throw new OpError(`space ${op.spaceId} not found`);
  if (op.type === 'deleteSpace') {
    const { [op.spaceId]: _gone, ...spaces } = doc.spaces;
    return { ...doc, spaces, spaceOrder: doc.spaceOrder.filter((s) => s !== op.spaceId) };
  }
  const next = applySpaceOp(space, op);
  return { ...doc, spaces: { ...doc.spaces, [op.spaceId]: next } };
}

function applySpaceOp(space: Space, op: Op): Space {
  switch (op.type) {
    case 'renameSpace':
      return { ...space, name: op.name };

    case 'setShape':
      return pruneOrphans({ ...space, shape: op.shape });

    case 'addEdge': {
      const shape = space.shape ?? { origin: { x: 0, y: 0 }, closed: false, edges: [] };
      return { ...space, shape: { ...shape, edges: [...shape.edges, op.edge] } };
    }

    case 'updateEdge': {
      if (!space.shape) throw new OpError('no shape');
      const edges = space.shape.edges.map((e) =>
        e.id === op.edgeId
          ? { ...e, headingDeg: op.headingDeg ?? e.headingDeg, lengthMm: op.lengthMm ?? e.lengthMm }
          : e,
      );
      return { ...space, shape: { ...space.shape, edges } };
    }

    case 'removeLastEdge': {
      if (!space.shape || space.shape.edges.length === 0) throw new OpError('no edge to remove');
      const removed = space.shape.edges[space.shape.edges.length - 1];
      const features = Object.fromEntries(
        Object.entries(space.features).filter(([, f]) => !('edgeId' in f.anchor && f.anchor.edgeId === removed.id)),
      );
      return pruneOrphans({ ...space, features, shape: { ...space.shape, closed: false, edges: space.shape.edges.slice(0, -1) } });
    }

    case 'removeEdge': {
      // Closed shape: that side becomes the opening (walk starts after it, shape becomes open).
      // Open run: only an end wall can go (a middle wall would split the run in two).
      if (!space.shape) throw new OpError('no shape');
      const edges = space.shape.edges;
      const idx = edges.findIndex((e) => e.id === op.edgeId);
      if (idx < 0) throw new OpError('edge not found');
      const rs = resolveShape(space.shape, space.measurements);
      // Freeze inferred lengths so the remaining walls don't jump when closure inference stops.
      const baked = edges.map((e, i) => ({ ...e, lengthMm: Math.max(1, rs.edges[i].lengthMm) }));
      let next: Space['shape'];
      if (space.shape.closed) {
        next = { origin: { ...rs.vertices[idx + 1] }, closed: false, edges: [...baked.slice(idx + 1), ...baked.slice(0, idx)] };
      } else if (idx === 0) {
        next = { origin: { ...rs.vertices[1] }, closed: false, edges: baked.slice(1) };
      } else if (idx === edges.length - 1) {
        next = { ...space.shape, edges: baked.slice(0, -1) };
      } else {
        throw new OpError('Only the first or last wall of an open run can be removed');
      }
      const features = Object.fromEntries(
        Object.entries(space.features).filter(([, f]) => !('edgeId' in f.anchor && f.anchor.edgeId === op.edgeId)),
      );
      return pruneOrphans({ ...space, features, shape: next });
    }

    case 'setClosed': {
      if (!space.shape) throw new OpError('no shape');
      return { ...space, shape: { ...space.shape, closed: op.closed } };
    }

    case 'addFeature':
      if (space.features[op.feature.id]) throw new OpError('feature exists');
      return { ...space, features: { ...space.features, [op.feature.id]: op.feature } };

    case 'moveFeature': {
      const f = space.features[op.featureId];
      if (!f) throw new OpError('feature not found');
      // Sliding a door/window along its wall makes its old "from corner" reading wrong: unlink it
      // so the item goes back in the queue. The reading stays in history.
      const moved = 'edgeId' in op.anchor && 'edgeId' in f.anchor && f.dims.offset !== undefined;
      const dims = moved ? { ...f.dims, offset: null } : f.dims;
      return { ...space, features: { ...space.features, [f.id]: { ...f, anchor: op.anchor, dims } } };
    }

    case 'setFeatureSizes': {
      const f = space.features[op.featureId];
      if (!f) throw new OpError('feature not found');
      // Placing by eye overrides an old reading of that dimension, same as sliding it.
      const dims = { ...f.dims };
      for (const k of Object.keys(op.sizes)) if (k in dims) dims[k] = null;
      return { ...space, features: { ...space.features, [f.id]: { ...f, sizes: { ...f.sizes, ...op.sizes }, dims } } };
    }

    case 'deleteFeature': {
      if (!space.features[op.featureId]) throw new OpError('feature not found');
      const { [op.featureId]: _gone, ...features } = space.features;
      return pruneOrphans({ ...space, features });
    }

    case 'recordMeasurement': {
      const m = op.measurement;
      if (space.measurements[m.id]) throw new OpError('measurement exists');
      const prev = measurementForTarget(space, m.target);
      const stored = { ...m, supersedes: prev?.id ?? null };
      let s = setTargetLink(space, m.target, m.id);
      s = { ...s, measurements: { ...s.measurements, [m.id]: stored } };
      // A retake resolves any open office flag on this target.
      return mapFlags(s, (f) =>
        f.status === 'open' && sameTarget(f.target, m.target)
          ? { ...f, status: 'remeasured', resolvedBy: op.author, resolvedAt: op.ts, resolvingMeasurementId: m.id }
          : f,
      );
    }

    case 'removeMeasurement': {
      const m = space.measurements[op.measurementId];
      if (!m) throw new OpError('measurement not found');
      const current = measurementForTarget(space, m.target);
      let s = space;
      if (current?.id === m.id) {
        const restore = m.supersedes && space.measurements[m.supersedes] ? m.supersedes : null;
        s = setTargetLink(s, m.target, restore);
      }
      const { [m.id]: _gone, ...measurements } = s.measurements;
      s = { ...s, measurements };
      // Undoing a retake re-opens the flag it had resolved.
      return mapFlags(s, (f) =>
        f.resolvingMeasurementId === m.id
          ? { ...f, status: 'open', resolvedBy: undefined, resolvedAt: undefined, resolvingMeasurementId: undefined }
          : f,
      );
    }

    case 'clearMeasurements': {
      const hit = (t: Target) => !op.target || sameTarget(t, op.target);
      const removed = new Set(Object.values(space.measurements).filter((m) => hit(m.target)).map((m) => m.id));
      if (removed.size === 0) throw new OpError('nothing to clear');
      const unlink = (id: string | null) => (id && removed.has(id) ? null : id);
      const shape = space.shape && { ...space.shape, edges: space.shape.edges.map((e) => ({ ...e, measurementId: unlink(e.measurementId) })) };
      const features = Object.fromEntries(Object.entries(space.features).map(([k, f]) => [
        k, { ...f, dims: Object.fromEntries(Object.entries(f.dims).map(([d, id]) => [d, unlink(id)])) },
      ]));
      const measurements = Object.fromEntries(Object.entries(space.measurements).filter(([id]) => !removed.has(id)));
      // Open office flags stay open: the item still needs a reading, and the next one resolves them.
      return { ...space, shape, features, measurements };
    }

    case 'restoreSpace': {
      if (op.space.id !== space.id) throw new OpError('snapshot is for another space');
      // Keep office flags raised since the snapshot: they're Marcus's, not the field's to undo.
      const flags = { ...op.space.flags };
      for (const [k, f] of Object.entries(space.flags)) {
        if (!flags[k] && op.space.measurements[f.measurementId]) flags[k] = f;
      }
      return { ...op.space, flags };
    }

    case 'confirmFlag': {
      const f = space.flags[op.flagId];
      if (!f || f.status !== 'open') throw new OpError('no open flag');
      return { ...space, flags: { ...space.flags, [f.id]: { ...f, status: 'confirmed', resolvedBy: op.author, resolvedAt: op.ts } } };
    }

    case 'raiseFlag': {
      const m = space.measurements[op.flag.measurementId];
      if (!m) throw new OpError('flagged measurement not found');
      if (space.flags[op.flag.id]) throw new OpError('flag exists');
      const flag: Flag = { ...op.flag, target: m.target, status: 'open' };
      return { ...space, flags: { ...space.flags, [flag.id]: flag } };
    }

    case 'withdrawFlag': {
      const f = space.flags[op.flagId];
      if (!f || f.status !== 'open') throw new OpError('no open flag');
      return { ...space, flags: { ...space.flags, [f.id]: { ...f, status: 'withdrawn', resolvedBy: op.author, resolvedAt: op.ts } } };
    }

    default:
      throw new OpError(`unhandled op ${(op as Op).type}`);
  }
}

/** Fold a list of ops, skipping (and reporting) any that fail. */
export function replay(ops: Op[], start: ProjectDoc | null = null, onError?: (op: Op, e: unknown) => void): ProjectDoc | null {
  let doc = start;
  for (const op of ops) {
    try { doc = applyOp(doc, op); } catch (e) { onError?.(op, e); }
  }
  return doc;
}
