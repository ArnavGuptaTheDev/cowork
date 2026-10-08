// Minimal D1 + R2 stand-ins for tests: D1 over node:sqlite (same SQLite semantics, real migrations),
// R2 over a Map. Only the API surface the app uses is implemented.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Value = string | number | null | bigint | Uint8Array;

function normalise(v: unknown): Value {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined bound to a statement');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Value;
}

class Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map(normalise));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    return this.exec();
  }
  exec() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw<T>() {
    return this.db.prepare(this.sql).all(...this.params).map((r) => Object.values(r as object)) as T[];
  }
}

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Applies one migration file to a test database (for testing a migration against existing data). */
export function applyMigration(d1: { sqlite: DatabaseSync }, file: string): void {
  d1.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
}

/** In-memory D1 with every migration applied, or only those sorting before `stopBefore`. */
export function createTestD1(opts: { stopBefore?: string } = {}): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of migrationFiles()) {
    if (opts.stopBefore && f >= opts.stopBefore) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  const d1 = {
    sqlite: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => {
          const isRead = /^\s*(SELECT|WITH)/i.test(s.sql);
          return isRead
            ? { results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }
            : s.exec();
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error('not implemented');
    },
    withSession() {
      throw new Error('not implemented');
    },
  };
  return d1 as unknown as D1Database & { sqlite: DatabaseSync };
}

export function createTestR2(): R2Bucket & { objects: Map<string, { body: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const bucket = {
    objects,
    async put(key: string, value: Uint8Array | ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      const body = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { body, contentType: opts?.httpMetadata?.contentType });
      return { key, size: body.length };
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        key,
        size: o.body.length,
        httpEtag: `"${key}"`,
        body: new Blob([o.body as Uint8Array<ArrayBuffer>]).stream(),
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
  return bucket as unknown as R2Bucket & { objects: typeof objects };
}
