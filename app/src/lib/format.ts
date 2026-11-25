import { formatLength, type ClosureDiagnosis, type Measurement, type UnitSystemT } from '@field/shared';

export function sourceLabel(s: Measurement['source']) {
  return s === 'ble-tape' ? 'Tape' : s === 'caliper' ? 'Caliper' : s === 'from-plan' ? 'From plan' : 'Manual';
}

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const walls = (ix: number[]) =>
  ix.length === 1 ? `Wall ${ix[0] + 1}` : `Walls ${ix.map((i) => i + 1).join(' + ')}`;

/** One plain sentence per disagreeing axis, e.g. "Wall 1 is 1/4" longer than Wall 3". */
export function closureLines(d: ClosureDiagnosis, unit: UnitSystemT): string[] {
  return d.axes.map((a) => {
    const off = formatLength(a.offMm, unit, 1.5875);
    const verb = a.long.length === 1 ? 'is' : 'are';
    return `${walls(a.long)} ${verb} ${off} longer than ${walls(a.short)}`;
  });
}
