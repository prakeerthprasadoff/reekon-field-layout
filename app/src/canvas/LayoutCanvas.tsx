// Skia layout canvas shared by field and office.
//
// Performance model: the viewport (translate + scale) lives in Reanimated shared values and is
// consumed directly by Skia and by the label overlays' animated styles, so pan/zoom never
// re-renders React. React only re-renders when the document itself changes.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Canvas, DashPathEffect, Group, Line, Path, Circle, Skia, vec } from '@shopify/react-native-skia';
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import {
  GestureDetector, useExclusiveGestures, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture,
} from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import * as Haptics from 'expo-haptics';
import {
  FEATURE_DIMS, FEATURE_LABEL, diagnoseClosure, featureSize, formatLength, resolveFeature, resolveShape, sameTarget, targetKey,
  type Pt, type ResolvedFeature, type ResolvedShape, type Space, type Target, type UnitSystem,
} from '@field/shared';
import { color, radius, type } from '../ui/theme';

export interface CanvasHandle {
  fit: (animated?: boolean) => void;
  zoomBy: (factor: number) => void;
  focusOn: (p: Pt) => void;
  screenToWorld: (sx: number, sy: number) => Pt;
  /** Screen points per mm, for converting finger-size tolerances into world units. */
  scale: () => number;
}

export interface DraftOverlay {
  corners: Pt[];
  cursor: Pt | null;
}

interface Props {
  space: Space;
  unitSystem: UnitSystem;
  armed?: Target | null;
  selected?: Target | null;
  /** 'field' = 56pt gloved labels; 'office' = compact labels. */
  density: 'field' | 'office';
  /** One-finger pan moves a draw cursor instead of the view (draw mode). */
  cursorMode?: boolean;
  draft?: DraftOverlay | null;
  onTapWorld?: (p: Pt) => void;
  onCursorMove?: (p: Pt | null, release: boolean) => void;
  onLabelPress?: (t: Target) => void;
  onLabelLongPress?: (t: Target) => void;
  /** Target keys that changed recently (office "pulse"). */
  recent?: Set<string>;
  /** Fired when the user pans/zooms by hand (office turns off follow mode). */
  onUserMove?: () => void;
  /** Pan (keeping zoom) so the armed target stays on screen when it changes. */
  followArmed?: boolean;
  /** On-wall feature that shows a drag handle to slide it along its wall. */
  draggableFeatureId?: string | null;
  /** Called with the new offset from the wall's start corner once the drag ends. */
  onFeatureMoved?: (featureId: string, edgeId: string, offsetMm: number) => void;
}

const GRID_MM = 304.8; // 1 ft
const CURSOR_LIFT = 72; // pt above the finger, so a gloved fingertip doesn't hide the point

interface Label {
  key: string;
  target: Target;
  text: string;
  at: Pt;
  measured: boolean;
  flagged: boolean;
  /** Part of a closure disagreement. */
  suspect?: boolean;
}

export const LayoutCanvas = forwardRef<CanvasHandle, Props>(function LayoutCanvas(props, ref) {
  const { space, unitSystem, armed, selected, density, cursorMode, draft, onTapWorld, onCursorMove, onLabelPress, onLabelLongPress, recent, onUserMove, followArmed, draggableFeatureId, onFeatureMoved } = props;
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const sc = useSharedValue(0.08);
  const size = useRef({ w: 0, h: 0 });
  const [, setReady] = useState(false);

  const rs: ResolvedShape | null = useMemo(
    () => (space.shape && space.shape.edges.length ? resolveShape(space.shape, space.measurements) : null),
    [space.shape, space.measurements],
  );
  const closure = useMemo(() => (rs ? diagnoseClosure(rs) : null), [rs]);
  const suspectIds = useMemo(() => new Set(closure?.suspects.map((i) => rs!.edges[i].id) ?? []), [closure, rs]);
  // Live preview while a feature is dragged: React state, committed as one op on release.
  const [drag, setDrag] = useState<{ id: string; offsetMm: number } | null>(null);
  const features: ResolvedFeature[] = useMemo(() => {
    if (!rs) return [];
    return Object.values(space.features)
      .map((f) => {
        if (drag && f.id === drag.id && 'edgeId' in f.anchor) {
          f = { ...f, anchor: { ...f.anchor, offsetMm: drag.offsetMm }, dims: { ...f.dims, offset: null } };
        }
        return resolveFeature(f, rs, space.measurements);
      })
      .filter((x): x is ResolvedFeature => !!x);
  }, [rs, space.features, space.measurements, drag]);

  // ---------- Viewport helpers ----------
  const bounds = useCallback(() => {
    const pts: Pt[] = [...(rs?.vertices ?? []), ...(draft?.corners ?? [])];
    features.forEach((f) => { pts.push(f.p0, f.p1); });
    if (!pts.length) return { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 };
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }, [rs, draft, features]);

  const fit = useCallback((animated = true) => {
    const { w, h } = size.current;
    if (!w || !h) return;
    const b = bounds();
    const pad = density === 'field' ? 90 : 70;
    const bw = Math.max(b.maxX - b.minX, 1500), bh = Math.max(b.maxY - b.minY, 1500);
    const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const nx = w / 2 - cx * s, ny = h / 2 - cy * s;
    const cfg = { duration: 280 };
    sc.value = animated ? withTiming(s, cfg) : s;
    tx.value = animated ? withTiming(nx, cfg) : nx;
    ty.value = animated ? withTiming(ny, cfg) : ny;
  }, [bounds, density, sc, tx, ty]);

  const zoomBy = useCallback((f: number) => {
    const { w, h } = size.current;
    const cx = w / 2, cy = h / 2;
    const s0 = sc.value, s1 = Math.min(Math.max(s0 * f, 0.005), 2);
    const k = s1 / s0;
    tx.value = withTiming(cx - (cx - tx.value) * k, { duration: 180 });
    ty.value = withTiming(cy - (cy - ty.value) * k, { duration: 180 });
    sc.value = withTiming(s1, { duration: 180 });
  }, [sc, tx, ty]);

  const focusOn = useCallback((p: Pt) => {
    const { w, h } = size.current;
    tx.value = withTiming(w / 2 - p.x * sc.value, { duration: 400 });
    ty.value = withTiming(h / 2 - p.y * sc.value, { duration: 400 });
  }, [sc, tx, ty]);

  const screenToWorld = useCallback((sx: number, sy: number): Pt => ({ x: (sx - tx.value) / sc.value, y: (sy - ty.value) / sc.value }), [sc, tx, ty]);

  const scale = useCallback(() => sc.value, [sc]);
  useImperativeHandle(ref, () => ({ fit, zoomBy, focusOn, screenToWorld, scale }), [fit, zoomBy, focusOn, screenToWorld, scale]);

  // Auto-advance follow: when the armed target changes and sits outside the comfortable middle
  // of the view, glide it to the centre at the current zoom. Already-visible targets don't move
  // the view, so a zoomed-out layout stays still.
  const armedKeyForFollow = armed ? targetKey(armed) : null;
  useEffect(() => {
    if (!followArmed || !armed || !firstFit.current) return;
    let p: Pt | null = null;
    if (armed.kind === 'edge') {
      const e = rs?.edges.find((x) => x.id === armed.refId);
      if (e) p = { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 };
    } else {
      const f = features.find((x) => x.feature.id === armed.refId);
      if (f) p = { x: (f.p0.x + f.p1.x) / 2, y: (f.p0.y + f.p1.y) / 2 };
    }
    if (!p) return;
    const { w, h } = size.current;
    const sx = p.x * sc.value + tx.value, sy = p.y * sc.value + ty.value;
    const m = 0.2;
    if (sx < w * m || sx > w * (1 - m) || sy < h * m || sy > h * (1 - m)) focusOn(p);
    // Only re-run when the armed target itself changes, not on every geometry update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedKeyForFollow, followArmed]);

  const firstFit = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
    if (!firstFit.current) { firstFit.current = true; fit(false); setReady(true); }
  };

  // ---------- Gestures ----------
  const tapJS = useCallback((x: number, y: number) => onTapWorld?.(screenToWorld(x, y)), [onTapWorld, screenToWorld]);
  const cursorJS = useCallback((x: number, y: number, release: boolean) => {
    onCursorMove?.(screenToWorld(x, y - CURSOR_LIFT), release);
  }, [onCursorMove, screenToWorld]);

  const userMoveJS = useCallback(() => onUserMove?.(), [onUserMove]);
  const pinchStart = useSharedValue({ s: 1, tx: 0, ty: 0 });
  const pinch = usePinchGesture({
    onBegin: () => { 'worklet'; pinchStart.value = { s: sc.value, tx: tx.value, ty: ty.value }; },
    onActivate: () => { 'worklet'; scheduleOnRN(userMoveJS); },
    onUpdate: (e) => {
      'worklet';
      const st = pinchStart.value;
      const s1 = Math.min(Math.max(st.s * e.scale, 0.005), 2);
      const k = s1 / st.s;
      sc.value = s1;
      tx.value = e.focalX - (e.focalX - st.tx) * k;
      ty.value = e.focalY - (e.focalY - st.ty) * k;
    },
  });

  // View pan: one finger normally, two fingers while drawing (one finger moves the cursor).
  const viewPan = usePanGesture({
    minPointers: cursorMode ? 2 : 1,
    onActivate: () => { 'worklet'; scheduleOnRN(userMoveJS); },
    onUpdate: (e) => { 'worklet'; tx.value += e.changeX; ty.value += e.changeY; },
  });

  const cursorPan = usePanGesture({
    enabled: !!cursorMode,
    maxPointers: 1,
    minDistance: 4,
    onUpdate: (e) => { 'worklet'; scheduleOnRN(cursorJS, e.x, e.y, false); },
    onDeactivate: (e) => { 'worklet'; if (!e.canceled) scheduleOnRN(cursorJS, e.x, e.y, true); },
  });

  const tap = useTapGesture({
    maxDistance: 12,
    onActivate: (e) => { 'worklet'; scheduleOnRN(tapJS, e.x, e.y); },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    enabled: !cursorMode,
    onActivate: (e) => {
      'worklet';
      const s1 = Math.min(sc.value * 1.8, 2);
      const k = s1 / sc.value;
      tx.value = withTiming(e.x - (e.x - tx.value) * k, { duration: 200 });
      ty.value = withTiming(e.y - (e.y - ty.value) * k, { duration: 200 });
      sc.value = withTiming(s1, { duration: 200 });
    },
  });

  const taps = useExclusiveGestures(doubleTap, tap);
  const gesture = useSimultaneousGestures(viewPan, pinch, cursorPan, taps);

  // ---------- Skia drawing ----------
  const transform = useDerivedValue(() => [{ translateX: tx.value }, { translateY: ty.value }, { scale: sc.value }]);
  const px = (n: number) => useDerivedValue(() => n / sc.value); // screen-constant stroke widths
  const w1 = px(1), w2 = px(2.5), w3 = px(4), w5 = px(7), dot = px(5), startDot = px(14), crossR = px(18), gapRing = px(22);
  const dash = useDerivedValue(() => [10 / sc.value, 7 / sc.value]);

  const grid = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    const R = 60; // +/- 60 ft
    for (let i = -R; i <= R; i++) {
      p.moveTo(i * GRID_MM, -R * GRID_MM); p.lineTo(i * GRID_MM, R * GRID_MM);
      p.moveTo(-R * GRID_MM, i * GRID_MM); p.lineTo(R * GRID_MM, i * GRID_MM);
    }
    return p.build();
  }, []);

  const fillPath = useMemo(() => {
    if (!rs || !rs.closed) return null;
    const p = Skia.PathBuilder.Make();
    rs.vertices.forEach((v, i) => (i === 0 ? p.moveTo(v.x, v.y) : p.lineTo(v.x, v.y)));
    p.close();
    return p.build();
  }, [rs]);

  const armedKey = armed ? targetKey(armed) : null;
  const selKey = selected ? targetKey(selected) : null;
  const openFlagKeys = useMemo(
    () => new Set(Object.values(space.flags).filter((f) => f.status === 'open').map((f) => targetKey(f.target))),
    [space.flags],
  );

  const draftPath = useMemo(() => {
    if (!draft || draft.corners.length === 0) return null;
    const p = Skia.PathBuilder.Make();
    draft.corners.forEach((c, i) => (i === 0 ? p.moveTo(c.x, c.y) : p.lineTo(c.x, c.y)));
    if (draft.cursor) p.lineTo(draft.cursor.x, draft.cursor.y);
    return p.build();
  }, [draft]);

  // ---------- Labels (RN overlay, positioned on the UI thread) ----------
  const labels: Label[] = useMemo(() => {
    const out: Label[] = [];
    if (rs) {
      rs.edges.forEach((e, i) => {
        const t: Target = { kind: 'edge', refId: e.id };
        const k = targetKey(t);
        const suspect = suspectIds.has(e.id);
        const value = e.measurement ? formatLength(e.measurement.valueMm, unitSystem, e.measurement.precisionMm) : `≈ ${formatLength(e.lengthMm, unitSystem, 25.4)}`;
        out.push({
          key: k, target: t,
          // Suspect walls carry their number so they match the "Wall 1 vs Wall 3" banner.
          text: suspect ? `W${i + 1} · ${value}` : value,
          at: { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 },
          measured: e.status === 'measured', flagged: openFlagKeys.has(k), suspect,
        });
      });
    }
    features.forEach((rf) => {
      const f = rf.feature;
      const mid = { x: (rf.p0.x + rf.p1.x) / 2, y: (rf.p0.y + rf.p1.y) / 2 };
      // Feature labels sit just inside the space so they don't collide with the wall label.
      const inset = 'edgeId' in f.anchor ? 650 : 0;
      const base = { x: mid.x + rf.inward.x * inset, y: mid.y + rf.inward.y * inset };
      const dims = FEATURE_DIMS[f.type].filter((d) => d.key !== 'offset' || 'edgeId' in f.anchor);
      const main = dims.find((d) => d.key === 'width' || d.key === 'size' || d.key === 'length') ?? dims[0];
      const t: Target = { kind: 'feature', refId: f.id, dim: main.key };
      const sz = featureSize(f, main.key, space.measurements);
      const anyArmed = armed && armed.kind === 'feature' && armed.refId === f.id;
      const k = targetKey(t);
      const flagged = dims.some((d) => openFlagKeys.has(targetKey({ kind: 'feature', refId: f.id, dim: d.key })));
      out.push({
        key: k, target: anyArmed ? armed! : t,
        text: `${FEATURE_LABEL[f.type]} ${sz.measured ? '' : '≈'}${formatLength(sz.mm, unitSystem, sz.measured ? 1.5875 : 25.4)}`,
        at: base, measured: dims.every((d) => !!f.dims[d.key]), flagged,
      });
    });
    return out;
  }, [rs, features, unitSystem, openFlagKeys, armed, space.measurements, suspectIds]);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Group transform={transform}>
              <Path path={grid} style="stroke" strokeWidth={w1} color={color.grid} />
              {fillPath ? <Path path={fillPath} color="rgba(234,88,12,0.06)" /> : null}

              {rs?.edges.map((e) => {
                const k = targetKey({ kind: 'edge', refId: e.id });
                const isArmed = k === armedKey, isSel = k === selKey, flagged = openFlagKeys.has(k), suspect = suspectIds.has(e.id);
                const c = isArmed ? color.accent : flagged || suspect ? color.danger : e.status === 'measured' ? color.wall : color.estimated;
                return (
                  <Group key={e.id}>
                    {(isArmed || isSel) ? <Line p1={vec(e.start.x, e.start.y)} p2={vec(e.end.x, e.end.y)} strokeWidth={w5} color="rgba(234,88,12,0.25)" style="stroke" strokeCap="round" /> : null}
                    {suspect && !isArmed ? <Line p1={vec(e.start.x, e.start.y)} p2={vec(e.end.x, e.end.y)} strokeWidth={w5} color="rgba(220,38,38,0.22)" style="stroke" strokeCap="round" /> : null}
                    <Line p1={vec(e.start.x, e.start.y)} p2={vec(e.end.x, e.end.y)} strokeWidth={isArmed ? w3 : w2} color={c} style="stroke" strokeCap="round">
                      {e.status === 'estimated' && !isArmed ? <DashPathEffect intervals={dash} /> : null}
                    </Line>
                  </Group>
                );
              })}

              {closure ? (
                <Group>
                  <Line p1={vec(closure.end.x, closure.end.y)} p2={vec(closure.start.x, closure.start.y)} strokeWidth={w3} color={color.danger} style="stroke">
                    <DashPathEffect intervals={dash} />
                  </Line>
                  {/* A 1/4" gap is sub-pixel at room scale, so ring the corner at a fixed screen size. */}
                  <Circle cx={closure.start.x} cy={closure.start.y} r={gapRing} color={color.danger} style="stroke" strokeWidth={w3} />
                </Group>
              ) : null}

              {rs?.vertices.map((v, i) => <Circle key={`v${i}`} cx={v.x} cy={v.y} r={dot} color={color.wall} />)}

              {features.map((rf) => <FeatureGlyph key={rf.feature.id} rf={rf} w2={w2} w3={w3} dash={dash} space={space} armed={armed ?? null} />)}

              {draftPath ? <Path path={draftPath} style="stroke" strokeWidth={w3} color={color.accent} strokeCap="round" strokeJoin="round" /> : null}
              {draft?.corners.map((c, i) => <Circle key={`d${i}`} cx={c.x} cy={c.y} r={i === 0 && draft.corners.length > 2 ? startDot : dot} color={i === 0 ? color.accent : color.wall} />)}
              {draft?.cursor ? <Crosshair p={draft.cursor} w={w2} r={crossR} /> : null}
            </Group>
          </Canvas>
        </View>
      </GestureDetector>

      {draft?.cursor && draft.corners.length > 0 ? (
        <CursorReadout from={draft.corners[draft.corners.length - 1]} to={draft.cursor} unitSystem={unitSystem} />
      ) : null}

      {(() => {
        const rf = draggableFeatureId ? features.find((x) => x.feature.id === draggableFeatureId && x.edgeId) : undefined;
        const e = rf ? rs?.edges.find((x) => x.id === rf.edgeId) : undefined;
        if (!rf || !e) return null;
        return (
          <DragHandle
            key={rf.feature.id}
            rf={rf} edge={e} space={space} unitSystem={unitSystem} tx={tx} ty={ty} sc={sc} dragging={drag?.id === rf.feature.id}
            onDrag={(offsetMm) => setDrag({ id: rf.feature.id, offsetMm })}
            onEnd={(offsetMm) => { setDrag(null); onFeatureMoved?.(rf.feature.id, e.id, offsetMm); }}
          />
        );
      })()}

      {labels.map((l) => (
        <FloatingLabel
          key={l.key}
          label={l}
          tx={tx} ty={ty} sc={sc}
          armed={!!armed && (sameTarget(l.target, armed) || (armed.kind === 'feature' && l.target.kind === 'feature' && armed.refId === l.target.refId))}
          selected={!!selected && sameTarget(l.target, selected)}
          recent={recent?.has(l.key) ?? false}
          density={density}
          onPress={onLabelPress ? () => onLabelPress(l.target) : undefined}
          onLongPress={onLabelLongPress ? () => onLabelLongPress(l.target) : undefined}
        />
      ))}
    </View>
  );
});

function Crosshair({ p, w, r }: { p: Pt; w: SharedValue<number>; r: SharedValue<number> }) {
  const a = useDerivedValue(() => vec(p.x - r.value, p.y));
  const b = useDerivedValue(() => vec(p.x + r.value, p.y));
  const c = useDerivedValue(() => vec(p.x, p.y - r.value));
  const d = useDerivedValue(() => vec(p.x, p.y + r.value));
  return (
    <Group>
      <Circle cx={p.x} cy={p.y} r={r} color={color.accent} style="stroke" strokeWidth={w} />
      <Line p1={a} p2={b} color={color.accent} strokeWidth={w} />
      <Line p1={c} p2={d} color={color.accent} strokeWidth={w} />
    </Group>
  );
}

function FeatureGlyph({ rf, w2, w3, dash, space, armed }: {
  rf: ResolvedFeature; w2: SharedValue<number>; w3: SharedValue<number>; dash: SharedValue<number[]>; space: Space; armed: Target | null;
}) {
  const gap = useDerivedValue(() => w3.value * 2.2);
  const f = rf.feature;
  const isArmed = armed?.kind === 'feature' && armed.refId === f.id;
  const measured = FEATURE_DIMS[f.type].every((d) => (d.key === 'offset' && !('edgeId' in f.anchor)) || !!f.dims[d.key]);
  const c = isArmed ? color.accent : measured ? '#1D4ED8' : '#3B82F6';
  if (f.type === 'post') {
    const s = featureSize(f, 'size', space.measurements).mm;
    return <Path path={rectPath(rf.p0, s)} color={c} />;
  }
  if (f.type === 'wall') {
    return <Line p1={vec(rf.p0.x, rf.p0.y)} p2={vec(rf.p1.x, rf.p1.y)} strokeWidth={w3} color={c} style="stroke" strokeCap="round" />;
  }
  const n = rf.inward;
  const L = Math.hypot(rf.p1.x - rf.p0.x, rf.p1.y - rf.p0.y);
  if (f.type === 'door') {
    // Gap in the wall + swing arc into the space.
    const arc = Skia.PathBuilder.Make();
    arc.moveTo(rf.p0.x, rf.p0.y);
    arc.lineTo(rf.p0.x + n.x * L, rf.p0.y + n.y * L);
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * (Math.PI / 2);
      const ux = (rf.p1.x - rf.p0.x) / (L || 1), uy = (rf.p1.y - rf.p0.y) / (L || 1);
      arc.lineTo(rf.p0.x + (n.x * Math.cos(t) + ux * Math.sin(t)) * L, rf.p0.y + (n.y * Math.cos(t) + uy * Math.sin(t)) * L);
    }
    return (
      <Group>
        <Line p1={vec(rf.p0.x, rf.p0.y)} p2={vec(rf.p1.x, rf.p1.y)} strokeWidth={gap} color={color.bg} style="stroke" />
        <Path path={arc.build()} style="stroke" strokeWidth={w2} color={c}><DashPathEffect intervals={dash} /></Path>
      </Group>
    );
  }
  if (f.type === 'window') {
    const off = 90;
    return (
      <Group>
        <Line p1={vec(rf.p0.x, rf.p0.y)} p2={vec(rf.p1.x, rf.p1.y)} strokeWidth={gap} color={color.bg} style="stroke" />
        <Line p1={vec(rf.p0.x + n.x * off, rf.p0.y + n.y * off)} p2={vec(rf.p1.x + n.x * off, rf.p1.y + n.y * off)} strokeWidth={w2} color={c} style="stroke" />
        <Line p1={vec(rf.p0.x - n.x * off, rf.p0.y - n.y * off)} p2={vec(rf.p1.x - n.x * off, rf.p1.y - n.y * off)} strokeWidth={w2} color={c} style="stroke" />
      </Group>
    );
  }
  if (f.type === 'steps') {
    // Treads drawn outward (away from the space), 3 by default.
    const treads = Number(f.props.treads ?? 3);
    const run = 280;
    const p = Skia.PathBuilder.Make();
    for (let i = 0; i <= treads; i++) {
      p.moveTo(rf.p0.x - n.x * run * i, rf.p0.y - n.y * run * i);
      p.lineTo(rf.p1.x - n.x * run * i, rf.p1.y - n.y * run * i);
    }
    p.moveTo(rf.p0.x, rf.p0.y); p.lineTo(rf.p0.x - n.x * run * treads, rf.p0.y - n.y * run * treads);
    p.moveTo(rf.p1.x, rf.p1.y); p.lineTo(rf.p1.x - n.x * run * treads, rf.p1.y - n.y * run * treads);
    return <Path path={p.build()} style="stroke" strokeWidth={w2} color={c} />;
  }
  // opening: just a gap with end ticks
  const t = 160;
  return (
    <Group>
      <Line p1={vec(rf.p0.x, rf.p0.y)} p2={vec(rf.p1.x, rf.p1.y)} strokeWidth={gap} color={color.bg} style="stroke" />
      <Line p1={vec(rf.p0.x - n.x * t, rf.p0.y - n.y * t)} p2={vec(rf.p0.x + n.x * t, rf.p0.y + n.y * t)} strokeWidth={w2} color={c} style="stroke" />
      <Line p1={vec(rf.p1.x - n.x * t, rf.p1.y - n.y * t)} p2={vec(rf.p1.x + n.x * t, rf.p1.y + n.y * t)} strokeWidth={w2} color={c} style="stroke" />
    </Group>
  );
}

function rectPath(c: Pt, s: number) {
  const p = Skia.PathBuilder.Make();
  p.addRect({ x: c.x - s / 2, y: c.y - s / 2, width: s, height: s });
  return p.build();
}

function CursorReadout({ from, to, unitSystem }: { from: Pt; to: Pt; unitSystem: UnitSystem }) {
  const L = Math.hypot(to.x - from.x, to.y - from.y);
  return (
    <View pointerEvents="none" style={styles.readout}>
      <Text style={[type.title, type.num]}>{formatLength(L, unitSystem, 25.4)}</Text>
    </View>
  );
}

/**
 * Big round handle sitting on a door/window. Dragging slides it along its own wall; the finger's
 * movement is projected onto the wall so wobble sideways doesn't matter. Snaps to whole inches
 * (or centimetres) and shows the distance from the corner while moving.
 */
function DragHandle({ rf, edge, space, unitSystem, tx, ty, sc, dragging, onDrag, onEnd }: {
  rf: ResolvedFeature; edge: ResolvedShape['edges'][number]; space: Space; unitSystem: UnitSystem;
  tx: SharedValue<number>; ty: SharedValue<number>; sc: SharedValue<number>; dragging: boolean;
  onDrag: (offsetMm: number) => void; onEnd: (offsetMm: number) => void;
}) {
  const SIZE = 60;
  const f = rf.feature;
  const width = featureSize(f, 'width', space.measurements).mm;
  const startOffset = useRef(0);
  const last = useRef(0);
  const u = { x: Math.cos((edge.headingDeg * Math.PI) / 180), y: Math.sin((edge.headingDeg * Math.PI) / 180) };
  const step = unitSystem === 'imperial' ? 25.4 : 10;
  const maxOff = Math.max(0, edge.lengthMm - width);
  const current = Math.hypot(rf.p0.x - edge.start.x, rf.p0.y - edge.start.y);

  // Gesture callbacks may be captured once: read the latest values through a ref.
  const live = useRef({ current, u, maxOff, step, onDrag, onEnd });
  live.current = { current, u, maxOff, step, onDrag, onEnd };
  const handlers = useRef({
    begin: () => { startOffset.current = live.current.current; last.current = live.current.current; },
    move: (dx: number, dy: number, done: boolean) => {
      const g = live.current;
      const along = (dx * g.u.x + dy * g.u.y) / sc.value;
      const off = Math.min(g.maxOff, Math.max(0, Math.round((startOffset.current + along) / g.step) * g.step));
      if (done) { g.onEnd(off); return; }
      if (off !== last.current) { last.current = off; g.onDrag(off); Haptics.selectionAsync(); }
    },
  }).current;
  const pan = usePanGesture({
    minDistance: 2,
    onBegin: () => { 'worklet'; scheduleOnRN(handlers.begin); },
    onUpdate: (e) => { 'worklet'; scheduleOnRN(handlers.move, e.translationX, e.translationY, false); },
    onDeactivate: (e) => { 'worklet'; scheduleOnRN(handlers.move, e.translationX, e.translationY, true); },
  });

  const mid = { x: (rf.p0.x + rf.p1.x) / 2, y: (rf.p0.y + rf.p1.y) / 2 };
  // Sit just outside the wall so it never hides under the wall's own length label.
  const OUT = 62;
  const out = { x: -rf.inward.x * OUT, y: -rf.inward.y * OUT };
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: mid.x * sc.value + tx.value + out.x - SIZE / 2 },
      { translateY: mid.y * sc.value + ty.value + out.y - SIZE / 2 },
    ],
  }));
  return (
    <Animated.View style={[styles.handleWrap, style]}>
      <GestureDetector gesture={pan}>
        <View
          style={[styles.handle, { width: SIZE, height: SIZE, borderRadius: SIZE / 2 }, dragging && { backgroundColor: color.accent }]}
          accessibilityRole="adjustable"
          accessibilityLabel={`Slide ${f.type} along the wall. ${formatLength(current, unitSystem, 25.4)} from the corner.`}
        >
          <Text style={[styles.handleArrow, { transform: [{ rotate: `${edge.headingDeg}deg` }] }, dragging && { color: color.onAccent }]}>⟷</Text>
        </View>
      </GestureDetector>
      {dragging ? (
        <View style={styles.handleReadout} pointerEvents="none">
          <Text style={[type.label, type.num]}>{formatLength(current, unitSystem, step)} from corner</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

function FloatingLabel({ label, tx, ty, sc, armed, selected, recent, density, onPress, onLongPress }: {
  label: Label; tx: SharedValue<number>; ty: SharedValue<number>; sc: SharedValue<number>;
  armed: boolean; selected: boolean; recent: boolean; density: 'field' | 'office'; onPress?: () => void; onLongPress?: () => void;
}) {
  const [w, setW] = useState(0);
  const h = density === 'field' ? 52 : 36;
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: label.at.x * sc.value + tx.value - w / 2 },
      { translateY: label.at.y * sc.value + ty.value - h / 2 },
    ],
  }));
  const bg = armed ? color.accent : label.flagged ? color.danger : selected ? color.primary : label.measured ? color.card : color.muted;
  const fg = armed ? color.onAccent : label.flagged || selected ? '#FFFFFF' : color.fg;
  return (
    <Animated.View style={[styles.labelWrap, style]} onLayout={(e) => setW(e.nativeEvent.layout.width)} pointerEvents="box-none">
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={450}
        disabled={!onPress && !onLongPress}
        hitSlop={density === 'field' ? 8 : 4}
        accessibilityRole="button"
        accessibilityLabel={`${label.text}${label.measured ? '' : ', not measured'}${label.flagged ? ', flagged' : ''}`}
        style={({ pressed }) => [
          styles.label,
          { minHeight: h, backgroundColor: bg, borderStyle: label.measured || armed ? 'solid' : 'dashed', paddingHorizontal: density === 'field' ? 14 : 10 },
          label.suspect && !armed && { borderColor: color.danger, borderWidth: 3 },
          recent && { borderColor: color.accent, borderWidth: 3 },
          pressed && { opacity: 0.7 },
        ]}
      >
        {label.flagged && !armed ? <Text style={[styles.labelText, { color: fg }]}>⚑ </Text> : null}
        <Text style={[styles.labelText, { color: fg, fontSize: density === 'field' ? 18 : 14 }]} numberOfLines={1}>{label.text}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  handleWrap: { position: 'absolute', left: 0, top: 0, alignItems: 'center' },
  handle: {
    backgroundColor: color.card, borderWidth: 3, borderColor: color.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0F172A', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  handleArrow: { fontSize: 28, fontWeight: '900', color: color.accent },
  handleReadout: {
    position: 'absolute', top: -44, backgroundColor: color.card, borderRadius: radius.md, borderWidth: 2, borderColor: color.fg,
    paddingHorizontal: 10, paddingVertical: 4, minWidth: 150, alignItems: 'center',
  },
  wrap: { flex: 1, overflow: 'hidden', backgroundColor: color.bg },
  labelWrap: { position: 'absolute', left: 0, top: 0 },
  label: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill,
    borderWidth: 2, borderColor: color.border,
  },
  labelText: { ...type.label, ...type.num },
  readout: {
    position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: color.card, borderRadius: radius.md,
    paddingHorizontal: 16, paddingVertical: 8, borderWidth: 2, borderColor: color.accent,
  },
});
