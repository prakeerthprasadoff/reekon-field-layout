import { z } from 'zod';

// ---------- Entities ----------
// World coordinates are millimetres, y grows downward (same as screen), heading 0deg = +x,
// 90deg = +y. So "turn right" on screen is +90.

export const UnitSystemZ = z.enum(['imperial', 'metric']);
export const SpaceKindZ = z.enum(['room', 'deck', 'patio', 'fence', 'other']);
export const SourceZ = z.enum(['ble-tape', 'caliper', 'manual', 'from-plan']);
export const RoleZ = z.enum(['field', 'office']);

export const EdgeZ = z.object({
  id: z.string(),
  headingDeg: z.number(),
  headingSource: z.enum(['drawn', 'preset', 'turn', 'instrument']),
  lengthMm: z.number().positive(), // provisional until measured
  measurementId: z.string().nullable(),
});

export const ShapeZ = z.object({
  origin: z.object({ x: z.number(), y: z.number() }),
  closed: z.boolean(),
  edges: z.array(EdgeZ),
});

export const FeatureTypeZ = z.enum(['door', 'window', 'opening', 'post', 'steps', 'wall']);

export const FeatureZ = z.object({
  id: z.string(),
  type: FeatureTypeZ,
  /** On-edge features: offset from the edge's start vertex. Free features (post, wall): x/y. */
  anchor: z.union([
    z.object({ edgeId: z.string(), offsetMm: z.number() }),
    z.object({ x: z.number(), y: z.number() }),
  ]),
  /** Provisional sizes (mm) per dimension, used until a measurement exists. */
  sizes: z.record(z.string(), z.number()),
  /** dimension name -> measurement id */
  dims: z.record(z.string(), z.string().nullable()),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const TargetZ = z.object({
  kind: z.enum(['edge', 'feature']),
  refId: z.string(),
  dim: z.string().optional(), // feature dimension, e.g. "width"
});

export const MeasurementZ = z.object({
  id: z.string(),
  target: TargetZ,
  valueMm: z.number().nonnegative(),
  raw: z.string(),
  angleDeg: z.number().optional(),
  source: SourceZ,
  precisionMm: z.number().positive(),
  takenAt: z.number(),
  takenBy: z.string(),
  deviceId: z.string(),
  /** Set by applyOp: the measurement this one replaced (retake history). */
  supersedes: z.string().nullable().default(null),
});

export const FlagReasonZ = z.enum(['doesnt-match-plan', 'closure-error', 'looks-off', 'other']);

export const FlagZ = z.object({
  id: z.string(),
  measurementId: z.string(),
  target: TargetZ,
  raisedBy: z.string(),
  raisedAt: z.number(),
  reason: FlagReasonZ,
  note: z.string().optional(),
  status: z.enum(['open', 'remeasured', 'confirmed', 'withdrawn']),
  resolvedBy: z.string().optional(),
  resolvedAt: z.number().optional(),
  resolvingMeasurementId: z.string().optional(),
});

export const SpaceZ = z.object({
  id: z.string(),
  name: z.string(),
  kind: SpaceKindZ,
  createdAt: z.number(),
  shape: ShapeZ.nullable(),
  features: z.record(z.string(), FeatureZ),
  measurements: z.record(z.string(), MeasurementZ),
  flags: z.record(z.string(), FlagZ),
});

export const ProjectDocZ = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().optional(),
  unitSystem: UnitSystemZ,
  createdAt: z.number(),
  spaces: z.record(z.string(), SpaceZ),
  spaceOrder: z.array(z.string()),
  /** Tombstone: the op log is append-only, so deleting a job marks it instead of erasing it. */
  deleted: z.boolean().optional(),
});

// ---------- Ops ----------

const sp = { spaceId: z.string() };

export const OpBodyZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('createProject'), name: z.string().min(1), address: z.string().optional(), unitSystem: UnitSystemZ }),
  z.object({ type: z.literal('createSpace'), ...sp, name: z.string().min(1), kind: SpaceKindZ }),
  z.object({ type: z.literal('renameSpace'), ...sp, name: z.string().min(1) }),
  z.object({ type: z.literal('deleteSpace'), ...sp }),
  z.object({ type: z.literal('deleteProject') }),
  z.object({ type: z.literal('restoreProject') }),
  z.object({ type: z.literal('setShape'), ...sp, shape: ShapeZ }),
  z.object({ type: z.literal('addEdge'), ...sp, edge: EdgeZ }),
  z.object({ type: z.literal('updateEdge'), ...sp, edgeId: z.string(), headingDeg: z.number().optional(), lengthMm: z.number().positive().optional() }),
  z.object({ type: z.literal('removeLastEdge'), ...sp }),
  z.object({ type: z.literal('removeEdge'), ...sp, edgeId: z.string() }),
  z.object({ type: z.literal('setClosed'), ...sp, closed: z.boolean() }),
  z.object({ type: z.literal('addFeature'), ...sp, feature: FeatureZ }),
  z.object({ type: z.literal('moveFeature'), ...sp, featureId: z.string(), anchor: FeatureZ.shape.anchor }),
  z.object({ type: z.literal('deleteFeature'), ...sp, featureId: z.string() }),
  /** Set provisional sizes by eye (e.g. dragging a window up in the wall view). */
  z.object({ type: z.literal('setFeatureSizes'), ...sp, featureId: z.string(), sizes: z.record(z.string(), z.number().nonnegative()) }),
  z.object({ type: z.literal('recordMeasurement'), ...sp, measurement: MeasurementZ }),
  z.object({ type: z.literal('removeMeasurement'), ...sp, measurementId: z.string() }),
  /** Wipe readings back to unmeasured: one item (with its retakes) or, without target, the whole space. */
  z.object({ type: z.literal('clearMeasurements'), ...sp, target: TargetZ.optional() }),
  z.object({ type: z.literal('confirmFlag'), ...sp, flagId: z.string() }),
  /** Undo: put a space back exactly as it was (field only). */
  z.object({ type: z.literal('restoreSpace'), ...sp, space: SpaceZ }),
  // office-only
  z.object({ type: z.literal('raiseFlag'), ...sp, flag: FlagZ }),
  z.object({ type: z.literal('withdrawFlag'), ...sp, flagId: z.string() }),
]);

export const OpZ = z.intersection(
  z.object({
    opId: z.string(),
    projectId: z.string(),
    clientId: z.string(),
    role: RoleZ,
    author: z.string(),
    ts: z.number(),
  }),
  OpBodyZ,
);

export const OFFICE_OPS = new Set(['raiseFlag', 'withdrawFlag'] as const);

export type UnitSystemT = z.infer<typeof UnitSystemZ>;
export type SpaceKind = z.infer<typeof SpaceKindZ>;
export type Source = z.infer<typeof SourceZ>;
export type Role = z.infer<typeof RoleZ>;
export type Edge = z.infer<typeof EdgeZ>;
export type Shape = z.infer<typeof ShapeZ>;
export type FeatureType = z.infer<typeof FeatureTypeZ>;
export type Feature = z.infer<typeof FeatureZ>;
export type Target = z.infer<typeof TargetZ>;
export type Measurement = z.infer<typeof MeasurementZ>;
export type FlagReason = z.infer<typeof FlagReasonZ>;
export type Flag = z.infer<typeof FlagZ>;
export type Space = z.infer<typeof SpaceZ>;
export type ProjectDoc = z.infer<typeof ProjectDocZ>;
export type OpBody = z.infer<typeof OpBodyZ>;
export type Op = z.infer<typeof OpZ>;
/** An op the server has accepted and sequenced. */
export type SeqOp = Op & { serverSeq: number };

/** Ops with a given `type`, used for typed builders. */
export type OpOf<T extends OpBody['type']> = Extract<OpBody, { type: T }>;
