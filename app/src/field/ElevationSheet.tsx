// Wall elevation: the wall seen face-on, so a door/window can be placed on both axes.
// x = distance from the wall's start corner, y = height above the floor.
// Drag the opening to place it by eye; tap any dimension to measure it (tape or keypad).
import { useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Canvas, DashPathEffect, Line, Path, Rect, Circle, Skia, vec } from '@shopify/react-native-skia';
import { GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import * as Haptics from 'expo-haptics';
import {
  FEATURE_DIMS, FEATURE_LABEL, featureSize, formatLength, resolveShape, sameTarget,
  type Feature, type Source, type Space, type Target, type UnitSystem,
} from '@field/shared';
import { Keypad } from './Keypad';
import { Btn } from '../ui/components';
import { color, radius, space as sp, type } from '../ui/theme';

const CEILING_MM = 2438; // 8 ft, assumed until ceiling height is measured
const DOOR_HEIGHT_MM = 2032; // openings have no height dimension; draw them door-high

interface Props {
  visible: boolean;
  space: Space;
  featureId: string | null;
  unit: UnitSystem;
  armed: Target | null;
  tapeReady: boolean;
  onArm: (t: Target) => void;
  onTyped: (t: Target, raw: string, source: Source) => void;
  onMove: (offsetMm: number) => void;
  onResize: (sizes: Record<string, number>) => void;
  onTape: () => void;
  onClose: () => void;
}

export function ElevationSheet(props: Props) {
  const { visible, space, featureId, onClose } = props;
  const f = featureId ? space.features[featureId] : undefined;
  return (
    <Modal visible={visible && !!f} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {f && 'edgeId' in f.anchor ? <Sheet {...props} f={f} /> : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

type Edge = ReturnType<typeof resolveShape>['edges'][number];

function Sheet(props: Props & { f: Feature }) {
  const { space, f } = props;
  const rs = useMemo(() => (space.shape ? resolveShape(space.shape, space.measurements) : null), [space.shape, space.measurements]);
  const edgeId = 'edgeId' in f.anchor ? f.anchor.edgeId : '';
  const edgeIdx = rs?.edges.findIndex((e) => e.id === edgeId) ?? -1;
  if (edgeIdx < 0) return null;
  return <SheetBody {...props} edge={rs!.edges[edgeIdx]} edgeIdx={edgeIdx} edgeId={edgeId} />;
}

function SheetBody({ space, f, unit, armed, tapeReady, onArm, onTyped, onMove, onResize, onTape, onClose, edge, edgeIdx, edgeId }: Props & { f: Feature; edge: Edge; edgeIdx: number; edgeId: string }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ offset: number; sill: number } | null>(null);
  const [keypadFor, setKeypadFor] = useState<Target | null>(null);
  const start = useRef({ offset: 0, sill: 0, hit: false });

  const L = edge.lengthMm;
  const dims = FEATURE_DIMS[f.type];
  const val = (k: string) => featureSize(f, k, space.measurements);
  const width = Math.min(val('width').mm, L);
  const isWindow = f.type === 'window';
  const height = f.type === 'steps' ? val('rise').mm : f.type === 'opening' ? DOOR_HEIGHT_MM : val('height').mm;
  const offset = drag?.offset ?? Math.min(val('offset').mm, Math.max(0, L - width));
  const sill = isWindow ? drag?.sill ?? val('sill').mm : 0;
  const H = Math.max(CEILING_MM, sill + height + 200);
  const right = Math.max(0, L - offset - width);
  const step = unit === 'imperial' ? 25.4 : 10;
  const snap = (mm: number) => Math.round(mm / step) * step;

  // ---------- Screen mapping ----------
  // Centered both ways, with equal room left/right for the height labels and below for the chain.
  const padX = 24, side = 76, padTop = 44, padBottom = 64;
  const availW = size.w - padX * 2 - side * 2, availH = size.h - padTop - padBottom;
  const s = size.w && size.h ? Math.max(0, Math.min(availW / L, availH / H)) : 0;
  const x0 = (size.w - L * s) / 2;
  const floorY = padTop + (availH + H * s) / 2;
  const X = (mm: number) => x0 + mm * s;
  const Y = (mm: number) => floorY - mm * s; // mm above the floor

  const others = Object.values(space.features).filter((o) => o.id !== f.id && 'edgeId' in o.anchor && o.anchor.edgeId === edgeId);
  const box = { x: X(offset), y: Y(sill + height), w: width * s, h: height * s };

  // ---------- Drag (both axes for windows, along the wall for everything else) ----------
  // The gesture's callbacks may be captured once, so they read the latest layout from a ref
  // instead of closing over this render's values. Dragging anywhere on the drawing moves the
  // opening (relative drag): no need to land a gloved finger exactly on it.
  const live = useRef({ s, L, width, H, height, offset, sill, isWindow, step, savedOffset: 0, savedSill: 0, onMove, onResize });
  live.current = { s, L, width, H, height, offset, sill, isWindow, step, savedOffset: val('offset').mm, savedSill: isWindow ? val('sill').mm : 0, onMove, onResize };
  const handlers = useRef({
    begin: () => {
      const g = live.current;
      start.current = { offset: g.offset, sill: g.sill, hit: g.s > 0 };
      Haptics.selectionAsync();
    },
    move: (dx: number, dy: number, done: boolean) => {
      const st = start.current, g = live.current;
      if (!st.hit || !g.s) return;
      const sn = (mm: number) => Math.round(mm / g.step) * g.step;
      const no = Math.min(Math.max(0, sn(st.offset + dx / g.s)), Math.max(0, g.L - g.width));
      const ns = g.isWindow ? Math.min(Math.max(0, sn(st.sill - dy / g.s)), Math.max(0, g.H - g.height)) : 0;
      if (!done) { setDrag({ offset: no, sill: ns }); return; }
      st.hit = false;
      setDrag(null);
      if (Math.abs(no - g.savedOffset) >= 1) g.onMove(no);
      if (g.isWindow && Math.abs(ns - g.savedSill) >= 1) g.onResize({ sill: ns });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  }).current;
  const pan = usePanGesture({
    minDistance: 2,
    onBegin: () => { 'worklet'; scheduleOnRN(handlers.begin); },
    onUpdate: (e) => { 'worklet'; scheduleOnRN(handlers.move, e.translationX, e.translationY, false); },
    onDeactivate: (e) => { 'worklet'; scheduleOnRN(handlers.move, e.translationX, e.translationY, true); },
  });

  const target = (k: string): Target => ({ kind: 'feature', refId: f.id, dim: k });
  const isArmed = (k: string) => !!armed && sameTarget(armed, target(k));
  const fmt = (mm: number, k?: string) => {
    const v = k ? val(k) : { mm, measured: false };
    return v.measured && !drag ? formatLength(mm, unit, 1.5875) : `≈ ${formatLength(mm, unit, step)}`;
  };

  const ceilingPath = (() => {
    const p = Skia.PathBuilder.Make(); p.moveTo(X(0), Y(CEILING_MM)); p.lineTo(X(L), Y(CEILING_MM)); return p.build();
  })();

  const label = FEATURE_LABEL[f.type];
  const onLayout = (e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>{label} · Wall {edgeIdx + 1}</Text>
          <Text style={type.small}>Wall is {formatLength(L, unit, edge.status === 'measured' ? 1.5875 : step)}{edge.status === 'measured' ? '' : ' (estimated)'} · ceiling assumed 8'</Text>
        </View>
        <Btn label="Done" variant="accent" onPress={onClose} style={{ paddingHorizontal: sp.xl }} />
      </View>

      {/* Elevation drawing */}
      <View style={styles.drawing} onLayout={onLayout}>
        <GestureDetector gesture={pan}>
          <View style={StyleSheet.absoluteFill}>
            {s > 0 ? (
              <Canvas style={StyleSheet.absoluteFill}>
                <Rect x={X(0)} y={Y(H)} width={L * s} height={H * s} color={color.card} />
                <Path path={ceilingPath} style="stroke" strokeWidth={1.5} color={color.estimated}><DashPathEffect intervals={[6, 6]} /></Path>
                <Line p1={vec(X(0), Y(H))} p2={vec(X(0), floorY)} strokeWidth={4} color={color.wall} />
                <Line p1={vec(X(L), Y(H))} p2={vec(X(L), floorY)} strokeWidth={4} color={color.wall} />
                <Line p1={vec(X(0) - 14, floorY)} p2={vec(X(L) + 14, floorY)} strokeWidth={5} color={color.wall} />

                {others.map((o) => {
                  const ow = Math.min(featureSize(o, 'width', space.measurements).mm, L);
                  const oo = featureSize(o, 'offset', space.measurements).mm;
                  const oh = o.type === 'steps' ? featureSize(o, 'rise', space.measurements).mm : o.type === 'opening' ? DOOR_HEIGHT_MM : featureSize(o, 'height', space.measurements).mm;
                  const os = o.type === 'window' ? featureSize(o, 'sill', space.measurements).mm : 0;
                  return <Rect key={o.id} x={X(oo)} y={Y(os + oh)} width={ow * s} height={oh * s} color={color.hairline} style="stroke" strokeWidth={2} />;
                })}

                {/* The feature being placed */}
                <Rect x={box.x} y={box.y} width={box.w} height={box.h} color={drag ? 'rgba(234,88,12,0.28)' : color.accentSoft} />
                <Rect x={box.x} y={box.y} width={box.w} height={box.h} color={color.accent} style="stroke" strokeWidth={3} />
                {isWindow ? (
                  <>
                    <Line p1={vec(box.x + box.w / 2, box.y)} p2={vec(box.x + box.w / 2, box.y + box.h)} strokeWidth={1.5} color={color.accent} />
                    <Line p1={vec(box.x, box.y + box.h / 2)} p2={vec(box.x + box.w, box.y + box.h / 2)} strokeWidth={1.5} color={color.accent} />
                  </>
                ) : null}
                {f.type === 'door' ? <Circle cx={box.x + box.w * 0.85} cy={Y(990)} r={4} color={color.accent} /> : null}
                {f.type === 'steps' ? (
                  <Path
                    path={(() => {
                      const p = Skia.PathBuilder.Make(); const n = 3;
                      p.moveTo(box.x, floorY);
                      for (let i = 0; i < n; i++) { p.lineTo(box.x + (box.w * i) / n, Y((height * (i + 1)) / n)); p.lineTo(box.x + (box.w * (i + 1)) / n, Y((height * (i + 1)) / n)); }
                      return p.build();
                    })()}
                    style="stroke" strokeWidth={2} color={color.accent}
                  />
                ) : null}

                {/* Dimension chain under the floor */}
                <DimLine x1={X(0)} x2={X(offset)} y={floorY + 26} />
                <DimLine x1={X(offset)} x2={X(offset + width)} y={floorY + 26} />
                <DimLine x1={X(offset + width)} x2={X(L)} y={floorY + 26} />
                {/* Vertical dimensions beside the opening */}
                {isWindow ? <VDimLine x={X(offset + width) + 22} y1={floorY} y2={Y(sill)} /> : null}
                {f.type !== 'opening' ? <VDimLine x={X(offset + width) + 22} y1={Y(sill)} y2={Y(sill + height)} /> : null}
              </Canvas>
            ) : null}
          </View>
        </GestureDetector>

        {s > 0 ? (
          <>
            <DimChip x={(X(0) + X(offset)) / 2} y={floorY + 26} text={fmt(offset, 'offset')} active={isArmed('offset')} onPress={() => onArm(target('offset'))} />
            <DimChip x={(X(offset) + X(offset + width)) / 2} y={floorY + 26} text={fmt(width, 'width')} active={isArmed('width')} onPress={() => onArm(target('width'))} />
            {right > 1 ? <DimChip x={(X(offset + width) + X(L)) / 2} y={floorY + 26} text={`${formatLength(right, unit, step)}`} muted /> : null}
            {isWindow ? <DimChip x={X(offset + width) + 22} y={(floorY + Y(sill)) / 2} text={fmt(sill, 'sill')} active={isArmed('sill')} onPress={() => onArm(target('sill'))} side /> : null}
            {f.type !== 'opening' ? (
              <DimChip
                x={X(offset + width) + 22} y={(Y(sill) + Y(sill + height)) / 2}
                text={fmt(height, f.type === 'steps' ? 'rise' : 'height')}
                active={isArmed(f.type === 'steps' ? 'rise' : 'height')}
                onPress={() => onArm(target(f.type === 'steps' ? 'rise' : 'height'))}
                side
              />
            ) : null}
            <Text style={[styles.hint, { top: 6 }]} pointerEvents="none">
              {drag ? `${formatLength(drag.offset, unit, step)} from corner${isWindow ? ` · sill ${formatLength(drag.sill, unit, step)}` : ''}` : `Drag to move the ${label.toLowerCase()}${isWindow ? ' (up, down, sideways)' : ''}`}
            </Text>
          </>
        ) : null}
      </View>

      {/* Dimensions list: tap to aim the tape, or type it */}
      <View style={styles.list}>
        {dims.map((d) => {
          const t = target(d.key);
          const v = val(d.key);
          const on = isArmed(d.key);
          return (
            <Pressable key={d.key} onPress={() => onArm(t)} style={[styles.row, on && styles.rowOn]} accessibilityRole="button" accessibilityLabel={`${d.label}, ${v.measured ? 'measured' : 'not measured'}`}>
              <View style={[styles.dot, { backgroundColor: v.measured ? color.ok : on ? color.accent : color.hairline }]} />
              <Text style={[type.label, { flex: 1 }]}>{d.label}</Text>
              <Text style={[type.body, type.num, !v.measured && { color: color.fgMuted }]}>
                {v.measured ? formatLength(v.mm, unit, 1.5875) : `≈ ${formatLength(v.mm, unit, step)}`}
              </Text>
              <Pressable onPress={() => setKeypadFor(t)} hitSlop={8} style={styles.typeBtn} accessibilityLabel={`Input ${d.label} manually`}>
                <Text style={type.label}>Input</Text>
              </Pressable>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.footer}>
        <Btn label="Center on wall" variant="outline" onPress={() => { onMove(snap((L - width) / 2)); Haptics.selectionAsync(); }} flex />
        {tapeReady ? <Btn label="Tape it" variant="accent" onPress={onTape} disabled={!armed || armed.refId !== f.id} flex /> : null}
      </View>

      <Keypad
        visible={!!keypadFor}
        title={`${label} · ${dims.find((d) => d.key === keypadFor?.dim)?.label ?? ''}`}
        unitSystem={unit}
        onClose={() => setKeypadFor(null)}
        onSubmit={(raw, source) => { const t = keypadFor!; setKeypadFor(null); onTyped(t, raw, source); }}
      />
    </SafeAreaView>
  );
}

function DimLine({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  if (x2 - x1 < 2) return null;
  return (
    <>
      <Line p1={vec(x1, y)} p2={vec(x2, y)} strokeWidth={1.5} color={color.fgMuted} />
      <Line p1={vec(x1, y - 7)} p2={vec(x1, y + 7)} strokeWidth={1.5} color={color.fgMuted} />
      <Line p1={vec(x2, y - 7)} p2={vec(x2, y + 7)} strokeWidth={1.5} color={color.fgMuted} />
    </>
  );
}

function VDimLine({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  if (Math.abs(y2 - y1) < 2) return null;
  return (
    <>
      <Line p1={vec(x, y1)} p2={vec(x, y2)} strokeWidth={1.5} color={color.fgMuted} />
      <Line p1={vec(x - 7, y1)} p2={vec(x + 7, y1)} strokeWidth={1.5} color={color.fgMuted} />
      <Line p1={vec(x - 7, y2)} p2={vec(x + 7, y2)} strokeWidth={1.5} color={color.fgMuted} />
    </>
  );
}

function DimChip({ x, y, text, active, muted, side, onPress }: {
  x: number; y: number; text: string; active?: boolean; muted?: boolean; side?: boolean; onPress?: () => void;
}) {
  const W = 112, Hh = 34;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      style={[
        styles.chip,
        { left: side ? x + 8 : x - W / 2, top: y - Hh / 2, width: W, height: Hh },
        active && { backgroundColor: color.accent, borderColor: color.fg },
        muted && { backgroundColor: color.muted, borderStyle: 'dashed' },
      ]}
    >
      <Text style={[type.label, type.num, { color: active ? color.onAccent : color.fg, fontSize: 14 }]} numberOfLines={1} adjustsFontSizeToFit>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: sp.md, paddingHorizontal: sp.lg, paddingVertical: sp.md, backgroundColor: color.card, borderBottomWidth: 1.5, borderBottomColor: color.border },
  drawing: { flex: 1, minHeight: 260, backgroundColor: color.muted },
  hint: { position: 'absolute', alignSelf: 'center', ...type.small, color: color.fg, backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  chip: { position: 'absolute', alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, borderWidth: 2, borderColor: color.border, borderRadius: radius.sm, paddingHorizontal: 6 },
  list: { paddingHorizontal: sp.lg, paddingTop: sp.md, gap: sp.xs, backgroundColor: color.card, borderTopWidth: 1.5, borderTopColor: color.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: sp.md, minHeight: 56, paddingHorizontal: sp.md, borderRadius: radius.md, borderWidth: 2, borderColor: 'transparent' },
  rowOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  dot: { width: 12, height: 12, borderRadius: 6 },
  typeBtn: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.border, backgroundColor: color.card },
  footer: { flexDirection: 'row', gap: sp.sm, padding: sp.lg, backgroundColor: color.card },
});
