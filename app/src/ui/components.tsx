import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { usePendingCount, useSync } from '../sync/engine';
import { color, radius, space, touch, type } from './theme';

type Variant = 'primary' | 'accent' | 'ghost' | 'danger' | 'outline';

const variantStyle: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: color.primary, fg: color.onPrimary },
  accent: { bg: color.accent, fg: color.onAccent },
  ghost: { bg: color.muted, fg: color.fg },
  danger: { bg: color.danger, fg: color.onDanger },
  outline: { bg: color.card, fg: color.fg, border: color.border },
};

export function Btn({
  label, onPress, onLongPress, variant = 'primary', size = 'field', icon, disabled, style, flex, accessibilityLabel,
}: {
  label: string; onPress: () => void; onLongPress?: () => void; variant?: Variant; size?: 'field' | 'office';
  icon?: string; disabled?: boolean; style?: StyleProp<ViewStyle>; flex?: boolean; accessibilityLabel?: string;
}) {
  const v = variantStyle[variant];
  const h = size === 'field' ? touch.field : touch.office;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onLongPress={onLongPress}
      delayLongPress={450}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.btn,
        { minHeight: h, backgroundColor: v.bg, borderColor: v.border ?? v.bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        pressed && { transform: [{ scale: 0.97 }] },
        flex && { flex: 1 },
        style,
      ]}
    >
      {icon ? <Text style={[styles.icon, { color: v.fg }]}>{icon}</Text> : null}
      <Text style={[type.label, { color: v.fg, fontSize: size === 'field' ? 17 : 15, textAlign: 'center', flexShrink: 1 }]} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

export function SyncPill() {
  const status = useSync((s) => s.status);
  const pending = usePendingCount();
  const online = status === 'online';
  const label = online
    ? pending > 0 ? `Syncing ${pending}…` : 'Synced'
    : status === 'connecting'
      ? pending > 0 ? `Connecting · ${pending} queued` : 'Connecting…'
      : pending > 0 ? `Offline · ${pending} queued` : 'Offline';
  const dot = online ? color.ok : status === 'connecting' ? color.accent : color.danger;
  return (
    <View style={styles.pill} accessibilityLabel={`Sync status: ${label}`}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={[type.small, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

export function Header({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {left}
      <View style={{ flex: 1 }}>
        <Text style={type.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={type.small} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, style, pressed && { backgroundColor: color.muted }]}>
      {children}
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[styles.chip, active && { backgroundColor: color.primary, borderColor: color.primary }]}
    >
      <Text style={[type.label, { color: active ? color.onPrimary : color.fg }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Two-tap delete for list rows: first tap turns it red ("Tap again"), a second tap within 3.5 s
 * deletes. No modal, so it works with gloves and can't fire from one stray tap.
 */
export function DeleteButton({ label = 'Delete', confirmLabel = 'Tap again to delete', onConfirm, accessibilityLabel, strong }: {
  label?: string; confirmLabel?: string; onConfirm: () => void; accessibilityLabel?: string;
  /** Red from the start, for actions that can't be undone. */
  strong?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Pressable
      onPress={() => {
        // A quick double-tap must not delete: the confirm tap has to be deliberate.
        if (!armed) { armedAt.current = Date.now(); setArmed(true); return; }
        if (Date.now() - armedAt.current < 400) return;
        setArmed(false); onConfirm();
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={armed ? confirmLabel : accessibilityLabel ?? label}
      style={({ pressed }) => [styles.del, strong && styles.delStrong, armed && styles.delArmed, pressed && { opacity: 0.7 }]}
    >
      <Text style={[type.label, { color: armed ? color.onDanger : strong ? color.danger : color.fgMuted }]}>{armed ? confirmLabel : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  del: {
    minHeight: touch.office, minWidth: 88, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1.5,
    borderColor: color.border, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card,
  },
  delArmed: { backgroundColor: color.danger, borderColor: color.danger },
  delStrong: { borderColor: color.danger, borderWidth: 2, backgroundColor: color.dangerSoft },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 2,
  },
  icon: { fontSize: 20, fontWeight: '800' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill, backgroundColor: color.card, borderWidth: 1.5, borderColor: color.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    backgroundColor: color.card, borderBottomWidth: 1.5, borderBottomColor: color.border,
  },
  card: {
    backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.border, padding: space.lg,
  },
  chip: {
    minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.pill, borderWidth: 2, borderColor: color.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: color.card,
  },
});
