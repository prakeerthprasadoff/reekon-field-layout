import { create } from 'zustand';
import type { Role } from '@field/shared';
import { loadJSON, newId, saveJSON } from './storage';

interface Settings {
  clientId: string;
  name: string;
  role: Role | null;
  speak: boolean;
}

interface SettingsStore extends Settings {
  setProfile: (name: string, role: Role) => void;
  setSpeak: (on: boolean) => void;
  reset: () => void;
}

const KEY = 'settings.v1';
const initial: Settings = loadJSON<Settings>(KEY, { clientId: newId(), name: '', role: null, speak: true });
if (!initial.clientId) initial.clientId = newId();
saveJSON(KEY, initial);

export const useSettings = create<SettingsStore>((set, get) => {
  const persist = () => {
    const { clientId, name, role, speak } = get();
    saveJSON(KEY, { clientId, name, role, speak });
  };
  return {
    ...initial,
    setProfile: (name, role) => { set({ name, role }); persist(); },
    setSpeak: (speak) => { set({ speak }); persist(); },
    reset: () => { set({ role: null }); persist(); },
  };
});
