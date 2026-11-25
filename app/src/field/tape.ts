// Measurement sources. The rest of the app only knows the MeasurementSource interface.
// A real Bluetooth tape needs a development build (react-native-ble-plx is not in Expo Go),
// so we ship a simulator that behaves like the real tool: it sends a plain string such as
// `12' 4 1/2"` (optionally with a horizontal angle) and has connection states and a battery.
import { create } from 'zustand';
import { formatImperial, formatMetric, type Source, type UnitSystem } from '@field/shared';

export interface Reading {
  id: string;
  raw: string;
  angleDeg?: number;
  source: Source;
  receivedAt: number;
}

export type SourceStatus = 'disconnected' | 'connecting' | 'connected';

export interface MeasurementSource {
  readonly kind: Source;
  onReading(cb: (r: Reading) => void): () => void;
}

interface TapeState {
  status: SourceStatus;
  battery: number;
  sendsAngle: boolean;
  /** Simulated compass heading of the tool when the user "points" it, degrees. */
  pointing: number;
  /** Demo mode: send the nominal value with no tape noise, so a layout closes cleanly. */
  exact: boolean;
}

export const useTape = create<TapeState>(() => ({ status: 'connected', battery: 86, sendsAngle: false, pointing: 0, exact: true }));

type Listener = (r: Reading) => void;
const listeners = new Set<Listener>();
let seq = 0;

export const simulatedTape: MeasurementSource & {
  connect(): void;
  disconnect(): void;
  setSendsAngle(on: boolean): void;
  setExact(on: boolean): void;
  /** Press the tape's button. `nominalMm` is what's actually there; we add realistic noise. */
  press(nominalMm: number, unitSystem: UnitSystem, pointingDeg?: number): void;
} = {
  kind: 'ble-tape',
  onReading(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  connect() {
    if (useTape.getState().status !== 'disconnected') return;
    useTape.setState({ status: 'connecting' });
    setTimeout(() => useTape.setState({ status: 'connected' }), 1200);
  },
  disconnect() { useTape.setState({ status: 'disconnected' }); },
  setSendsAngle(on) { useTape.setState({ sendsAngle: on }); },
  setExact(on) { useTape.setState({ exact: on }); },
  press(nominalMm, unitSystem, pointingDeg) {
    const st = useTape.getState();
    if (st.status !== 'connected') return;
    // Tape noise: within about +/- 3/16" (off in exact/demo mode)
    const noisy = st.exact ? Math.max(10, nominalMm) : Math.max(10, nominalMm + (Math.random() - 0.5) * 9.5);
    const raw = unitSystem === 'imperial' ? formatImperial(noisy, 16) : formatMetric(Math.round(noisy));
    // Angle sensor noise: +/- 1.5deg
    const angleDeg = st.sendsAngle && pointingDeg !== undefined ? pointingDeg + (st.exact ? 0 : (Math.random() - 0.5) * 3) : undefined;
    const r: Reading = { id: `r${Date.now()}-${++seq}`, raw, angleDeg, source: 'ble-tape', receivedAt: Date.now() };
    useTape.setState({ battery: Math.max(5, st.battery - (Math.random() < 0.1 ? 1 : 0)) });
    listeners.forEach((l) => l(r));
  },
};
