import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Role } from '@field/shared';
import { useSettings } from '@/lib/settings';
import { restartSync } from '@/sync/engine';
import { Btn } from '@/ui/components';
import { color, radius, space, type } from '@/ui/theme';

const ROLES: { role: Role; title: string; body: string; icon: string }[] = [
  { role: 'field', title: 'Field', body: 'Lay out spaces on site and take measurements.', icon: 'F' },
  { role: 'office', title: 'Office', body: 'Watch layouts arrive live, inspect, flag for re-measure.', icon: 'O' },
];

export default function Setup() {
  const router = useRouter();
  const saved = useSettings();
  const [name, setName] = useState(saved.name);
  const [role, setRole] = useState<Role | null>(null);

  if (saved.role && saved.name) return <Redirect href="/projects" />;

  const go = () => {
    if (!role || !name.trim()) return;
    saved.setProfile(name.trim(), role);
    restartSync();
    router.replace('/projects');
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <Text style={[type.display, { fontSize: 34 }]}>Field Layout</Text>
        <Text style={[type.body, { color: color.fgMuted, marginBottom: space.xl }]}>Who's using this device?</Text>

        <Text style={type.label}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Dana"
          placeholderTextColor={color.fgMuted}
          style={styles.input}
          autoCapitalize="words"
          returnKeyType="done"
        />

        <View style={styles.roles}>
          {ROLES.map((r) => (
            <Pressable
              key={r.role}
              onPress={() => setRole(r.role)}
              accessibilityRole="radio"
              accessibilityState={{ selected: role === r.role }}
              style={[styles.role, role === r.role && styles.roleOn]}
            >
              <View style={styles.badge}><Text style={[type.title, { color: color.onPrimary }]}>{r.icon}</Text></View>
              <Text style={type.title}>{r.title}</Text>
              <Text style={[type.small, { textAlign: 'center' }]}>{r.body}</Text>
            </Pressable>
          ))}
        </View>

        <Btn label="Continue" variant="accent" onPress={go} disabled={!role || !name.trim()} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: space.xl, justifyContent: 'center', maxWidth: 560, width: '100%', alignSelf: 'center' },
  input: {
    minHeight: 56, borderWidth: 2, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: space.lg,
    fontSize: 20, color: color.fg, backgroundColor: color.card, marginTop: space.sm, marginBottom: space.xl,
  },
  roles: { flexDirection: 'row', gap: space.md, marginBottom: space.xl },
  role: {
    flex: 1, alignItems: 'center', gap: space.sm, padding: space.lg, borderRadius: radius.lg, borderWidth: 2,
    borderColor: color.border, backgroundColor: color.card, minHeight: 170, justifyContent: 'center',
  },
  badge: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' },
  roleOn: { borderColor: color.accent, borderWidth: 4, backgroundColor: color.accentSoft },
});
