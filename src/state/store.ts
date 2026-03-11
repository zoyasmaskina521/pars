import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { NormalizedEvent } from '../types/domain.js';

export interface OutboxRecord {
  id: number;
  sourceEventId: string;
  payload: string;
  attempts: number;
  nextAttemptAt: string;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sent_events (
        source_event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_event_id)
      );
      CREATE TABLE IF NOT EXISTS chat_cursor (
        external_chat_id TEXT PRIMARY KEY,
        last_seen_created_at TEXT,
        last_seen_fingerprint TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  isAlreadySent(sourceEventId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM sent_events WHERE source_event_id = ? LIMIT 1').get(sourceEventId);
    return !!row;
  }

  markSent(sourceEventId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO sent_events(source_event_id, created_at) VALUES (?, ?)')
      .run(sourceEventId, new Date().toISOString());
  }

  enqueueOutbox(evt: NormalizedEvent) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO outbox(source_event_id, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, 0, ?, ?)'
      )
      .run(evt.source_event_id, JSON.stringify(evt), now, now);
  }

  dueOutbox(limit = 100): OutboxRecord[] {
    return this.db
      .prepare(
        `SELECT id, source_event_id as sourceEventId, payload, attempts, next_attempt_at as nextAttemptAt
         FROM outbox WHERE next_attempt_at <= ? ORDER BY id ASC LIMIT ?`
      )
      .all(new Date().toISOString(), limit) as OutboxRecord[];
  }

  rescheduleOutbox(id: number, attempts: number, nextAttemptAtIso: string) {
    this.db.prepare('UPDATE outbox SET attempts=?, next_attempt_at=? WHERE id=?').run(attempts, nextAttemptAtIso, id);
  }

  removeOutbox(id: number) {
    this.db.prepare('DELETE FROM outbox WHERE id=?').run(id);
  }

  updateChatCursor(chatId: string, createdAt: string, fingerprint: string) {
    this.db
      .prepare(
        `INSERT INTO chat_cursor(external_chat_id,last_seen_created_at,last_seen_fingerprint,updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(external_chat_id) DO UPDATE SET
           last_seen_created_at=excluded.last_seen_created_at,
           last_seen_fingerprint=excluded.last_seen_fingerprint,
           updated_at=excluded.updated_at`
      )
      .run(chatId, createdAt, fingerprint, new Date().toISOString());
  }

  getChatCursor(chatId: string): { createdAt: string | null; fingerprint: string | null } {
    const row = this.db
      .prepare('SELECT last_seen_created_at as createdAt, last_seen_fingerprint as fingerprint FROM chat_cursor WHERE external_chat_id=?')
      .get(chatId) as { createdAt: string | null; fingerprint: string | null } | undefined;
    return row ?? { createdAt: null, fingerprint: null };
  }

  close() {
    this.db.close();
  }
}
