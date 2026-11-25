import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  PRESET_LABEL, formatArea, listTargets, presetShape, resolveShape, spaceStatus,
  type PresetKind, type SpaceKind,
} from '@field/shared';
import { newId } from '@/lib/storage';
import { commit, openProject, useProjectDoc } from '@/sync/engine';
import { Btn, Card, DeleteButton, Header, SyncPill } from '@/ui/components';
import { color, radius, space, type } from '@/ui/theme';

type Start = PresetKind | 'draw' | 'trace';
/** The name already says what it is ("Back deck"), so don't ask twice. */
const kindFromName = (name: string, start: Start): SpaceKind => {
  const n = name.toLowerCase();
  if (start === 'fence' || /fence|rail/.test(n)) return 'fence';
  if (/deck/.test(n)) return 'deck';
  if (/patio|porch|terrace/.test(n)) return 'patio';
  return 'room';
};
const STARTS: { key: Start; label: string; hint: string }[] = [
  { key: 'rect', label: PRESET_LABEL.rect, hint: 'Most rooms, decks, patios' },
  { key: 'L', label: PRESET_LABEL.L, hint: 'Kitchens with a run, wrap decks' },
  { key: 'U', label: PRESET_LABEL.U, hint: 'Courtyards, U kitchens' },
  { key: 'fence', label: PRESET_LABEL.fence, hint: 'Open run, not closed' },
  { key: 'draw', label: 'Draw corners', hint: 'Tap corners on a grid' },
  { key: 'trace', label: 'Irregular', hint: 'Walk the walls as you measure' },
];

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const doc = useProjectDoc(id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState<Start>('rect');

  useEffect(() => { if (id) openProject(id); }, [id]);

  // Job deleted (here or on another device): leave the screen.
  useEffect(() => { if (doc?.deleted) router.back(); }, [doc?.deleted, router]);

  const create = () => {
    if (!id || !name.trim()) return;
    const spaceId = newId();
    commit(id, { type: 'createSpace', spaceId, name: name.trim(), kind: kindFromName(name, start) });
    if (start !== 'draw' && start !== 'trace') {
      commit(id, { type: 'setShape', spaceId, shape: presetShape(start, newId) });
    }
    setAdding(false); setName('');
    router.push({ pathname: '/space/[pid]/[sid]', params: { pid: id, sid: spaceId, start: start === 'draw' || start === 'trace' ? start : 'measure' } });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right']}>
      <Header
        title={doc?.name ?? 'Loading…'}
        subtitle={doc?.address}
        left={<Btn label="‹" variant="ghost" onPress={() => router.back()} accessibilityLabel="Back" style={{ paddingHorizontal: space.md }} />}
        right={<SyncPill />}
      />
      <ScrollView contentContainerStyle={styles.list}>
        {adding ? (
          <Card style={{ gap: space.md }}>
            <Text style={type.title}>New space</Text>
            <TextInput style={styles.input} placeholder="Name, e.g. Kitchen or Back deck" placeholderTextColor={color.fgMuted} value={name} onChangeText={setName} autoFocus />
            <Text style={type.label}>Shape</Text>
            <View style={styles.grid}>
              {STARTS.map((s) => (
                <Card key={s.key} onPress={() => setStart(s.key)} style={[styles.start, start === s.key && styles.startOn]}>
                  <Text style={type.label}>{s.label}</Text>
                  <Text style={type.small}>{s.hint}</Text>
                </Card>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Btn label="Cancel" variant="ghost" onPress={() => setAdding(false)} flex />
              <Btn label="Start" variant="accent" onPress={create} disabled={!name.trim()} flex />
            </View>
          </Card>
        ) : (
          <Btn label="New space" icon="+" variant="accent" onPress={() => setAdding(true)} />
        )}

        {doc?.spaceOrder.map((sid) => {
          const s = doc.spaces[sid];
          const targets = listTargets(s);
          const done = targets.filter((t) => t.measured).length;
          const flags = Object.values(s.flags).filter((f) => f.status === 'open').length;
          const rs = s.shape ? resolveShape(s.shape, s.measurements) : null;
          return (
            <Card key={sid} style={styles.row} onPress={() => router.push({ pathname: '/space/[pid]/[sid]', params: { pid: id!, sid } })}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.title}>{s.name}</Text>
                <Text style={type.small}>
                  {s.kind} · {done}/{targets.length} measured{rs && rs.closed ? ` · ${formatArea(rs.areaMm2, doc.unitSystem)}` : ''}
                </Text>
              </View>
              {flags > 0 ? <Text style={styles.flag}>⚑ {flags}</Text> : spaceStatus(s).ready ? <Text style={styles.go}>✓ Good to go</Text> : null}
              <DeleteButton
                accessibilityLabel={`Delete space ${s.name}`}
                confirmLabel="Tap to delete"
                onConfirm={() => commit(id!, { type: 'deleteSpace', spaceId: sid })}
              />
            </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, gap: space.md, maxWidth: 720, width: '100%', alignSelf: 'center' },
  input: {
    minHeight: 52, borderWidth: 2, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: space.md,
    fontSize: 18, color: color.fg, backgroundColor: color.card,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  start: { width: '48%', minHeight: 72, padding: space.md, gap: 2 },
  startOn: { borderColor: color.accent, borderWidth: 3, backgroundColor: color.accentSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 72 },
  go: { ...type.label, fontSize: 13, color: '#FFFFFF', backgroundColor: color.ok, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  flag: { ...type.label, color: color.onDanger, backgroundColor: color.danger, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
});
