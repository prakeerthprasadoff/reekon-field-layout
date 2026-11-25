// Local persistence on expo-sqlite's key-value store (SQLite-backed, synchronous reads,
// atomic per-key writes). Used for settings, cached project docs, and the sync outbox.
import Storage from 'expo-sqlite/kv-store';
import { randomUUID } from 'expo-crypto';

export const newId = () => randomUUID();

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = Storage.getItemSync(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  Storage.setItemSync(key, JSON.stringify(value));
}

export function removeKey(key: string) {
  Storage.removeItemSync(key);
}
