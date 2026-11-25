// Sync engine: optimistic local apply + persistent outbox + server-ordered op log.
//
//   view = pending ops replayed on top of the last server-confirmed doc
//
// Every edit is applied locally right away (so the field UI never waits on the network),
// saved to the outbox, and sent when connected. The server's broadcast of our own op is
// the ack: it moves from `pending` into `confirmed`. Re-sends after reconnect are safe because
// the server de-duplicates by opId.
import Constants from 'expo-constants';
import { AppState } from 'react-native';
import { create } from 'zustand';
import {
  DEFAULT_SYNC_PORT, applyOp,
  type ClientMsg, type Op, type OpBody, type Presence, type ProjectDoc, type ProjectSummary, type SeqOp, type ServerMsg, type Target,
} from '@field/shared';
import { useSettings } from '../lib/settings';
import { loadJSON, newId, removeKey, saveJSON } from '../lib/storage';

export type ConnStatus = 'offline' | 'connecting' | 'online';

export interface DocState {
  confirmed: ProjectDoc | null;
  seq: number;
  pending: Op[];
  view: ProjectDoc | null;
}

interface SyncState {
  status: ConnStatus;
  url: string;
  projects: ProjectSummary[];
  docs: Record<string, DocState>;
  presence: Record<string, Record<string, Presence>>;
  lastReject: { opId: string; reason: string; at: number } | null;
}

// ---------- Persistence ----------

const K_INDEX = 'docs.index';
const K_PROJECTS = 'projects.cache';
const K_URL = 'sync.url';
const docKey = (pid: string) => `doc.${pid}`;

function resolveDefaultUrl(): string {
  const env = process.env.EXPO_PUBLIC_SYNC_URL;
  if (env) return env;
  // In Expo Go, hostUri is the dev machine's LAN address that Metro is served from
  // (e.g. "192.168.1.20:8081"). The sync server runs on that same machine.
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const host = hostUri.split(':')[0] || 'localhost';
  return `ws://${host}:${DEFAULT_SYNC_PORT}`;
}

function recompute(confirmed: ProjectDoc | null, pending: Op[]): { view: ProjectDoc | null; pending: Op[]; dropped: Op[] } {
  let view = confirmed;
  const kept: Op[] = [];
  const dropped: Op[] = [];
  for (const op of pending) {
    try { view = applyOp(view, op); kept.push(op); } catch { dropped.push(op); }
  }
  return { view, pending: kept, dropped };
}

function loadDocs(): Record<string, DocState> {
  const index = loadJSON<string[]>(K_INDEX, []);
  const out: Record<string, DocState> = {};
  for (const pid of index) {
    const d = loadJSON<{ confirmed: ProjectDoc | null; seq: number; pending: Op[] } | null>(docKey(pid), null);
    if (!d) continue;
    const r = recompute(d.confirmed, d.pending);
    out[pid] = { confirmed: d.confirmed, seq: d.seq, pending: r.pending, view: r.view };
  }
  return out;
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function persistDoc(pid: string) {
  clearTimeout(persistTimers.get(pid));
  persistTimers.set(pid, setTimeout(() => {
    const d = useSync.getState().docs[pid];
    if (!d) return;
    saveJSON(docKey(pid), { confirmed: d.confirmed, seq: d.seq, pending: d.pending });
    saveJSON(K_INDEX, Object.keys(useSync.getState().docs));
  }, 150));
}

// ---------- Store ----------

export const useSync = create<SyncState>(() => ({
  status: 'offline',
  url: loadJSON<string | null>(K_URL, null) ?? resolveDefaultUrl(),
  projects: loadJSON<ProjectSummary[]>(K_PROJECTS, []),
  docs: loadDocs(),
  presence: {},
  lastReject: null,
}));

function setDoc(pid: string, d: DocState) {
  useSync.setState((s) => ({ docs: { ...s.docs, [pid]: d } }));
  persistDoc(pid);
}

// ---------- Connection ----------

let ws: WebSocket | null = null;
let started = false;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const subscribed = new Set<string>();

function send(msg: ClientMsg): boolean {
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function connect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { url } = useSync.getState();
  useSync.setState({ status: 'connecting' });
  const sock = new WebSocket(url);
  ws = sock;

  sock.onopen = () => {
    retryMs = 1000;
    const { clientId, role, name } = useSettings.getState();
    send({ t: 'hello', clientId, role: role ?? 'field', name: name || 'Unknown' });
    // Catch up every job cached on this device, not just the open ones: a cached copy can be
    // stale (e.g. deleted on the server while the app was closed or reloading).
    const docs = useSync.getState().docs;
    for (const pid of Object.keys(docs)) subscribed.add(pid);
    for (const pid of subscribed) send({ t: 'subscribe', projectId: pid, sinceSeq: docs[pid]?.seq ?? 0 });
    flushOutbox();
  };
  sock.onmessage = (e) => {
    try { onServer(JSON.parse(String(e.data)) as ServerMsg); } catch (err) { console.warn('[sync] bad msg', err); }
  };
  sock.onerror = () => { /* onclose follows */ };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    useSync.setState({ status: 'offline', presence: {} });
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}

function flushOutbox() {
  const docs = useSync.getState().docs;
  const all = Object.values(docs).flatMap((d) => d.pending);
  if (all.length) send({ t: 'ops', ops: all });
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      useSync.setState({ status: 'online' });
      break;
    case 'projects': {
      useSync.setState({ projects: msg.projects });
      saveJSON(K_PROJECTS, msg.projects);
      // The server lists every job it has (deleted ones included). A job it confirmed before
      // (seq > 0) but no longer lists was erased there, so drop the local copy. Jobs created
      // offline have never been confirmed (seq 0) and stay until their outbox syncs.
      const listed = new Set(msg.projects.map((p) => p.id));
      const docs = useSync.getState().docs;
      const erased = Object.keys(docs).filter((pid) => !listed.has(pid) && (docs[pid].seq > 0 || docs[pid].view?.deleted));
      if (erased.length) forgetDocs(erased);
      break;
    }
    case 'ops':
      onOps(msg.projectId, msg.ops);
      break;
    case 'reject': {
      console.warn('[sync] rejected', msg.opId, msg.reason);
      const docs = useSync.getState().docs;
      for (const [pid, d] of Object.entries(docs)) {
        if (!d.pending.some((o) => o.opId === msg.opId)) continue;
        const r = recompute(d.confirmed, d.pending.filter((o) => o.opId !== msg.opId));
        setDoc(pid, { ...d, pending: r.pending, view: r.view });
        // A refusal usually means our copy is behind the server: fetch what we're missing.
        send({ t: 'subscribe', projectId: pid, sinceSeq: d.seq });
      }
      useSync.setState({ lastReject: { opId: msg.opId, reason: msg.reason, at: Date.now() } });
      break;
    }
    case 'presence':
      useSync.setState((s) => ({
        presence: { ...s.presence, [msg.presence.projectId]: { ...s.presence[msg.presence.projectId], [msg.presence.clientId]: msg.presence } },
      }));
      break;
    case 'presenceGone':
      useSync.setState((s) => {
        const { [msg.clientId]: _gone, ...rest } = s.presence[msg.projectId] ?? {};
        return { presence: { ...s.presence, [msg.projectId]: rest } };
      });
      break;
  }
}

function onOps(pid: string, ops: SeqOp[]) {
  const d = useSync.getState().docs[pid] ?? { confirmed: null, seq: 0, pending: [], view: null };
  let { confirmed, seq } = d;
  let pending = d.pending;
  for (const op of ops) {
    pending = pending.filter((p) => p.opId !== op.opId);
    if (op.serverSeq <= seq) continue; // already have it (e.g. echo of a de-duplicated re-send)
    if (op.serverSeq > seq + 1) {
      // Missed something: ask for the gap and stop here; the catch-up will include these ops.
      send({ t: 'subscribe', projectId: pid, sinceSeq: seq });
      break;
    }
    try { confirmed = applyOp(confirmed, op); } catch (e) { console.warn('[sync] server op failed locally', op.type, e); }
    seq = op.serverSeq;
  }
  const r = recompute(confirmed, pending);
  setDoc(pid, { confirmed, seq, pending: r.pending, view: r.view });
}

function forgetDocs(pids: string[]) {
  const docs = { ...useSync.getState().docs };
  for (const pid of pids) { delete docs[pid]; subscribed.delete(pid); removeKey(docKey(pid)); }
  useSync.setState({ docs });
  saveJSON(K_INDEX, Object.keys(docs));
}

/** Erase deleted jobs for good, on the server and on this device. */
export function purgeDeleted(projectIds: string[]): boolean {
  if (!send({ t: 'purge', projectIds })) return false;
  forgetDocs(projectIds.filter((pid) => useSync.getState().docs[pid]));
  return true;
}

// ---------- Public API ----------

export function startSync() {
  if (started) return;
  started = true;
  connect();
  AppState.addEventListener('change', (s) => { if (s === 'active') connect(); });
}

/** Reconnect with fresh hello (e.g. after the role changes). */
export function restartSync() {
  ws?.close();
  connect();
}

export function setServerUrl(url: string | null) {
  saveJSON(K_URL, url);
  useSync.setState({ url: url ?? resolveDefaultUrl() });
  restartSync();
}

export function openProject(pid: string) {
  if (subscribed.has(pid)) return;
  subscribed.add(pid);
  send({ t: 'subscribe', projectId: pid, sinceSeq: useSync.getState().docs[pid]?.seq ?? 0 });
}

/**
 * Apply an edit locally and queue it for the server. Returns false (and changes nothing)
 * if the op doesn't apply to the current local state.
 */
export function commit(projectId: string, body: OpBody): boolean {
  const { clientId, role, name } = useSettings.getState();
  const op = { ...body, opId: newId(), projectId, clientId, role: role ?? 'field', author: name || 'Unknown', ts: Date.now() } as Op;
  const d = useSync.getState().docs[projectId] ?? { confirmed: null, seq: 0, pending: [], view: null };
  let view: ProjectDoc;
  try { view = applyOp(d.view, op); } catch (e) { console.warn('[sync] local op failed', body.type, e); return false; }
  setDoc(projectId, { ...d, pending: [...d.pending, op], view });
  subscribed.add(projectId);
  send({ t: 'ops', ops: [op] });
  return true;
}

export function sendPresence(projectId: string, spaceId: string | null, target: Target | null) {
  const { role, name } = useSettings.getState();
  send({ t: 'presence', presence: { name: name || 'Unknown', role: role ?? 'field', projectId, spaceId, target } });
}

export function createProject(name: string, address: string | undefined, unitSystem: 'imperial' | 'metric'): string {
  const pid = newId();
  commit(pid, { type: 'createProject', name, address, unitSystem });
  return pid;
}

// ---------- Selectors ----------

export const usePendingCount = () =>
  useSync((s) => Object.values(s.docs).reduce((n, d) => n + d.pending.length, 0));

export const useProjectDoc = (pid: string | undefined) => useSync((s) => (pid ? s.docs[pid]?.view ?? null : null));

/** Server list plus projects created offline that the server hasn't seen yet. */
export function useProjectList(): ProjectSummary[] {
  const projects = useSync((s) => s.projects);
  const docs = useSync((s) => s.docs);
  const known = new Set(projects.map((p) => p.id));
  // Hide a deleted job right away, before the server's list update arrives.
  const gone = (pid: string) => !!docs[pid]?.view?.deleted;
  const local: ProjectSummary[] = Object.values(docs)
    .filter((d) => d.view && !d.view.deleted && !known.has(d.view.id))
    .map((d) => ({ id: d.view!.id, name: d.view!.name, address: d.view!.address, spaceCount: d.view!.spaceOrder.length, updatedAt: d.view!.createdAt, lastSeq: 0 }));
  return [...local, ...projects.filter((p) => !p.deleted && !gone(p.id))];
}

/** Jobs deleted on the server, newest first, so the field can bring one back. */
export function useDeletedProjects(): ProjectSummary[] {
  const projects = useSync((s) => s.projects);
  const docs = useSync((s) => s.docs);
  return projects.filter((p) => p.deleted || docs[p.id]?.view?.deleted);
}

/**
 * Undo a job delete. The local copy may be gone or stale, so this goes straight to the
 * server (restore needs a connection anyway: the deleted list comes from the server).
 */
export function restoreProject(projectId: string): boolean {
  const { clientId, role, name } = useSettings.getState();
  const op = { type: 'restoreProject', opId: newId(), projectId, clientId, role: role ?? 'field', author: name || 'Unknown', ts: Date.now() } as Op;
  const d = useSync.getState().docs[projectId];
  if (d) {
    // Drop any queued local delete so the outbox doesn't re-delete it, then catch up from the server.
    const pending = d.pending.filter((p) => p.type !== 'deleteProject');
    setDoc(projectId, { ...d, pending, view: recompute(d.confirmed, pending).view });
  }
  subscribed.add(projectId);
  const ok = send({ t: 'ops', ops: [op] });
  if (ok) send({ t: 'subscribe', projectId, sinceSeq: useSync.getState().docs[projectId]?.seq ?? 0 });
  return ok;
}
