// Gloved manual entry: big keys, fractions as single taps, live "this is what I understood".
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatLength, parseLength, type Source, type UnitSystem } from '@field/shared';
import { Btn, Chip } from '../ui/components';
import { color, radius, space, touch, type } from '../ui/theme';

const IMPERIAL_ROWS = [
  ['7', '8', '9', 'ft'],
  ['4', '5', '6', 'in'],
  ['1', '2', '3', '⌫'],
  ['.', '0', ' ', 'C'],
];
const METRIC_ROWS = [
  ['7', '8', '9', 'm'],
  ['4', '5', '6', 'mm'],
  ['1', '2', '3', '⌫'],
  ['.', '0', 'cm', 'C'],
];
const FRACTIONS = ['1/2', '1/4', '3/4', '1/8', '3/8', '5/8', '7/8', '1/16'];

export function Keypad({ visible, title, unitSystem, onSubmit, onClose }: {
  visible: boolean; title: string; unitSystem: UnitSystem;
  onSubmit: (raw: string, source: Source) => void; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [source, setSource] = useState<Source>('manual');
  const parsed = text.trim() ? parseLength(text, unitSystem) : null;
  const rows = unitSystem === 'imperial' ? IMPERIAL_ROWS : METRIC_ROWS;

  const press = (k: string) => {
    if (k === '⌫') return setText((t) => t.slice(0, -1));
    if (k === 'C') return setText('');
    if (k === 'ft') return setText((t) => `${t.trimEnd()}' `);
    if (k === 'in') return setText((t) => `${t.trimEnd()}"`);
    if (k === 'm' || k === 'mm' || k === 'cm') return setText((t) => `${t.trimEnd()}${k}`);
    setText((t) => t + k);
  };
  // "12' 4" + 1/2 -> `12' 4 1/2"`; a second fraction replaces the first.
  const frac = (f: string) => setText((t) => `${t.replace(/\s*\d+\/\d+"?$/, '').replace(/"$/, '').trimEnd()} ${f}"`);

  const submit = () => {
    if (!parsed) return;
    onSubmit(text.trim(), source);
    setText('');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={styles.wrap}>
        <View style={styles.top}>
          <Text style={type.title}>{title}</Text>
          <Btn label="Close" variant="ghost" onPress={onClose} />
        </View>
        <View style={styles.display}>
          <Text style={[type.display, { fontSize: 40 }]} numberOfLines={1} adjustsFontSizeToFit>{text || ' '}</Text>
          <Text style={[type.body, { color: parsed ? color.ok : text ? color.danger : color.fgMuted }]}>
            {parsed ? `= ${formatLength(parsed.mm, unitSystem, parsed.precisionMm)}` : text ? "Can't read that yet" : unitSystem === 'imperial' ? 'e.g. 12 ft 4 1/2 in' : 'e.g. 3.77 m'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.md }}>
          <Chip label="Manual" active={source === 'manual'} onPress={() => setSource('manual')} />
          <Chip label="From plan" active={source === 'from-plan'} onPress={() => setSource('from-plan')} />
        </View>
        {unitSystem === 'imperial' ? (
          <View style={styles.fracs}>
            {FRACTIONS.map((f) => (
              <Pressable key={f} onPress={() => frac(f)} style={({ pressed }) => [styles.frac, pressed && styles.pressed]} accessibilityLabel={`${f} inch`}>
                <Text style={type.label}>{f}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={{ gap: space.sm, flex: 1 }}>
          {rows.map((r, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: space.sm, flex: 1 }}>
              {r.map((k) => (
                <Pressable key={k} onPress={() => press(k)} style={({ pressed }) => [styles.key, /[a-z⌫C]/.test(k) && styles.keyAlt, pressed && styles.pressed]} accessibilityLabel={k === ' ' ? 'space' : k}>
                  <Text style={[type.title, { fontSize: 26 }]}>{k === ' ' ? '␣' : k}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
        <Btn label="Use this measurement" variant="accent" onPress={submit} disabled={!parsed} style={{ marginTop: space.md }} />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: space.lg, backgroundColor: color.bg, maxWidth: 560, width: '100%', alignSelf: 'center' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.md },
  display: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 2, borderColor: color.border, padding: space.lg, marginBottom: space.md, minHeight: 110, justifyContent: 'center' },
  fracs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  frac: { width: '23%', minHeight: touch.field - 4, borderRadius: radius.md, backgroundColor: color.accentSoft, borderWidth: 2, borderColor: color.accent, alignItems: 'center', justifyContent: 'center' },
  key: { flex: 1, minHeight: touch.field, borderRadius: radius.md, backgroundColor: color.card, borderWidth: 2, borderColor: color.border, alignItems: 'center', justifyContent: 'center' },
  keyAlt: { backgroundColor: color.muted },
  pressed: { opacity: 0.6, transform: [{ scale: 0.97 }] },
});
