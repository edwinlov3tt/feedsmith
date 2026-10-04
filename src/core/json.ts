// Narrowing helpers for JSON from outside the system (JSON-LD, APIs).

export type JsonRecord = Record<string, unknown>;

export function asRecord(v: unknown): JsonRecord | null {
  // Safe widening: a non-null, non-array object is string-indexable, and every
  // value stays `unknown`, so nothing about its contents is assumed.
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonRecord) : null;
}

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

export function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export function field(rec: JsonRecord | null, key: string): string | null {
  return rec ? str(rec[key]) : null;
}

/** schema.org @type may be a string or an array, with or without a prefix. */
export function hasType(rec: JsonRecord, type: string): boolean {
  return asArray(rec['@type']).some((t) => typeof t === 'string' && t.replace(/^.*[/:]/, '') === type);
}
