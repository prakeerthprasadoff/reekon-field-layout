// Marcus's office view: live, read-only layout with an inspector, totals, and one write
// action: flag a measurement for re-measure. The server also rejects any other op from
// an office client, so "read-only" isn't just a UI promise.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  FEATURE_DIMS, FEATURE_LABEL, diagnoseClosure, spaceStatus, featureSize, formatArea, formatDecimalInches, formatLength, formatMetric,
  listTargets, measurementForTarget, resolveFeature, resolveShape, sameTarget, targetKey, targetLabel,
  type Flag, type FlagReason, type Measurement, type Pt, type Space, type Target, type UnitSystem,
} from '@field/shared';
import { LayoutCanvas, type CanvasHandle } from '@/canvas/LayoutCanvas';
import { closureLines, sourceLabel, timeAgo } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { newId } from '@/lib/storage';
import { commit, openProject, useProjectDoc, useSync } from '@/sync/engine';
import { Btn, Chip, SyncPill } from '@/ui/components';
import { color, radius, space as sp, type } from '@/ui/theme';

const REASONS: { key: FlagReason; label: string }[] = [
  { key: 'doesnt-match-plan', label: "Doesn't match plan" },
  { key: 'closure-error', label: "Walls don't close" },
  { key: 'looks-off', label: 'Looks off' },
  { key: 'other', label: 'Other' },
];

export default function OfficeProject() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const doc = useProjectDoc(id);
  const presenceMap = useSync((s) => (id ? s.presence[id] : undefined));
  const { width, height } = useWindowDimensions();
  const wide = width >= 820 || width > height;
  const canvas = useRef<CanvasHandle>(null);

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [follow, setFollow] = useState(true);
  const [recent, setRecent] = useState<Set<string>>(new Set());

  useEffect(() => { if (id) openProject(id); }, [id]);

  // Default / follow the field user's space
  const fieldPresence = useMemo(() => {
    const ps = Object.values(presenceMap ?? {}).filter((p) => p.role === 'field' && p.spaceId);
    return ps.sort((a, b) => b.at - a.at)[0];
  }, [presenceMap]);

  useEffect(() => {
    if (!doc) return;
    if (follow && fieldPresence?.spaceId && doc.spaces[fieldPresence.spaceId] && fieldPresence.spaceId !== spaceId) {
      setSpaceId(fieldPresence.spaceId);
      setTimeout(() => canvas.current?.fit(), 60);
      return;
    }
    if (!spaceId || !doc.spaces[spaceId]) setSpaceId(doc.spaceOrder[doc.spaceOrder.length - 1] ?? null);
  }, [doc, follow, fieldPresence?.spaceId, spaceId]);

  const space = doc && spaceId ? doc.spaces[spaceId] : undefined;
  const unit = doc?.unitSystem ?? 'imperial';
  const rs = useMemo(() => (space?.shape?.edges.length ? resolveShape(space.shape, space.measurements) : null), [space]);

  // Pulse labels whose measurement just arrived from the field.
  const prevMeasurements = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!space) return;
    const ids = new Set(Object.keys(space.measurements));
    if (prevMeasurements.current) {
      const fresh = [...ids].filter((m) => !prevMeasurements.current!.has(m)).map((m) => space.measurements[m]);
      if (fresh.length) {
        const keys = fresh.map((m) => targetKey(m.target.kind === 'feature' ? { ...m.target, dim: mainDim(space, m.target.refId) } : m.target));
        setRecent((r) => new Set([...r, ...keys]));
        setTimeout(() => setRecent((r) => { const n = new Set(r); keys.forEach((k) => n.delete(k)); return n; }), 2500);
      }
    }
    prevMeasurements.current = ids;
  }, [space]);
  useEffect(() => { prevMeasurements.current = null; }, [spaceId]);

  // Follow mode: frame whatever Dana is measuring.
  const followTarget = fieldPresence?.spaceId === spaceId ? fieldPresence?.target ?? null : null;
  useEffect(() => {
    if (!follow || !followTarget || !space || !rs) return;
    const p = targetPoint(space, rs, followTarget);
    if (p) canvas.current?.focusOn(p);
  }, [follow, followTarget, space, rs]);

  if (!doc) {
    return <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={type.body}>Waiting for this job to sync…</Text></SafeAreaView>;
  }
  if (doc.deleted) {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: sp.lg }}>
        <Text style={type.title}>{doc.name} was deleted by the field crew.</Text>
        <Btn label="Back to jobs" size="office" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const fieldLive = fieldPresence && Date.now() - fieldPresence.at < 5 * 60_000;
  const liveText = fieldLive
    ? `${fieldPresence!.name} · live${fieldPresence!.spaceId && doc.spaces[fieldPresence!.spaceId] ? ` in ${doc.spaces[fieldPresence!.spaceId].name}` : ''}${followTarget && space ? ` · ${targetLabel(space, followTarget)}` : ''}`
    : 'No one in the field right now';

  const side = space ? (
    <ScrollView contentContainerStyle={{ padding: sp.lg, gap: sp.lg }}>
      {selected ? <Inspector space={space} target={selected} unit={unit} projectId={id!} onClose={() => setSelected(null)} /> : (
        <Text style={type.small}>Tap any measurement on the layout to inspect it.</Text>
      )}
      <Totals space={space} unit={unit} onSelect={setSelected} />
    </ScrollView>
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Btn label="‹" variant="ghost" size="office" onPress={() => router.back()} accessibilityLabel="Back" style={{ paddingHorizontal: sp.md }} />
        <View style={{ flex: 1 }}>
          <Text style={type.title} numberOfLines={1}>{doc.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[styles.liveDot, { backgroundColor: fieldLive ? color.ok : color.hairline }]} />
            <Text style={type.small} numberOfLines={1}>{liveText}</Text>
          </View>
        </View>
        <SyncPill />
      </View>
      <ScrollView horizontal style={styles.tabs} contentContainerStyle={{ gap: sp.sm, padding: sp.sm }} showsHorizontalScrollIndicator={false}>
        {doc.spaceOrder.map((s) => {
          const flags = Object.values(doc.spaces[s].flags).filter((f) => f.status === 'open').length;
          return (
            <Chip key={s} label={`${spaceStatus(doc.spaces[s]).ready ? '✓ ' : ''}${doc.spaces[s].name}${flags ? ` ⚑${flags}` : ''}${fieldPresence?.spaceId === s ? ' •' : ''}`} active={s === spaceId}
              onPress={() => { setSpaceId(s); setSelected(null); if (fieldPresence?.spaceId !== s) setFollow(false); setTimeout(() => canvas.current?.fit(), 60); }} />
          );
        })}
        {doc.spaceOrder.length === 0 ? <Text style={[type.small, { padding: sp.sm }]}>No spaces yet</Text> : null}
      </ScrollView>

      <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
        <View style={{ flex: 1 }}>
          {space ? (
            <LayoutCanvas
              ref={canvas}
              space={space}
              unitSystem={unit}
              selected={selected}
              armed={followTarget}
              density="office"
              recent={recent}
              onLabelPress={(t) => setSelected(t)}
              onTapWorld={() => setSelected(null)}
              onUserMove={() => setFollow(false)}
            />
          ) : <View style={{ flex: 1 }} />}
          <View style={styles.tools}>
            <Btn label={follow ? 'Following ◉' : 'Follow ○'} variant={follow ? 'accent' : 'outline'} size="office" onPress={() => { setFollow(!follow); if (!follow) canvas.current?.fit(); }} />
            <Btn label="Fit" variant="outline" size="office" onPress={() => canvas.current?.fit()} />
            <Btn label="−" variant="outline" size="office" onPress={() => canvas.current?.zoomBy(0.7)} accessibilityLabel="Zoom out" />
            <Btn label="+" variant="outline" size="office" onPress={() => canvas.current?.zoomBy(1.4)} accessibilityLabel="Zoom in" />
          </View>
        </View>
        <View style={wide ? styles.sideWide : styles.sideNarrow}>{side}</View>
      </View>
    </SafeAreaView>
  );
}

function mainDim(space: Space, featureId: string): string | undefined {
  const f = space.features[featureId];
  if (!f) return undefined;
  const dims = FEATURE_DIMS[f.type];
  return (dims.find((d) => d.key === 'width' || d.key === 'size' || d.key === 'length') ?? dims[0]).key;
}

function targetPoint(space: Space, rs: ReturnType<typeof resolveShape>, t: Target): Pt | null {
  if (t.kind === 'edge') {
    const e = rs.edges.find((x) => x.id === t.refId);
    return e ? { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 } : null;
  }
  const f = space.features[t.refId];
  const rf = f ? resolveFeature(f, rs, space.measurements) : null;
  return rf ? { x: (rf.p0.x + rf.p1.x) / 2, y: (rf.p0.y + rf.p1.y) / 2 } : null;
}

function Inspector({ space, target, unit, projectId, onClose }: { space: Space; target: Target; unit: UnitSystem; projectId: string; onClose: () => void }) {
  const me = useSettings((s) => s.name);
  const [flagging, setFlagging] = useState(false);
  const [reason, setReason] = useState<FlagReason>('looks-off');
  const [note, setNote] = useState('');

  // A feature label opens the feature: show every dimension.
  const targets: Target[] = target.kind === 'feature'
    ? FEATURE_DIMS[space.features[target.refId]?.type ?? 'post']
        .filter((d) => d.key !== 'offset' || 'edgeId' in (space.features[target.refId]?.anchor ?? {}))
        .map((d) => ({ kind: 'feature', refId: target.refId, dim: d.key }))
    : [target];
  const [active, setActive] = useState<Target>(target);
  useEffect(() => { setActive(target); setFlagging(false); }, [target]);

  const m = measurementForTarget(space, active);
  const history: Measurement[] = [];
  for (let cur = m; cur; cur = cur.supersedes ? space.measurements[cur.supersedes] : undefined) history.push(cur);
  const flags = Object.values(space.flags).filter((f) => sameTarget(f.target, active)).sort((a, b) => b.raisedAt - a.raisedAt);
  const openFlag = flags.find((f) => f.status === 'open');
  const est = !m ? estimated(space, active) : null;

  const send = () => {
    if (!m) return;
    const flag: Flag = {
      id: newId(), measurementId: m.id, target: active, raisedBy: me || 'Office', raisedAt: Date.now(),
      reason, note: note.trim() || undefined, status: 'open',
    };
    commit(projectId, { type: 'raiseFlag', spaceId: space.id, flag });
    setFlagging(false); setNote('');
  };

  const title = target.kind === 'feature'
    ? `${FEATURE_LABEL[space.features[target.refId]?.type ?? 'post']}`
    : targetLabel(space, target);

  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[type.title, { flex: 1 }]}>{title}</Text>
        <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close inspector"><Text style={type.label}>✕</Text></Pressable>
      </View>
      {targets.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {targets.map((t) => <Chip key={t.dim} label={FEATURE_DIMS[space.features[t.refId].type].find((d) => d.key === t.dim)!.label} active={sameTarget(t, active)} onPress={() => setActive(t)} />)}
        </View>
      ) : null}

      {m ? (
        <>
          <Text style={[type.display, { fontSize: 36 }]}>{formatLength(m.valueMm, unit, m.precisionMm)}</Text>
          <Text style={[type.body, type.num]}>{formatDecimalInches(m.valueMm)}  ·  {formatMetric(m.valueMm)}</Text>
          <Text style={type.small}>As read: “{m.raw}”{m.angleDeg !== undefined ? ` · angle ${m.angleDeg.toFixed(1)}°` : ''}</Text>
          <View style={[styles.source, m.source === 'ble-tape' || m.source === 'caliper' ? { backgroundColor: color.okSoft } : { backgroundColor: color.accentSoft }]}>
            <Text style={type.label}>{sourceLabel(m.source)} · {m.takenBy} · {timeAgo(m.takenAt)}</Text>
          </View>
        </>
      ) : (
        <>
          <Text style={[type.title, { color: color.estimated }]}>Not measured yet</Text>
          {est ? <Text style={type.body}>Drawn/estimated at ≈ {formatLength(est, unit, 25.4)}. Don't quote from this.</Text> : null}
        </>
      )}

      {history.length > 1 ? (
        <View style={{ gap: 4 }}>
          <Text style={type.label}>Retakes</Text>
          {history.slice(1).map((h) => (
            <Text key={h.id} style={[type.small, type.num]}>{formatLength(h.valueMm, unit, h.precisionMm)} · {sourceLabel(h.source)} · {timeAgo(h.takenAt)} (replaced)</Text>
          ))}
        </View>
      ) : null}

      {flags.length ? (
        <View style={{ gap: 4 }}>
          <Text style={type.label}>Flags</Text>
          {flags.map((f) => <FlagRow key={f.id} f={f} space={space} unit={unit} />)}
        </View>
      ) : null}

      {m && !openFlag ? (
        flagging ? (
          <View style={{ gap: sp.sm }}>
            <Text style={type.label}>Why should the field re-measure?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {REASONS.map((r) => <Chip key={r.key} label={r.label} active={reason === r.key} onPress={() => setReason(r.key)} />)}
            </View>
            <TextInput value={note} onChangeText={setNote} placeholder="Note for the crew (optional)" placeholderTextColor={color.fgMuted} style={styles.input} />
            <View style={{ flexDirection: 'row', gap: sp.sm }}>
              <Btn label="Cancel" variant="ghost" size="office" onPress={() => setFlagging(false)} flex />
              <Btn label="Send flag" variant="danger" size="office" onPress={send} flex />
            </View>
          </View>
        ) : (
          <Btn label="⚑ Flag for re-measure" variant="outline" size="office" onPress={() => setFlagging(true)} />
        )
      ) : null}
      {openFlag && openFlag.raisedBy === me ? (
        <Btn label="Withdraw flag" variant="ghost" size="office" onPress={() => commit(projectId, { type: 'withdrawFlag', spaceId: space.id, flagId: openFlag.id })} />
      ) : null}
      <Text style={[type.small, { fontSize: 11 }]}>Office can flag but never edit measurements.</Text>
    </View>
  );
}

function FlagRow({ f, space, unit }: { f: Flag; space: Space; unit: UnitSystem }) {
  const reason = REASONS.find((r) => r.key === f.reason)?.label ?? f.reason;
  const before = space.measurements[f.measurementId];
  const after = f.resolvingMeasurementId ? space.measurements[f.resolvingMeasurementId] : undefined;
  const status =
    f.status === 'open' ? 'Waiting for field' :
    f.status === 'remeasured' ? `Re-measured${before && after ? `: ${formatLength(before.valueMm, unit, before.precisionMm)} → ${formatLength(after.valueMm, unit, after.precisionMm)}` : ''}` :
    f.status === 'confirmed' ? `${f.resolvedBy ?? 'Field'} confirmed the value` : 'Withdrawn';
  const bg = f.status === 'open' ? color.dangerSoft : f.status === 'withdrawn' ? color.muted : color.okSoft;
  return (
    <View style={[styles.flagRow, { backgroundColor: bg }]}>
      <Text style={type.label}>⚑ {reason}{f.note ? ` · “${f.note}”` : ''}</Text>
      <Text style={type.small}>{f.raisedBy} · {timeAgo(f.raisedAt)} · {status}</Text>
    </View>
  );
}

function estimated(space: Space, t: Target): number | null {
  if (t.kind === 'edge' && space.shape) {
    const rs = resolveShape(space.shape, space.measurements);
    return rs.edges.find((e) => e.id === t.refId)?.lengthMm ?? null;
  }
  const f = space.features[t.refId];
  return f && t.dim ? featureSize(f, t.dim, space.measurements).mm : null;
}

function Totals({ space, unit, onSelect }: { space: Space; unit: UnitSystem; onSelect: (t: Target) => void }) {
  const rs = space.shape?.edges.length ? resolveShape(space.shape, space.measurements) : null;
  const targets = listTargets(space);
  const unmeasured = targets.filter((t) => !t.measured);
  const openFlags = Object.values(space.flags).filter((f) => f.status === 'open');
  const features = Object.values(space.features);
  const openingsMm = features
    .filter((f) => 'edgeId' in f.anchor && f.type !== 'steps')
    .reduce((s, f) => s + featureSize(f, 'width', space.measurements).mm, 0);
  const allMeasured = !!rs && rs.edges.every((e) => e.status === 'measured');

  return (
    <View style={styles.card}>
      <Text style={type.title}>Totals · {space.name}</Text>
      {rs ? (
        <>
          {rs.closed ? <Row k="Area" v={formatArea(rs.areaMm2, unit)} est={!allMeasured} /> : null}
          <Row k={rs.closed ? 'Perimeter' : 'Run length'} v={formatLength(rs.perimeterMm, unit, 25.4)} est={!allMeasured} />
          {features.length ? <Row k="Wall less openings" v={formatLength(Math.max(0, rs.perimeterMm - openingsMm), unit, 25.4)} est={!allMeasured} /> : null}
          {rs.closed && allMeasured ? (
            <Row k="Closure" v={rs.closureGapMm > 3 ? `off by ${formatLength(rs.closureGapMm, unit, 1.5875)}` : 'closes ✓'} warn={rs.closureGapMm > 3} />
          ) : null}
          {(() => {
            const d = diagnoseClosure(rs);
            return d ? closureLines(d, unit).map((line) => <Text key={line} style={[type.small, { color: color.danger }]}>{line}</Text>) : null;
          })()}
        </>
      ) : <Text style={type.small}>No shape yet.</Text>}
      {spaceStatus(space).ready ? <Row k="Status" v="✓ Good to go" ok /> : null}
      <Row k="Measured" v={`${targets.length - unmeasured.length} of ${targets.length}`} warn={unmeasured.length > 0} />
      {openFlags.length ? <Row k="Open flags" v={`${openFlags.length}`} warn /> : null}

      {unmeasured.length ? (
        <View style={{ gap: 4 }}>
          <Text style={type.label}>Still estimated</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {unmeasured.slice(0, 12).map((t) => <Chip key={targetKey(t.target)} label={t.label} onPress={() => onSelect(t.target)} />)}
          </View>
        </View>
      ) : null}

      {features.length ? (
        <View style={{ gap: 4 }}>
          <Text style={type.label}>Openings & features</Text>
          {features.map((f, i) => {
            const w = featureSize(f, FEATURE_DIMS[f.type].find((d) => d.key === 'width' || d.key === 'size' || d.key === 'length')!.key, space.measurements);
            const h = FEATURE_DIMS[f.type].some((d) => d.key === 'height') ? featureSize(f, 'height', space.measurements) : null;
            return (
              <Pressable key={f.id} onPress={() => onSelect({ kind: 'feature', refId: f.id, dim: 'width' })}>
                <Text style={[type.small, type.num, { color: color.fg }]}>
                  {FEATURE_LABEL[f.type]} {i + 1}: {w.measured ? '' : '≈'}{formatLength(w.mm, unit, w.measured ? 1.5875 : 25.4)}
                  {h ? ` × ${h.measured ? '' : '≈'}${formatLength(h.mm, unit, h.measured ? 1.5875 : 25.4)}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Row({ k, v, est, warn, ok }: { k: string; v: string; est?: boolean; warn?: boolean; ok?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={type.body}>{k}</Text>
      <Text style={[type.body, type.num, { fontWeight: '800', color: warn ? color.danger : ok ? color.ok : color.fg }]}>{est ? '≈ ' : ''}{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: sp.md, paddingHorizontal: sp.lg, paddingVertical: sp.sm, backgroundColor: color.card, borderBottomWidth: 1.5, borderBottomColor: color.border },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  tabs: { flexGrow: 0, backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.hairline },
  tools: { position: 'absolute', right: sp.md, top: sp.md, flexDirection: 'row', gap: sp.sm },
  sideWide: { width: 360, borderLeftWidth: 1.5, borderLeftColor: color.border, backgroundColor: color.bg },
  sideNarrow: { maxHeight: '45%', borderTopWidth: 1.5, borderTopColor: color.border, backgroundColor: color.bg },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.border, padding: sp.lg, gap: sp.sm },
  source: { borderRadius: radius.sm, paddingHorizontal: sp.sm, paddingVertical: 6, alignSelf: 'flex-start' },
  flagRow: { borderRadius: radius.sm, padding: sp.sm, gap: 2 },
  input: { minHeight: 44, borderWidth: 2, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: sp.md, fontSize: 16, color: color.fg, backgroundColor: color.card },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
});
