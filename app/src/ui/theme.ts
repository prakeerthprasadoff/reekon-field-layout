// Design tokens tuned for outdoor use: dark foreground and borders that stay readable in
// direct sun, safety orange for "act here", and secondary grey never used for body text.
import { Platform, type TextStyle } from 'react-native';

export const color = {
  bg: '#F8FAFC',
  card: '#FFFFFF',
  fg: '#0F172A',          // 17:1 on bg, readable in direct sun
  fgMuted: '#475569',     // 6.6:1 on muted
  muted: '#EBF0F5',
  border: '#64748B',      // 4.76:1 on white, visible outdoors
  hairline: '#CBD5E1',    // decorative only
  primary: '#334155',
  onPrimary: '#FFFFFF',
  accent: '#EA580C',      // safety orange = "act here"
  onAccent: '#000000',
  accentSoft: '#FFEDD5',
  danger: '#DC2626',
  onDanger: '#FFFFFF',
  dangerSoft: '#FEE2E2',
  ok: '#15803D',
  okSoft: '#DCFCE7',
  grid: '#E2E8F0',
  wall: '#0F172A',
  estimated: '#64748B',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Gloved field targets (assumed 56pt) vs bare-hand office targets. */
export const touch = { field: 56, office: 44, gap: 12 } as const;

const sys = Platform.select({ ios: 'System', default: undefined });
export const type = {
  display: { fontFamily: sys, fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'], color: color.fg } as TextStyle,
  title: { fontFamily: sys, fontSize: 22, fontWeight: '700', color: color.fg } as TextStyle,
  body: { fontFamily: sys, fontSize: 17, fontWeight: '500', color: color.fg } as TextStyle,
  label: { fontFamily: sys, fontSize: 15, fontWeight: '700', color: color.fg, letterSpacing: 0.3 } as TextStyle,
  small: { fontFamily: sys, fontSize: 13, fontWeight: '600', color: color.fgMuted } as TextStyle,
  num: { fontVariant: ['tabular-nums'] } as TextStyle,
};
