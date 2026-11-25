import type { Op, Role, SeqOp, Target } from './schema';

export const DEFAULT_SYNC_PORT = 8787;

export interface ProjectSummary {
  id: string;
  name: string;
  address?: string;
  spaceCount: number;
  updatedAt: number;
  lastSeq: number;
  /** Deleted jobs are still listed so the field can restore them. */
  deleted?: boolean;
}

export interface Presence {
  clientId: string;
  name: string;
  role: Role;
  projectId: string;
  spaceId: string | null;
  target: Target | null;
  at: number;
}

export type ClientMsg =
  | { t: 'hello'; clientId: string; role: Role; name: string }
  | { t: 'subscribe'; projectId: string; sinceSeq: number }
  | { t: 'unsubscribe'; projectId: string }
  | { t: 'ops'; ops: Op[] }
  | { t: 'presence'; presence: Omit<Presence, 'at' | 'clientId'> }
  /** Erase deleted jobs for good (field only; only jobs already deleted). */
  | { t: 'purge'; projectIds: string[] }
  /** App-level heartbeat so a phone can tell a live socket from a dead one. */
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'welcome'; serverTime: number }
  | { t: 'projects'; projects: ProjectSummary[] }
  | { t: 'ops'; projectId: string; ops: SeqOp[] }
  | { t: 'reject'; opId: string; reason: string }
  | { t: 'presence'; presence: Presence }
  | { t: 'presenceGone'; clientId: string; projectId: string }
  | { t: 'pong' };
