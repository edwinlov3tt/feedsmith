// Test doubles for the Worker bindings, backed by node:sqlite so the real SQL
// (migrations, ON CONFLICT, RETURNING, partial indexes) runs in tests.
// node:sqlite returns loosely typed rows; the casts below mirror D1's own
// untyped results, and the code under test parses every row with zod anyway.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type Param = string | number | null;

class Statement {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...params: unknown[]): Statement {
    return new Statement(
      this.db,
      this.sql,
      params.map((p) => {
        if (p === null || typeof p === 'string' || typeof p === 'number') return p;
        if (p === undefined) throw new Error(`undefined bound in: ${this.sql.slice(0, 60)}`);
        throw new Error(`unsupported bind type ${typeof p}`);
      }),
    );
  }
  #args(): SQLInputValue[] {
    return this.params;
  }
  async first(): Promise<Record<string, unknown> | null> {
    return (this.db.prepare(this.sql).get(...this.#args()) as Record<string, unknown> | undefined) ?? null;
  }
  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: this.db.prepare(this.sql).all(...this.#args()) as Record<string, unknown>[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const res = this.db.prepare(this.sql).run(...this.#args());
    return { meta: { changes: Number(res.changes) } };
  }
}

export class D1Shim {
  readonly db = new DatabaseSync(':memory:');
  constructor() {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) this.db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }
  async batch(statements: Statement[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      for (const s of statements) this.db.prepare(s.sql).run(...s.params);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  /** Direct SQL for assertions. */
  rows(sql: string, ...params: Param[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }
}

export interface QueuedMessage {
  id: string;
  body: unknown;
  attempts: number;
}

export class QueueShim {
  readonly messages: QueuedMessage[] = [];
  #seq = 0;
  /** Set to make the next N send/sendBatch calls throw. */
  failSends = 0;
  async send(body: unknown): Promise<void> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('queue send failed (injected)');
    }
    this.messages.push({ id: `m${++this.#seq}`, body: structuredClone(body), attempts: 1 });
  }
  async sendBatch(batch: Array<{ body: unknown }>): Promise<void> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('queue sendBatch failed (injected)');
    }
    for (const m of batch) this.messages.push({ id: `m${++this.#seq}`, body: structuredClone(m.body), attempts: 1 });
  }
}

export class R2Shim {
  readonly objects = new Map<string, string>();
  readonly metadata = new Map<string, Record<string, string>>();
  async put(key: string, body: string, opts?: { customMetadata?: Record<string, string> }): Promise<void> {
    this.objects.set(key, body);
    this.metadata.set(key, opts?.customMetadata ?? {});
  }
  async head(key: string): Promise<{ customMetadata: Record<string, string> } | null> {
    const m = this.metadata.get(key);
    return m ? { customMetadata: m } : null;
  }
  async get(key: string): Promise<{ body: string } | null> {
    const v = this.objects.get(key);
    return v === undefined ? null : { body: v };
  }
}
