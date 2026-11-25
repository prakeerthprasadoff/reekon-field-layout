import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_SYNC_PORT, OpZ, applyOp, roleMayApply,
  type ClientMsg, type Op, type Presence, type ProjectDoc, type ProjectSummary, type Role, type SeqOp, type ServerMsg,
} from '@field/shared';
import { OpLog } from './store';

const PORT = Number(process.env.PORT ?? DEFAULT_SYNC_PORT);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

// ---------- State ----------

const log = new OpLog(join(DATA_DIR, 'layout.db'));
interface ProjectState { doc: ProjectDoc; seq: number; updatedAt: number }
const projects = new Map<string, ProjectState>();

for (const op of log.all()) {
  const cur = projects.get(op.projectId);
  try {
    projects.set(op.projectId, { doc: applyOp(cur?.doc ?? null, op), seq: op.serverSeq, updatedAt: op.ts });
  } catch (e) {
    console.warn(`[boot] skipped op ${op.opId}: ${(e as Error).message}`);
  }
}
console.log(`[boot] loaded ${projects.size} project(s) from ${DATA_DIR}`);

interface Client {
  ws: WebSocket;
  clientId: string | null;
  role: Role | null;
  name: string;
  subs: Set<string>;
  alive: boolean;
}
const clients = new Set<Client>();
const presences = new Map<string, Presence>(); // key: clientId|projectId

// ---------- Helpers ----------

const send = (c: Client, msg: ServerMsg) => {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
};

function summaries(): ProjectSummary[] {
  return [...projects.values()]
    .map(({ doc, seq, updatedAt }) => ({
      id: doc.id, name: doc.name, address: doc.address, spaceCount: doc.spaceOrder.length, updatedAt, lastSeq: seq,
      deleted: doc.deleted || undefined,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function broadcastProjects() {
  const msg: ServerMsg = { t: 'projects', projects: summaries() };
  for (const c of clients) if (c.clientId) send(c, msg);
}

function handleOps(c: Client, raw: unknown[]) {
  const accepted = new Map<string, SeqOp[]>();
  let projectListChanged = false;

  for (const candidate of raw) {
    const parsed = OpZ.safeParse(candidate);
    if (!parsed.success) {
      const opId = (candidate as { opId?: string })?.opId ?? '?';
      send(c, { t: 'reject', opId, reason: `invalid op: ${parsed.error.issues[0]?.message}` });
      continue;
    }
    const op: Op = parsed.data;

    // Idempotency: a re-sent outbox op is answered with the stored copy so the device clears it.
    const existing = log.byOpId(op.opId);
    if (existing) {
      send(c, { t: 'ops', projectId: existing.projectId, ops: [existing] });
      continue;
    }
    // Role is taken from the connection's hello, not trusted from the op.
    if (op.role !== c.role || !roleMayApply(c.role!, op.type)) {
      send(c, { t: 'reject', opId: op.opId, reason: `role ${c.role} may not ${op.type}` });
      continue;
    }
    const state = projects.get(op.projectId);
    let doc: ProjectDoc;
    try {
      doc = applyOp(state?.doc ?? null, op);
    } catch (e) {
      send(c, { t: 'reject', opId: op.opId, reason: (e as Error).message });
      continue;
    }
    const seq = (state?.seq ?? 0) + 1;
    const seqOp: SeqOp = { ...op, serverSeq: seq };
    log.append(seqOp);
    projects.set(op.projectId, { doc, seq, updatedAt: Date.now() });
    if (['createProject', 'createSpace', 'deleteSpace', 'deleteProject', 'restoreProject'].includes(op.type)) projectListChanged = true;
    const list = accepted.get(op.projectId) ?? [];
    list.push(seqOp);
    accepted.set(op.projectId, list);
  }

  for (const [projectId, ops] of accepted) {
    const msg: ServerMsg = { t: 'ops', projectId, ops };
    for (const other of clients) {
      if (other === c || other.subs.has(projectId)) send(other, msg);
    }
  }
  if (projectListChanged) broadcastProjects();
}

function handle(c: Client, msg: ClientMsg) {
  if (msg.t !== 'hello' && !c.clientId) return;
  switch (msg.t) {
    case 'hello':
      c.clientId = msg.clientId;
      c.role = msg.role;
      c.name = msg.name;
      send(c, { t: 'welcome', serverTime: Date.now() });
      send(c, { t: 'projects', projects: summaries() });
      break;
    case 'subscribe': {
      c.subs.add(msg.projectId);
      send(c, { t: 'ops', projectId: msg.projectId, ops: log.since(msg.projectId, msg.sinceSeq) });
      for (const p of presences.values()) {
        if (p.projectId === msg.projectId && p.clientId !== c.clientId) send(c, { t: 'presence', presence: p });
      }
      break;
    }
    case 'unsubscribe':
      c.subs.delete(msg.projectId);
      break;
    case 'ops':
      if (Array.isArray(msg.ops)) handleOps(c, msg.ops);
      break;
    case 'ping':
      send(c, { t: 'pong' });
      break;
    case 'purge': {
      if (c.role !== 'field' || !Array.isArray(msg.projectIds)) break;
      let n = 0;
      for (const pid of msg.projectIds) {
        const st = projects.get(pid);
        if (!st?.doc.deleted) continue; // only erase jobs that were deleted first
        log.purge(pid);
        projects.delete(pid);
        n++;
      }
      if (n) { console.log(`[sync] purged ${n} deleted job(s)`); broadcastProjects(); }
      break;
    }
    case 'presence': {
      const p: Presence = { ...msg.presence, clientId: c.clientId!, at: Date.now() };
      presences.set(`${p.clientId}|${p.projectId}`, p);
      for (const other of clients) {
        if (other !== c && other.subs.has(p.projectId)) send(other, { t: 'presence', presence: p });
      }
      break;
    }
  }
}

function dropPresence(c: Client) {
  for (const [key, p] of presences) {
    if (p.clientId !== c.clientId) continue;
    presences.delete(key);
    for (const other of clients) {
      if (other !== c && other.subs.has(p.projectId)) send(other, { t: 'presenceGone', clientId: p.clientId, projectId: p.projectId });
    }
  }
}

// ---------- HTTP + WS ----------

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, projects: projects.size, clients: clients.size }));
    return;
  }
  if (req.url === '/projects') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(summaries(), null, 2));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Field Layout sync server\n${projects.size} project(s), ${clients.size} connected client(s)\nWebSocket: ws://<this-host>:${PORT}\n`);
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  const c: Client = { ws, clientId: null, role: null, name: '', subs: new Set(), alive: true };
  clients.add(c);
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (data) => {
    try {
      handle(c, JSON.parse(String(data)) as ClientMsg);
    } catch (e) {
      console.warn('[ws] bad message', (e as Error).message);
    }
  });
  ws.on('close', () => {
    dropPresence(c);
    clients.delete(c);
  });
});

// Drop dead connections (phones that lost signal never send a close frame).
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}, 10_000);

http.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  console.log(`[sync] listening on :${PORT}`);
  for (const ip of ips) console.log(`[sync]   ws://${ip}:${PORT}`);
});
