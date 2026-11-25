// Append-only op log on Node's built-in SQLite (no native module to compile).
import { DatabaseSync } from 'node:sqlite';
import type { SeqOp } from '@field/shared';

export class OpLog {
  private db: DatabaseSync;
  private insert;
  private sinceStmt;
  private byIdStmt;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ops (
        op_id      TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        json       TEXT NOT NULL,
        UNIQUE (project_id, seq)
      );
    `);
    this.insert = this.db.prepare('INSERT INTO ops (op_id, project_id, seq, json) VALUES (?, ?, ?, ?)');
    this.sinceStmt = this.db.prepare('SELECT json FROM ops WHERE project_id = ? AND seq > ? ORDER BY seq');
    this.byIdStmt = this.db.prepare('SELECT json FROM ops WHERE op_id = ?');
  }

  /** Permanently remove a job's history (used for jobs that are already deleted). */
  purge(projectId: string) {
    this.db.prepare('DELETE FROM ops WHERE project_id = ?').run(projectId);
  }

  append(op: SeqOp) {
    this.insert.run(op.opId, op.projectId, op.serverSeq, JSON.stringify(op));
  }

  since(projectId: string, seq: number): SeqOp[] {
    return this.sinceStmt.all(projectId, seq).map((r) => JSON.parse(String(r.json)) as SeqOp);
  }

  byOpId(opId: string): SeqOp | undefined {
    const r = this.byIdStmt.get(opId);
    return r ? (JSON.parse(String(r.json)) as SeqOp) : undefined;
  }

  all(): SeqOp[] {
    return this.db
      .prepare('SELECT json FROM ops ORDER BY project_id, seq')
      .all()
      .map((r) => JSON.parse(String(r.json)) as SeqOp);
  }
}
