// Dana's field screen. One rule drives the whole design: a tape reading is only a number,
// so the app always shows exactly where the next reading will land (the orange "armed" target),
// fills it, and moves on. Taps are for re-aiming, never required.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { useKeepAwake } from 'expo-keep-awake';
import {
  FEATURE_DIMS, FEATURE_LABEL, ON_EDGE_TYPES, PRESET_LABEL, diagnoseClosure, dist, distToSegment, featureSize, formatLength,
  listTargets, measurementForTarget, nextTarget, normalizeDeg, parseLength, presetShape, projectOnSegment,
  extendShape, resolveShape, sameTarget, spaceStatus, shapeFromCorners, snapAngle, targetLabel, unitVector, type BoundaryHit,
  type Feature, type FeatureType, type Measurement, type PresetKind, type Pt, type Space, type Target,
} from '@field/shared';
import { LayoutCanvas, type CanvasHandle } from '@/canvas/LayoutCanvas';
import { ElevationSheet } from '@/field/ElevationSheet';
import { Keypad } from '@/field/Keypad';
import { simulatedTape, useTape, type Reading } from '@/field/tape';
import { closureLines, sourceLabel, timeAgo } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { newId } from '@/lib/storage';
import { commit, openProject, sendPresence, useProjectDoc, useSync } from '@/sync/engine';
import type { OpBody } from '@field/shared';
import { Btn, Chip, SyncPill } from '@/ui/components';
import { color, radius, space as sp, touch, type } from '@/ui/theme';

type Mode = 'measure' | 'add' | 'shape' | 'draw' | 'trace';
const GRID = 304.8;
const FEATURE_TYPES: FeatureType[] = ['door', 'window', 'steps'];

const UNDO_LABEL: Partial<Record<OpBody['type'], string>> = {
  recordMeasurement: 'reading', setShape: 'shape change', addEdge: 'wall', removeEdge: 'wall removal', removeLastEdge: 'wall removal',
  setClosed: 'closing the shape', addFeature: 'adding it', moveFeature: 'the move', setFeatureSizes: 'the move', deleteFeature: 'the delete',
  clearMeasurements: 'the clear', removeMeasurement: 'the clear', confirmFlag: 'the confirmation',
};

const spoken = (raw: string) => raw.replace(/'/g, ' feet ').replace(/"/g, ' inches').replace(/\s+/g, ' ').trim();

export default function FieldSpace() {
  const { pid, sid, start } = useLocalSearchParams<{ pid: string; sid: string; start?: string }>();
  const router = useRouter();
  useKeepAwake();
  const doc = useProjectDoc(pid);
  const space = doc?.spaces[sid];
  const unit = doc?.unitSystem ?? 'imperial';
  const { name, clientId, speak, setSpeak } = useSettings();
  const tape = useTape();
  const canvas = useRef<CanvasHandle>(null);

  const [mode, setMode] = useState<Mode>(start === 'draw' ? 'draw' : start === 'trace' ? 'trace' : 'measure');
  const [armed, setArmed] = useState<Target | null>(null);
  const [tray, setTray] = useState<Reading[]>([]);
  const [snack, setSnack] = useState<{ mid: string; text: string; reading: Reading; target: Target } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [corners, setCorners] = useState<Pt[]>([]);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [placing, setPlacing] = useState<FeatureType | null>(null);
  const [heading, setHeading] = useState(0);
  const [keypad, setKeypad] = useState(false);
  const [tapeMenu, setTapeMenu] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const angleRef = useRef<number | null>(null);
  // Wall elevation sheet for one door/window. While open, readings walk that feature's own dims.
  const [elevation, setElevation] = useState<string | null>(null);
  // Extend mode (inside draw): start on the plan, add corners, end on the plan, confirm.
  const [extending, setExtending] = useState(false);
  const [ext, setExt] = useState<{ a: BoundaryHit & { p: Pt }; b: (BoundaryHit & { p: Pt }) | null } | null>(null);
  const elevationRef = useRef<string | null>(null);
  elevationRef.current = elevation;

  useEffect(() => { if (pid) openProject(pid); }, [pid]);

  const targets = useMemo(() => (space ? listTargets(space) : []), [space]);
  const rs = useMemo(() => (space?.shape?.edges.length ? resolveShape(space.shape, space.measurements) : null), [space]);
  const openFlags = useMemo(() => (space ? Object.values(space.flags).filter((f) => f.status === 'open') : []), [space]);
  const status = useMemo(() => (space ? spaceStatus(space) : null), [space]);
  // The moment a space checks out (all measured, walls meet, no flags), say so once.
  const wasReady = useRef<boolean | null>(null);
  useEffect(() => {
    if (!status) return;
    if (wasReady.current === false && status.ready) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (speak) { Speech.stop(); Speech.speak('All measurements check out.', { rate: 1.05 }); }
    }
    wasReady.current = status.ready;
  }, [status, speak]);

  // Keep the armed target valid; auto-arm the next unmeasured thing when idle in measure mode.
  useEffect(() => {
    if (!space || mode !== 'measure') return;
    if (armed && targets.some((t) => sameTarget(t.target, armed))) return;
    setArmed(nextTarget(space));
  }, [space, targets, armed, mode]);

  useEffect(() => { if (pid && sid) sendPresence(pid, sid, mode === 'measure' ? armed : null); }, [pid, sid, armed, mode]);
  useEffect(() => () => { if (pid) sendPresence(pid, null, null); }, [pid]);

  useEffect(() => { if (!snack) return; const t = setTimeout(() => setSnack(null), 4500); return () => clearTimeout(t); }, [snack]);
  useEffect(() => { if (!confirmDel) return; const t = setTimeout(() => setConfirmDel(null), 3500); return () => clearTimeout(t); }, [confirmDel]);
  useEffect(() => { setConfirmDel(null); }, [armed]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);

  // The server refused a change and the app rolled it back: say so instead of silently reverting.
  const lastReject = useSync((s) => s.lastReject);
  useEffect(() => {
    if (!lastReject || Date.now() - lastReject.at > 5000) return;
    const outdated = lastReject.reason.startsWith('invalid op');
    setToast(outdated ? "Didn't save: the sync server is out of date. Restart it." : `Didn't save: ${lastReject.reason}`);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, [lastReject]);

  const freshSpace = (): Space | undefined => useSync.getState().docs[pid!]?.view?.spaces[sid!];

  // ---------- Undo ----------
  // Every change goes through save(). The first change in a tick snapshots the space; changes
  // made together (a traced wall + its reading, an extension + moved doors) undo as one step.
  // Undo puts the snapshot back with one restoreSpace op, so it syncs like any other edit.
  const undoStack = useRef<{ label: string; snap: Space }[]>([]);
  const redoStack = useRef<{ label: string; snap: Space }[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const syncDepths = () => { setUndoDepth(undoStack.current.length); setRedoDepth(redoStack.current.length); };
  const batchOpen = useRef(false);
  const save = (body: OpBody): boolean => {
    const before = freshSpace();
    const ok = commit(pid!, body);
    if (ok && before && !batchOpen.current) {
      batchOpen.current = true;
      queueMicrotask(() => { batchOpen.current = false; });
      undoStack.current.push({ label: UNDO_LABEL[body.type] ?? 'last change', snap: before });
      if (undoStack.current.length > 40) undoStack.current.shift();
      redoStack.current = []; // a new change ends the redo trail
      syncDepths();
    }
    return ok;
  };
  // Undo and redo both restore a snapshot; each pushes the current state onto the other stack.
  const travel = (from: typeof undoStack, to: typeof undoStack, verb: string) => {
    const e = from.current.pop();
    const now = freshSpace();
    if (!e || !now) { syncDepths(); return; }
    if (commit(pid!, { type: 'restoreSpace', spaceId: sid!, space: e.snap })) {
      to.current.push({ label: e.label, snap: now });
      setSnack(null); setArmed(null); setEditing(false);
      setToast(`${verb} ${e.label}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      from.current.push(e);
    }
    syncDepths();
  };
  const undoLast = () => travel(undoStack, redoStack, 'Undid');
  const redoLast = () => travel(redoStack, undoStack, 'Redid');

  const confirmFeedback = useCallback((label: string, raw: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (speak) { Speech.stop(); Speech.speak(`${label}. ${spoken(raw)}`, { rate: 1.05 }); }
  }, [speak]);

  // ---------- Placing a reading ----------
  const placeReading = useCallback((r: Reading, target: Target): boolean => {
    const parsed = parseLength(r.raw, unit);
    if (!parsed) { setToast(`Couldn't read "${r.raw}"`); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); return false; }
    const m: Measurement = {
      id: newId(), target, valueMm: parsed.mm, raw: r.raw, angleDeg: r.angleDeg, source: r.source,
      precisionMm: parsed.precisionMm, takenAt: Date.now(), takenBy: name || 'Unknown', deviceId: clientId, supersedes: null,
    };
    if (!save({ type: 'recordMeasurement', spaceId: sid!, measurement: m })) return false;
    const fresh = freshSpace();
    const label = fresh ? targetLabel(fresh, target) : 'Saved';
    confirmFeedback(label, r.raw);
    setSnack({ mid: m.id, text: `${label}  ←  ${r.raw}`, reading: r, target });
    const ev = elevationRef.current;
    if (fresh && ev && target.kind === 'feature' && target.refId === ev) {
      // Stay on this door/window: next unmeasured dimension, or keep the current one.
      const f = fresh.features[ev];
      const dims = f ? FEATURE_DIMS[f.type].filter((d) => d.key !== 'offset' || 'edgeId' in f.anchor) : [];
      const i = dims.findIndex((d) => d.key === target.dim);
      const nextDim = [...dims.slice(i + 1), ...dims.slice(0, i)].find((d) => !f!.dims[d.key]);
      setArmed(nextDim ? { kind: 'feature', refId: ev, dim: nextDim.key } : target);
    } else {
      setArmed(fresh ? nextTarget(fresh, target) : null);
    }
    return true;
  }, [unit, name, clientId, pid, sid, confirmFeedback]);

  const traceReading = useCallback((r: Reading) => {
    const parsed = parseLength(r.raw, unit);
    if (!parsed) { setToast(`Couldn't read "${r.raw}"`); return; }
    let h = heading;
    let source: 'turn' | 'instrument' = 'turn';
    if (r.angleDeg !== undefined) {
      if (angleRef.current === null) angleRef.current = r.angleDeg; // first wall sets the reference
      h = snapAngle(normalizeDeg(r.angleDeg - angleRef.current), 90, 3);
      source = 'instrument';
    }
    const edgeId = newId();
    if (!save({ type: 'addEdge', spaceId: sid!, edge: { id: edgeId, headingDeg: h, headingSource: source, lengthMm: parsed.mm, measurementId: null } })) return;
    const m: Measurement = {
      id: newId(), target: { kind: 'edge', refId: edgeId }, valueMm: parsed.mm, raw: r.raw, angleDeg: r.angleDeg,
      source: r.source, precisionMm: parsed.precisionMm, takenAt: Date.now(), takenBy: name || 'Unknown', deviceId: clientId, supersedes: null,
    };
    save({ type: 'recordMeasurement', spaceId: sid!, measurement: m });
    setHeading(h);
    const n = freshSpace()?.shape?.edges.length ?? 0;
    confirmFeedback(`Wall ${n}`, r.raw);
    setSnack({ mid: m.id, text: `Wall ${n}  ←  ${r.raw}${r.angleDeg !== undefined ? `  ·  ${Math.round(h)}°` : ''}`, reading: r, target: m.target });
    setTimeout(() => canvas.current?.fit(), 50);
  }, [unit, heading, pid, sid, name, clientId, confirmFeedback]);

  const onReading = useCallback((r: Reading) => {
    if (mode === 'trace') return traceReading(r);
    if (mode === 'measure' && armed) { placeReading(r, armed); return; }
    setTray((t) => [...t, r]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [mode, armed, traceReading, placeReading]);

  useEffect(() => simulatedTape.onReading(onReading), [onReading]);

  // ---------- Tape simulator ----------
  const nominalFor = (): number => {
    if (mode === 'trace') return (8 + Math.random() * 8) * GRID;
    const t = armed ?? null;
    if (!t || !space) return 10 * GRID;
    if (t.kind === 'edge') {
      const i = rs?.edges.findIndex((e) => e.id === t.refId) ?? -1;
      if (!rs || i < 0) return 10 * GRID;
      const L = rs.edges[i].lengthMm;
      // Exact/demo: a wall the other walls already pin down gets exactly the length that closes
      // the shape. A wall that's still free gets a believable size near the sketch (+/- 18").
      if (useTape.getState().exact && wallIsFree(i)) {
        const eighth = 25.4 / 8;
        return Math.max(GRID, Math.round((L + (Math.random() - 0.5) * 36 * 25.4) / eighth) * eighth);
      }
      return L;
    }
    const f = space.features[t.refId];
    return f && t.dim ? featureSize(f, t.dim, space.measurements).mm : 900;
  };
  /** Could wall i take any length and the shape still close, using the other unmeasured walls? */
  const wallIsFree = (i: number): boolean => {
    if (!rs || !rs.closed) return true;
    const ui = unitVector(rs.edges[i].headingDeg);
    let a = 0, b = 0, d = 0;
    rs.edges.forEach((e, j) => {
      if (j === i || e.status === 'measured') return;
      const u = unitVector(e.headingDeg);
      a += u.x * u.x; b += u.x * u.y; d += u.y * u.y;
    });
    if (a * d - b * b > 1e-3) return true; // remaining walls span both directions
    if (a + d < 1e-6) return false; // nothing left to absorb a change
    // One direction left: free only if wall i is parallel to it.
    const vx = a >= d ? a : b, vy = a >= d ? b : d;
    return Math.abs(ui.x * vy - ui.y * vx) / Math.hypot(vx, vy) < 0.05;
  };
  const pressTape = () => simulatedTape.press(nominalFor(), unit, 37 + heading);

  // ---------- Targets ----------
  const onLabelPress = (t: Target) => {
    if (mode === 'add' && placing && t.kind === 'edge' && ON_EDGE_TYPES.includes(placing)) {
      const e = rs?.edges.find((x) => x.id === t.refId);
      if (e) addFeatureOnEdge(placing, e.id, e.lengthMm / 2);
      return;
    }
    if (tray.length) {
      const [first, ...rest] = tray;
      if (placeReading(first, t)) setTray(rest);
      return;
    }
    setArmed(t);
    if (mode !== 'measure') setMode('measure');
    Haptics.selectionAsync();
  };

  const step = (dir: 1 | -1) => {
    if (!targets.length) return;
    const i = armed ? targets.findIndex((t) => sameTarget(t.target, armed)) : -1;
    setArmed(targets[(i + dir + targets.length) % targets.length].target);
    Haptics.selectionAsync();
  };

  // ---------- Features ----------
  const addFeatureOnEdge = (ft: FeatureType, edgeId: string, centerMm: number) => {
    const dims = FEATURE_DIMS[ft];
    const width = dims.find((d) => d.key === 'width')?.defaultMm ?? 900;
    const f: Feature = {
      id: newId(), type: ft, anchor: { edgeId, offsetMm: Math.max(0, centerMm - width / 2) },
      sizes: Object.fromEntries(dims.filter((d) => d.key !== 'offset').map((d) => [d.key, d.defaultMm])),
      dims: Object.fromEntries(dims.map((d) => [d.key, null])),
      props: ft === 'steps' ? { treads: 3 } : {},
    };
    finishFeature(f);
  };

  const addFreeFeature = (ft: FeatureType, p: Pt) => {
    const dims = FEATURE_DIMS[ft];
    const f: Feature = {
      id: newId(), type: ft, anchor: { x: p.x, y: p.y },
      sizes: Object.fromEntries(dims.map((d) => [d.key, d.defaultMm])),
      dims: Object.fromEntries(dims.map((d) => [d.key, null])),
      props: ft === 'wall' ? { headingDeg: 0 } : {},
    };
    finishFeature(f);
  };

  const finishFeature = (f: Feature) => {
    if (!save({ type: 'addFeature', spaceId: sid!, feature: f })) return;
    const firstDim = FEATURE_DIMS[f.type].find((d) => d.key !== 'offset' || 'edgeId' in f.anchor)!;
    setPlacing(null);
    setMode('measure');
    setArmed({ kind: 'feature', refId: f.id, dim: firstDim.key });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if ('edgeId' in f.anchor) setElevation(f.id); // straight into the wall view to place it properly
  };

  // ---------- Canvas taps ----------
  const nearestEdge = (p: Pt, tolPt: number) => {
    if (!rs) return null;
    const tol = tolPt / (canvas.current?.scale() ?? 0.1);
    let best: { id: string; d: number; along: number } | null = null;
    for (const e of rs.edges) {
      const d = distToSegment(p, e.start, e.end);
      if (d < tol && (!best || d < best.d)) best = { id: e.id, d, along: projectOnSegment(p, e.start, e.end) };
    }
    return best;
  };

  const snapPoint = (p: Pt): Pt => {
    let q = { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
    const last = corners[corners.length - 1] ?? (extending ? ext?.a.p : undefined);
    if (last) {
      // Lock to horizontal/vertical when within ~8deg: most walls are square.
      const dx = q.x - last.x, dy = q.y - last.y;
      if (Math.abs(dy) < Math.abs(dx) * 0.14) q = { x: q.x, y: last.y };
      else if (Math.abs(dx) < Math.abs(dy) * 0.14) q = { x: last.x, y: q.y };
    }
    return q;
  };

  const addCorner = (p: Pt) => {
    const tol = 40 / (canvas.current?.scale() ?? 0.1);
    if (corners.length >= 3 && dist(p, corners[0]) < tol) return finishDraw(true);
    if (corners.length && dist(p, corners[corners.length - 1]) < 50) return;
    setCorners((c) => [...c, p]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const finishDraw = (closed: boolean) => {
    if (corners.length < 2 || (closed && corners.length < 3)) return;
    save({ type: 'setShape', spaceId: sid!, shape: shapeFromCorners(corners, closed, newId) });
    setCorners([]); setCursor(null); setArmed(null); setMode('measure');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => canvas.current?.fit(), 50);
  };

  /** Where a tap lands on the existing outline: corners win, else a spot on a wall (6" steps). */
  const boundaryHit = (p: Pt, tolPt: number): (BoundaryHit & { p: Pt }) | null => {
    if (!rs) return null;
    const tol = tolPt / (canvas.current?.scale() ?? 0.1);
    const n = rs.edges.length;
    const corners_ = rs.closed ? rs.vertices.slice(0, n) : rs.vertices;
    let bestV = -1, bestD = Infinity;
    corners_.forEach((v, i) => { const d = dist(p, v); if (d < bestD) { bestD = d; bestV = i; } });
    if (bestV >= 0 && bestD < tol * 1.3) {
      const hit = bestV < n ? { edgeIndex: bestV, t: 0 } : { edgeIndex: n - 1, t: rs.edges[n - 1].lengthMm };
      return { ...hit, p: corners_[bestV] };
    }
    const e = nearestEdge(p, tolPt);
    if (!e) return null;
    const i = rs.edges.findIndex((x) => x.id === e.id);
    const L = rs.edges[i].lengthMm;
    const t = Math.min(L, Math.max(0, Math.round(e.along / 152.4) * 152.4));
    const u = unitVector(rs.edges[i].headingDeg);
    return { edgeIndex: i, t, p: { x: rs.edges[i].start.x + u.x * t, y: rs.edges[i].start.y + u.y * t } };
  };

  const extendTap = (raw: Pt) => {
    if (!ext) {
      const h = boundaryHit(raw, 44);
      if (!h) { setToast('Start on a wall or corner of the plan'); return; }
      setExt({ a: h, b: null }); setCorners([]);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    if (ext.b) return; // waiting for Confirm
    const h = corners.length > 0 ? boundaryHit(raw, 36) : null;
    if (h && rs?.closed) { setExt({ ...ext, b: h }); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); return; }
    const q = snapPoint(raw);
    const last = corners[corners.length - 1] ?? ext.a.p;
    if (dist(q, last) < 50) return;
    setCorners((c) => [...c, q]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const confirmExtend = () => {
    if (!space?.shape || !ext) return;
    const r = extendShape(space.shape, space.measurements, space.features, ext.a, corners, ext.b, newId);
    if ('error' in r) { setToast(r.error); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); return; }
    if (!save({ type: 'setShape', spaceId: sid!, shape: r.shape })) return;
    for (const m of r.featureMoves) save({ type: 'moveFeature', spaceId: sid!, featureId: m.featureId, anchor: { edgeId: m.edgeId, offsetMm: m.offsetMm } });
    stopExtend();
    setMode('measure'); setArmed(null);
    setToast('Plan extended · new walls are ready to measure');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => canvas.current?.fit(), 50);
  };
  const stopExtend = () => { setExtending(false); setExt(null); setCorners([]); setCursor(null); };

  const onTapWorld = (p: Pt) => {
    if (mode === 'draw') return extending ? extendTap(p) : addCorner(snapPoint(p));
    if (mode === 'add' && placing) {
      if (ON_EDGE_TYPES.includes(placing)) {
        const e = nearestEdge(p, 48);
        if (e) addFeatureOnEdge(placing, e.id, e.along);
        else setToast('Tap on a wall to place it');
      } else addFreeFeature(placing, p);
      return;
    }
    if (mode === 'measure') {
      const e = nearestEdge(p, 28);
      if (e) onLabelPress({ kind: 'edge', refId: e.id });
    }
  };

  const onCursorMove = (p: Pt | null, release: boolean) => {
    if (!p) return setCursor(null);
    const q = snapPoint(p);
    setCursor(q);
    if (release) { if (extending) extendTap(p); else addCorner(q); setCursor(null); }
  };

  // ---------- Shape replacement ----------
  const replaceWith = (what: PresetKind | 'draw' | 'trace') => {
    setConfirmReplace(null);
    stopExtend();
    if (what === 'draw') { setCorners([]); setMode('draw'); return; }
    if (what === 'trace') {
      save({ type: 'setShape', spaceId: sid!, shape: { origin: { x: 0, y: 0 }, closed: false, edges: [] } });
      angleRef.current = null; setHeading(0); setMode('trace'); return;
    }
    const had = !!space?.shape?.edges.length;
    save({ type: 'setShape', spaceId: sid!, shape: presetShape(what, newId) });
    setArmed(null); setMode('measure');
    if (had) setToast('Shape replaced · Undo to go back');
    setTimeout(() => canvas.current?.fit(), 50);
  };

  // ---------- Snackbar actions ----------
  const undoSnack = () => {
    if (!snack) return;
    const target = snack.target;
    undoLast();
    if (mode !== 'trace') setArmed(target);
  };

  if (doc && (doc.deleted || !space)) {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: sp.lg, padding: sp.lg }}>
        <Text style={type.title}>{doc.deleted ? 'This job was deleted.' : 'This space was deleted.'}</Text>
        <Btn label="Back" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }
  if (!doc || !space) {
    return <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={type.body}>Loading…</Text></SafeAreaView>;
  }

  const armedInfo = armed ? targets.find((t) => sameTarget(t.target, armed)) : undefined;
  const armedMeasurement = armed ? measurementForTarget(space, armed) : undefined;
  const armedFlag = armed ? openFlags.find((f) => sameTarget(f.target, armed)) : undefined;
  const measuredCount = targets.filter((t) => t.measured).length;
  const closure = rs ? diagnoseClosure(rs) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['top', 'left', 'right', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Btn label="‹" variant="ghost" onPress={() => router.back()} accessibilityLabel="Back" style={{ paddingHorizontal: sp.md }} />
        <View style={{ flex: 1 }}>
          <Text style={type.title} numberOfLines={1}>{space.name}</Text>
          {status?.ready ? (
            <View style={styles.goPill} accessibilityLabel="Good to go: everything is measured and the walls meet">
              <Text style={styles.goText}>✓ Good to go</Text>
            </View>
          ) : (
            <Text style={type.small}>{measuredCount} of {targets.length} measured</Text>
          )}
        </View>
        <HistoryButton glyph="↶" label="Undo" onPress={undoLast} disabled={undoDepth === 0} />
        <HistoryButton glyph="↷" label="Redo" onPress={redoLast} disabled={redoDepth === 0} />
        <SyncPill />
      </View>

      {/* Canvas */}
      <View style={{ flex: 1 }}>
        <LayoutCanvas
          ref={canvas}
          space={space}
          unitSystem={unit}
          armed={mode === 'measure' ? armed : null}
          density="field"
          cursorMode={mode === 'draw'}
          draft={mode === 'draw' ? { corners: extending ? (ext ? [ext.a.p, ...corners, ...(ext.b ? [ext.b.p] : [])] : []) : corners, cursor } : null}
          onTapWorld={onTapWorld}
          onCursorMove={onCursorMove}
          onLabelPress={onLabelPress}
          followArmed={mode === 'measure'}
          draggableFeatureId={mode === 'measure' && !editing && armed?.kind === 'feature' && space.features[armed.refId] && 'edgeId' in space.features[armed.refId].anchor ? armed.refId : null}
          onFeatureMoved={(featureId, edgeId, offsetMm) => {
            if (save({ type: 'moveFeature', spaceId: sid!, featureId, anchor: { edgeId, offsetMm } })) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          }}
          onLabelLongPress={(t) => { setArmed(t); setMode('measure'); setPlacing(null); setEditing(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); }}
        />

        {openFlags.length > 0 && mode === 'measure' ? (
          <Pressable style={styles.flagBanner} onPress={() => setArmed(openFlags[0].target)} accessibilityRole="button">
            <Text style={[type.label, { color: color.onDanger }]}>⚑ {openFlags.length} flag{openFlags.length > 1 ? 's' : ''} from office · re-measure</Text>
          </Pressable>
        ) : null}

        {closure && mode === 'measure' ? (
          <View style={styles.closure}>
            <Text style={[type.label, { color: color.danger }]}>Walls are off by {formatLength(closure.gapMm, unit, 1.5875)}</Text>
            {closureLines(closure, unit).map((line) => (
              <Text key={line} style={[type.small, { color: color.fg }]}>{line}</Text>
            ))}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: sp.xs, marginTop: 4 }}>
              {closure.suspects.slice(0, 4).map((i) => {
                const t: Target = { kind: 'edge', refId: rs!.edges[i].id };
                const on = !!armed && sameTarget(armed, t);
                return (
                  <Chip key={i} label={`Retake W${i + 1}`} active={on} onPress={() => { setArmed(t); setEditing(false); Haptics.selectionAsync(); }} />
                );
              })}
            </View>
          </View>
        ) : null}

        <View style={styles.zoom}>
          <Btn label="−" variant="outline" onPress={() => canvas.current?.zoomBy(0.7)} accessibilityLabel="Zoom out" style={styles.zoomBtn} />
          <Btn label="+" variant="outline" onPress={() => canvas.current?.zoomBy(1.4)} accessibilityLabel="Zoom in" style={styles.zoomBtn} />
          <Btn label="⤢" variant="outline" onPress={() => canvas.current?.fit()} accessibilityLabel="Fit layout" style={styles.zoomBtn} />
        </View>

        {/* Simulated Bluetooth tape */}
        <View style={styles.tapeWrap}>
          {tapeMenu ? (
            <View style={styles.tapeMenu}>
              <Text style={type.label}>Sim tape · {tape.status} · {tape.battery}%</Text>
              <Chip label={tape.exact ? 'Exact readings (demo) ✓' : 'Realistic noise ±3/16"'} active={tape.exact} onPress={() => simulatedTape.setExact(!tape.exact)} />
              <Chip label={tape.sendsAngle ? 'Sends angle ✓' : 'Distance only'} active={tape.sendsAngle} onPress={() => simulatedTape.setSendsAngle(!tape.sendsAngle)} />
              <Chip label={speak ? 'Read values aloud ✓' : 'Read values aloud'} active={speak} onPress={() => setSpeak(!speak)} />
              <Chip label={tape.status === 'connected' ? 'Disconnect' : 'Connect'} onPress={() => (tape.status === 'connected' ? simulatedTape.disconnect() : simulatedTape.connect())} />
            </View>
          ) : null}
          <Pressable
            onPress={pressTape}
            onLongPress={() => setTapeMenu((v) => !v)}
            style={({ pressed }) => [styles.tape, tape.status !== 'connected' && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.94 }] }]}
            accessibilityLabel="Simulated tape button. Long press for tape settings."
          >
            <View style={[styles.tapeDot, { backgroundColor: tape.status === 'connected' ? color.ok : tape.status === 'connecting' ? color.accent : color.danger }]} />
            <Text style={[type.label, { color: color.onAccent }]}>TAPE</Text>
            <Text style={[type.small, { color: color.onAccent, fontSize: 10 }]}>{tape.sendsAngle ? '+ angle' : 'sim'}</Text>
          </Pressable>
        </View>

        {toast ? <View style={styles.toast}><Text style={[type.label, { color: '#fff' }]}>{toast}</Text></View> : null}
      </View>

      {/* Tray: readings waiting for a target */}
      {tray.length > 0 ? (
        <View style={styles.tray}>
          <Text style={[type.title, type.num]}>{tray[0].raw}</Text>
          <Text style={[type.small, { flex: 1 }]}>{tray.length > 1 ? `+${tray.length - 1} more · ` : ''}Tap a wall or label to place it</Text>
          <Btn label="Discard" variant="ghost" onPress={() => setTray((t) => t.slice(1))} />
        </View>
      ) : null}

      {/* Snackbar: confirm + one-tap fix */}
      {snack ? (
        <View style={styles.snack}>
          <Text style={[type.label, type.num, { color: '#fff', flex: 1 }]} numberOfLines={1}>{snack.text}</Text>
          <Btn label="Undo" variant="outline" onPress={undoSnack} style={styles.snackBtn} />
        </View>
      ) : null}

      {/* Panels */}
      <View style={styles.panel}>
        {mode === 'measure' && editing ? (
          <EditPanel
            space={space}
            target={armed}
            label={armedInfo?.label ?? ''}
            unit={unit}
            confirm={confirmDel}
            onAsk={setConfirmDel}
            onClearReading={(t) => { if (save({ type: 'clearMeasurements', spaceId: sid!, target: t })) { setToast('Reading cleared'); setEditing(false); } }}
            onClearAll={() => { if (save({ type: 'clearMeasurements', spaceId: sid! })) { setToast('All readings cleared'); setEditing(false); setArmed(null); } }}
            onRemoveWall={(edgeId) => {
              if (save({ type: 'removeEdge', spaceId: sid!, edgeId })) { setArmed(null); setEditing(false); setToast('Wall removed: that side is now open'); setTimeout(() => canvas.current?.fit(), 50); }
            }}
            onDeleteFeature={(fid) => { if (save({ type: 'deleteFeature', spaceId: sid!, featureId: fid })) { setArmed(null); setEditing(false); setToast('Deleted'); } }}
            onDone={() => { setEditing(false); setConfirmDel(null); }}
            onChangeShape={() => { setEditing(false); setConfirmDel(null); setMode('shape'); }}
          />
        ) : mode === 'measure' ? (
          space.shape?.edges.length ? (
            <>
              <View style={styles.stepper}>
                <Btn label="◀" variant="ghost" onPress={() => step(-1)} accessibilityLabel="Previous item" style={styles.stepBtn} />
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[type.title, { textAlign: 'center' }]} numberOfLines={1}>{armedInfo?.label ?? 'Everything measured'}</Text>
                  {!armedFlag && armed?.kind === 'feature' && space.features[armed.refId] && 'edgeId' in space.features[armed.refId].anchor ? (
                    <Text style={type.small}>Drag ⟷ to slide it, or open Wall view</Text>
                  ) : null}
                  {armedFlag ? <Text style={[type.small, { color: color.danger }]}>⚑ Office: {armedFlag.reason.replace(/-/g, ' ')}{armedFlag.note ? ` · “${armedFlag.note}”` : ''}</Text> : null}
                </View>
                <Btn label="▶" variant="ghost" onPress={() => step(1)} accessibilityLabel="Next item" style={styles.stepBtn} />
              </View>
              <View style={styles.readout}>
                {armed ? (
                  armedMeasurement && !armedFlag ? (
                    <Text style={type.display} numberOfLines={1} adjustsFontSizeToFit>{formatLength(armedMeasurement.valueMm, unit, armedMeasurement.precisionMm)}</Text>
                  ) : (
                    <Text style={[type.title, { color: color.accent }]}>{armedFlag ? 'Office asked: measure again' : 'Measure this'}</Text>
                  )
                ) : <Text style={[type.title, { color: color.ok }]}>All done</Text>}
                {armedMeasurement ? <Text style={type.small}>{armedFlag ? `Current ${armedMeasurement.raw} · ` : ''}{sourceLabel(armedMeasurement.source)} · {armedMeasurement.takenBy} · {timeAgo(armedMeasurement.takenAt)}</Text> : null}
              </View>
              <View style={styles.row}>
                <Btn label="Input manually" variant="outline" onPress={() => setKeypad(true)} disabled={!armed} style={{ flex: 1.5, paddingHorizontal: sp.sm }} />
                {armedFlag ? (
                  <Btn label="It's correct" variant="primary" onPress={() => save({ type: 'confirmFlag', spaceId: sid!, flagId: armedFlag.id })} flex />
                ) : armed?.kind === 'feature' && space.features[armed.refId] && 'edgeId' in space.features[armed.refId].anchor ? (
                  <Btn label="Wall view" variant="outline" onPress={() => setElevation(armed.refId)} accessibilityLabel="Open the wall view to place it" flex />
                ) : (
                  <Btn label="+ Add" variant="outline" onPress={() => { setMode('add'); setPlacing(null); }} accessibilityLabel="Add a door, window or other feature" flex />
                )}
                <Btn label="Edit" variant="ghost" onPress={() => setEditing(true)} flex />
              </View>
            </>
          ) : (
            <View style={{ gap: sp.sm }}>
              <Text style={type.title}>Start with a shape</Text>
              <Btn label="Choose a shape" variant="accent" onPress={() => setMode('shape')} />
            </View>
          )
        ) : null}

        {mode === 'add' ? (
          <>
            <PanelHead
              title={placing ? (ON_EDGE_TYPES.includes(placing) ? `Tap the wall for the ${FEATURE_LABEL[placing].toLowerCase()}` : `Tap where the ${FEATURE_LABEL[placing].toLowerCase()} goes`) : 'Add what?'}
              onCancel={() => { setMode('measure'); setPlacing(null); }}
            />
            <View style={styles.palette}>
              {FEATURE_TYPES.map((ft) => (
                <Pressable key={ft} onPress={() => setPlacing(ft)} style={[styles.paletteBtn, placing === ft && styles.paletteOn]} accessibilityRole="button" accessibilityLabel={`Add ${FEATURE_LABEL[ft]}`}>
                  <Text style={[type.label, { color: placing === ft ? color.onAccent : color.fg }]}>{FEATURE_LABEL[ft]}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {mode === 'shape' ? (
          <View style={{ gap: sp.sm }}>
            <PanelHead
              title={space.shape?.edges.length ? 'Change the shape' : 'Choose a shape'}
              onCancel={space.shape?.edges.length ? () => { setMode('measure'); setConfirmReplace(null); } : undefined}
            />
            {space.shape?.edges.length ? (
              <>
                <Btn label="Add on to this plan" variant="accent" onPress={() => { setExtending(true); setExt(null); setCorners([]); setMode('draw'); }} />
                <Text style={type.small}>Or start over with:</Text>
              </>
            ) : null}
            <View style={styles.palette}>
              {(['rect', 'L', 'U', 'fence'] as PresetKind[]).map((k) => (
                <Pressable key={k} onPress={() => replaceWith(k)} style={[styles.paletteBtn, confirmReplace === k && styles.paletteOn]}>
                  <Text style={type.label}>{PRESET_LABEL[k]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.row}>
              <Btn label={space.shape?.edges.length ? 'Draw new' : 'Draw corners'} variant="outline" onPress={() => replaceWith('draw')} flex />
              <Btn label="Irregular" variant="outline" onPress={() => replaceWith('trace')} flex />
            </View>
          </View>
        ) : null}

        {mode === 'draw' && extending ? (
          <View style={{ gap: sp.sm }}>
            <PanelHead
              title={!ext ? 'Tap the wall or corner to build from' : ext.b ? 'Confirm to add it to the plan' : corners.length === 0 ? 'Tap the new corners' : rs?.closed ? 'Tap a wall of the plan to finish' : 'Add corners, then Confirm'}
              onCancel={() => { stopExtend(); setMode('measure'); }}
            />
            <View style={styles.row}>
              <Btn
                label="Undo" variant="ghost" flex
                disabled={!ext}
                onPress={() => { if (ext?.b) setExt({ ...ext, b: null }); else if (corners.length) setCorners((c) => c.slice(0, -1)); else setExt(null); }}
              />
              <Btn label="Confirm" variant="accent" flex onPress={confirmExtend} disabled={!ext || corners.length === 0 || (!!rs?.closed && !ext.b)} />
            </View>
          </View>
        ) : null}

        {mode === 'draw' && !extending ? (
          <View style={{ gap: sp.sm }}>
            <PanelHead
              title={corners.length === 0 ? 'Tap each corner' : corners.length < 3 ? `${corners.length} corner${corners.length > 1 ? 's' : ''}` : 'Tap the first corner to close'}
              onCancel={() => { setCorners([]); setMode(space.shape?.edges.length ? 'measure' : 'shape'); }}
            />
            <View style={styles.row}>
              <Btn label="Undo" variant="ghost" onPress={() => setCorners((c) => c.slice(0, -1))} disabled={!corners.length} flex />
              <Btn label="Leave open" variant="outline" onPress={() => finishDraw(false)} disabled={corners.length < 2} flex />
              <Btn label="Close" variant="accent" onPress={() => finishDraw(true)} disabled={corners.length < 3} flex />
            </View>
          </View>
        ) : null}

        {mode === 'trace' ? (
          <View style={{ gap: sp.sm }}>
            <View style={[styles.row, { alignItems: 'center' }]}>
              <View style={[styles.arrow, { transform: [{ rotate: `${heading}deg` }] }]}><Text style={{ fontSize: 30, color: color.accent, fontWeight: '900' }}>→</Text></View>
              <Text style={[type.title, { flex: 1 }]}>
                {tape.sendsAngle ? 'Point and measure each wall' : `Measure wall ${(space.shape?.edges.length ?? 0) + 1}`}
              </Text>
            </View>
            {tape.sendsAngle ? null : (
              <View style={styles.row}>
                <Btn label="↰ Turn left" variant="outline" onPress={() => setHeading((h) => normalizeDeg(h - 90))} onLongPress={() => setHeading((h) => normalizeDeg(h - 45))} accessibilityLabel="Turn left 90 degrees. Hold for 45." flex />
                <Btn label="Turn right ↱" variant="outline" onPress={() => setHeading((h) => normalizeDeg(h + 90))} onLongPress={() => setHeading((h) => normalizeDeg(h + 45))} accessibilityLabel="Turn right 90 degrees. Hold for 45." flex />
              </View>
            )}
            <View style={styles.row}>
              <Btn label="Input manually" variant="ghost" onPress={() => setKeypad(true)} style={{ flex: 1.5, paddingHorizontal: sp.sm }} />
              <Btn label="Undo" variant="ghost" onPress={() => save({ type: 'removeLastEdge', spaceId: sid! })} disabled={!space.shape?.edges.length} flex />
              <Btn label="Close" variant="accent" onPress={() => { save({ type: 'setClosed', spaceId: sid!, closed: true }); setMode('measure'); setArmed(null); setTimeout(() => canvas.current?.fit(), 50); }} disabled={(space.shape?.edges.length ?? 0) < 2} flex />
            </View>
            {tape.sendsAngle ? null : <Text style={[type.small, { textAlign: 'center' }]}>Hold a turn button for 45°</Text>}
          </View>
        ) : null}
      </View>

      <ElevationSheet
        visible={!!elevation}
        space={space}
        featureId={elevation}
        unit={unit}
        armed={armed}
        tapeReady={tape.status === 'connected'}
        onArm={(t) => { setArmed(t); Haptics.selectionAsync(); }}
        onTyped={(t, raw, source) => placeReading({ id: newId(), raw, source, receivedAt: Date.now() }, t)}
        onMove={(offsetMm) => {
          const f = elevation ? space.features[elevation] : undefined;
          if (f && 'edgeId' in f.anchor) save({ type: 'moveFeature', spaceId: sid!, featureId: f.id, anchor: { edgeId: f.anchor.edgeId, offsetMm } });
        }}
        onResize={(sizes) => { if (elevation) save({ type: 'setFeatureSizes', spaceId: sid!, featureId: elevation, sizes }); }}
        onTape={pressTape}
        onClose={() => setElevation(null)}
      />

      <Keypad
        visible={keypad}
        title={mode === 'trace' ? `Wall ${(space.shape?.edges.length ?? 0) + 1}` : armedInfo?.label ?? 'Measurement'}
        unitSystem={unit}
        onClose={() => setKeypad(false)}
        onSubmit={(raw, source) => {
          setKeypad(false);
          const r: Reading = { id: newId(), raw, source, receivedAt: Date.now() };
          if (mode === 'trace') traceReading(r);
          else if (armed) placeReading(r, armed);
        }}
      />
    </SafeAreaView>
  );
}

function HistoryButton({ glyph, label, onPress, disabled }: { glyph: string; label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.histBtn, disabled && styles.histOff, pressed && { backgroundColor: color.accentSoft }]}
    >
      <Text style={[styles.histGlyph, disabled && { color: color.estimated }]}>{glyph}</Text>
    </Pressable>
  );
}

function PanelHead({ title, onCancel }: { title: string; onCancel?: () => void }) {
  return (
    <View style={styles.panelHead}>
      <Text style={[type.title, { flex: 1 }]} numberOfLines={2}>{title}</Text>
      {onCancel ? <Btn label="Cancel" variant="ghost" onPress={onCancel} style={{ minHeight: touch.office }} /> : null}
    </View>
  );
}

function EditPanel({ space, target, label, unit, confirm, onAsk, onClearReading, onClearAll, onRemoveWall, onDeleteFeature, onDone, onChangeShape }: {
  space: Space; target: Target | null; label: string; unit: 'imperial' | 'metric'; confirm: string | null;
  onAsk: (k: string | null) => void; onClearReading: (t: Target) => void; onClearAll: () => void;
  onRemoveWall: (edgeId: string) => void; onDeleteFeature: (featureId: string) => void; onDone: () => void; onChangeShape: () => void;
}) {
  const m = target ? measurementForTarget(space, target) : undefined;
  const feature = target?.kind === 'feature' ? space.features[target.refId] : undefined;
  const edges = space.shape?.edges ?? [];
  const idx = target?.kind === 'edge' ? edges.findIndex((e) => e.id === target.refId) : -1;
  const canRemoveWall = target?.kind === 'edge' && idx >= 0 && (space.shape?.closed || idx === 0 || idx === edges.length - 1);
  const readings = listTargets(space).filter((t) => t.measured).length; // items, not retake history
  // Two-tap destructive actions: first tap arms (turns red), second tap within 3.5 s commits.
  const twoTap = (key: string, run: () => void) => () => (confirm === key ? (onAsk(null), run()) : onAsk(key));

  return (
    <View style={{ gap: sp.sm }}>
      <PanelHead title={target ? `Edit ${feature ? FEATURE_LABEL[feature.type] : label}` : 'Edit'} onCancel={onDone} />
      {m && target ? (
        <Btn
          label={confirm === 'clear' ? 'Tap again to clear' : `Clear reading (${formatLength(m.valueMm, unit, m.precisionMm)})`}
          variant={confirm === 'clear' ? 'danger' : 'outline'}
          onPress={twoTap('clear', () => onClearReading(target))}
        />
      ) : null}
      {target?.kind === 'edge' ? (
        canRemoveWall ? (
          <Btn
            label={confirm === 'wall' ? 'Tap again to remove wall' : space.shape?.closed ? 'Remove wall (leave this side open)' : 'Remove this end wall'}
            variant={confirm === 'wall' ? 'danger' : 'outline'}
            onPress={twoTap('wall', () => onRemoveWall(target!.refId))}
          />
        ) : (
          <Text style={type.small}>Only an end wall can be removed here. Use Change shape to rework the middle.</Text>
        )
      ) : null}
      {feature ? (
        <Btn
          label={confirm === 'feature' ? `Tap again to delete ${FEATURE_LABEL[feature.type].toLowerCase()}` : `Delete ${FEATURE_LABEL[feature.type].toLowerCase()}`}
          variant={confirm === 'feature' ? 'danger' : 'outline'}
          onPress={twoTap('feature', () => onDeleteFeature(feature.id))}
        />
      ) : null}
      {Object.keys(space.measurements).length > 0 ? (
        <Btn
          label={confirm === 'all' ? `Tap again to clear all ${readings}` : `Clear all readings (${readings})`}
          variant={confirm === 'all' ? 'danger' : 'ghost'}
          onPress={twoTap('all', onClearAll)}
        />
      ) : null}
      <Btn label="Change shape / add on…" variant="ghost" onPress={onChangeShape} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: sp.sm, paddingHorizontal: sp.md, paddingVertical: sp.sm, backgroundColor: color.card, borderBottomWidth: 1.5, borderBottomColor: color.border },
  zoom: { position: 'absolute', right: sp.md, top: sp.md, gap: sp.sm },
  zoomBtn: { width: touch.field, paddingHorizontal: 0 },
  tapeWrap: { position: 'absolute', right: sp.md, bottom: sp.md, alignItems: 'flex-end', gap: sp.sm },
  tape: { width: 84, height: 84, borderRadius: 42, backgroundColor: color.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: color.fg, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  tapeDot: { position: 'absolute', top: 10, right: 14, width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: color.fg },
  tapeMenu: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 2, borderColor: color.border, padding: sp.md, gap: sp.sm, alignItems: 'flex-end' },
  flagBanner: { position: 'absolute', top: sp.md, left: sp.md, right: 84, backgroundColor: color.danger, borderRadius: radius.md, minHeight: 48, justifyContent: 'center', paddingHorizontal: sp.md },
  closure: { position: 'absolute', left: sp.md, right: 84, bottom: sp.md, backgroundColor: color.dangerSoft, borderColor: color.danger, borderWidth: 2, borderRadius: radius.md, padding: sp.sm },
  toast: { position: 'absolute', alignSelf: 'center', top: '40%', backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: radius.md, paddingHorizontal: sp.lg, paddingVertical: sp.md, maxWidth: '85%' },
  tray: { flexDirection: 'row', alignItems: 'center', gap: sp.md, padding: sp.md, backgroundColor: color.accentSoft, borderTopWidth: 2, borderTopColor: color.accent },
  snack: { flexDirection: 'row', alignItems: 'center', gap: sp.sm, paddingHorizontal: sp.md, paddingVertical: sp.sm, backgroundColor: color.fg },
  snackBtn: { minHeight: 44, paddingHorizontal: sp.md },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
  goPill: { alignSelf: 'flex-start', backgroundColor: color.ok, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 2, marginTop: 2 },
  goText: { ...type.label, color: '#FFFFFF', fontSize: 13 },
  histBtn: {
    width: touch.field, height: touch.field, borderRadius: radius.md, borderWidth: 2.5, borderColor: color.fg,
    backgroundColor: color.card, alignItems: 'center', justifyContent: 'center',
  },
  histOff: { borderColor: color.hairline, backgroundColor: color.muted },
  histGlyph: { fontSize: 30, lineHeight: 34, fontWeight: '900', color: color.fg },
  panel: { padding: sp.md, gap: sp.sm, backgroundColor: color.card, borderTopWidth: 1.5, borderTopColor: color.border },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
  stepBtn: { width: touch.field + 8, paddingHorizontal: 0 },
  readout: { alignItems: 'center', minHeight: 70, justifyContent: 'center' },
  row: { flexDirection: 'row', gap: sp.sm },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: sp.sm },
  paletteBtn: { width: '31.5%', minHeight: 64, borderRadius: radius.md, borderWidth: 2, borderColor: color.border, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, gap: 2 },
  paletteOn: { backgroundColor: color.accent, borderColor: color.fg },
  arrow: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: color.accentSoft },
});
