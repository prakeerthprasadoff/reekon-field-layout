import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '@/lib/settings';
import { commit, createProject, purgeDeleted, restoreProject, setServerUrl, useDeletedProjects, useProjectList, useSync } from '@/sync/engine';
import { Btn, Card, Chip, DeleteButton, Header, SyncPill } from '@/ui/components';
import { color, radius, space, type } from '@/ui/theme';

export default function Projects() {
  const router = useRouter();
  const { role, name, reset } = useSettings();
  const projects = useProjectList();
  const deleted = useDeletedProjects();
  const url = useSync((s) => s.url);
  const status = useSync((s) => s.status);
  const [creating, setCreating] = useState(false);
  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [units, setUnits] = useState<'imperial' | 'metric'>('imperial');
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const isField = role === 'field';

  const open = (id: string) => router.push(isField ? { pathname: '/project/[id]', params: { id } } : { pathname: '/office/[id]', params: { id } });

  const create = () => {
    if (!jobName.trim()) return;
    const id = createProject(jobName.trim(), address.trim() || undefined, units);
    setCreating(false); setJobName(''); setAddress('');
    open(id);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right']}>
      <Header
        title="Jobs"
        subtitle={`${name} · ${isField ? 'Field' : 'Office'}`}
        right={
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <SyncPill />
            <Pressable onPress={() => { reset(); router.replace('/'); }} hitSlop={10} accessibilityLabel="Switch role" style={styles.switch}>
              <Text style={type.small}>Switch</Text>
            </Pressable>
          </View>
        }
      />
      <FlatList
        contentContainerStyle={styles.list}
        data={projects}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          isField ? (
            creating ? (
              <Card style={{ gap: space.md }}>
                <Text style={type.title}>New job</Text>
                <TextInput style={styles.input} placeholder="Client / job name" placeholderTextColor={color.fgMuted} value={jobName} onChangeText={setJobName} autoFocus />
                <TextInput style={styles.input} placeholder="Address (optional)" placeholderTextColor={color.fgMuted} value={address} onChangeText={setAddress} />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Chip label="ft · in" active={units === 'imperial'} onPress={() => setUnits('imperial')} />
                  <Chip label="metric" active={units === 'metric'} onPress={() => setUnits('metric')} />
                </View>
                <View style={{ flexDirection: 'row', gap: space.md }}>
                  <Btn label="Cancel" variant="ghost" onPress={() => setCreating(false)} flex />
                  <Btn label="Create" variant="accent" onPress={create} disabled={!jobName.trim()} flex />
                </View>
              </Card>
            ) : (
              <Btn label="New job" icon="+" variant="accent" onPress={() => setCreating(true)} />
            )
          ) : undefined
        }
        ListEmptyComponent={
          <Text style={[type.body, { color: color.fgMuted, textAlign: 'center', marginTop: space.xxl }]}>
            {isField ? 'No jobs yet. Start one above.' : status === 'online' ? 'No jobs yet. They appear here as soon as the field creates one.' : 'Waiting for the sync server…'}
          </Text>
        }
        renderItem={({ item }) => (
          <Card onPress={() => open(item.id)} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={type.title}>{item.name}</Text>
              {item.address ? <Text style={type.small}>{item.address}</Text> : null}
            </View>
            <Text style={type.label}>{item.spaceCount} space{item.spaceCount === 1 ? '' : 's'}</Text>
            {isField ? (
              <DeleteButton
                accessibilityLabel={`Delete job ${item.name}`}
                confirmLabel="Tap to delete job"
                onConfirm={() => commit(item.id, { type: 'deleteProject' })}
              />
            ) : <Text style={type.label}>›</Text>}
          </Card>
        )}
        ListFooterComponent={
          <View style={{ marginTop: space.xxl, gap: space.sm }}>
            {isField && deleted.length ? (
              <View style={{ gap: space.sm, marginBottom: space.lg }}>
                <View style={styles.deletedHead}>
                  <Text style={[type.label, { flex: 1 }]}>Recently deleted</Text>
                  {status === 'online' ? (
                    <DeleteButton
                      strong
                      label="Clear all"
                      confirmLabel="Erase forever?"
                      accessibilityLabel="Permanently erase all deleted jobs"
                      onConfirm={() => purgeDeleted(deleted.map((p) => p.id))}
                    />
                  ) : null}
                </View>
                {deleted.map((p) => (
                  <View key={p.id} style={styles.deletedRow}>
                    <Text style={[type.body, { flex: 1, color: color.fgMuted }]} numberOfLines={1}>{p.name}</Text>
                    <Btn label="Restore" variant="outline" size="office" disabled={status !== 'online'} onPress={() => restoreProject(p.id)} />
                  </View>
                ))}
              </View>
            ) : null}
            {editUrl === null ? (
              <Pressable onPress={() => setEditUrl(url)} hitSlop={8}>
                <Text style={[type.small, { textAlign: 'center' }]}>Sync server: {url} (tap to change)</Text>
              </Pressable>
            ) : (
              <Card style={{ gap: space.sm }}>
                <TextInput style={styles.input} value={editUrl} onChangeText={setEditUrl} autoCapitalize="none" autoCorrect={false} />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Btn label="Auto-detect" variant="ghost" size="office" flex onPress={() => { setServerUrl(null); setEditUrl(null); }} />
                  <Btn label="Save" size="office" flex onPress={() => { setServerUrl(editUrl.trim()); setEditUrl(null); }} />
                </View>
              </Card>
            )}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, gap: space.md, maxWidth: 720, width: '100%', alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 72 },
  input: {
    minHeight: 52, borderWidth: 2, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: space.md,
    fontSize: 18, color: color.fg, backgroundColor: color.card,
  },
  switch: { paddingHorizontal: space.sm, paddingVertical: 6 },
  deletedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 },
  deletedHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
