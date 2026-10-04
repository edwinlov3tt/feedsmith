// Product set filters in Meta's own JSON format, e.g.
//   {"and":[{"availability":{"eq":"in stock"}},{"custom_label_1":{"neq":"clearance"}}]}
// Parsed into a typed tree once, so the same definition can be sent to Meta
// and evaluated locally against feed rows (for counts, item lists and per-set
// feeds). Only fields Feedsmith writes and Meta can filter on are allowed.

import type { MetaRow } from './feed.ts';

export const SET_FIELDS = [
  'availability',
  'brand',
  'product_type',
  'gender',
  'age_group',
  'color',
  'size',
  'condition',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'retailer_id',
  'price_amount',
] as const;
export type SetField = (typeof SET_FIELDS)[number];

// Meta: "contains" operators are for free text; enum fields take eq/neq/is_any.
const STRING_OPS = ['eq', 'neq', 'contains', 'not_contains', 'i_contains', 'i_not_contains', 'is_any', 'is_not_any'] as const;
const NUMBER_OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq'] as const;
type Op = (typeof STRING_OPS)[number] | (typeof NUMBER_OPS)[number];

export type SetFilter =
  | { kind: 'all' }
  | { kind: 'and' | 'or'; items: SetFilter[] }
  | { kind: 'rule'; field: SetField; op: Op; value: string | number | string[] };

const MAX_DEPTH = 4;
const MAX_RULES = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOneOf<T extends string>(list: readonly T[], v: string): v is T {
  return (list as readonly string[]).includes(v);
}

/** Parses Meta-format filter JSON. Returns an error message instead of throwing. */
export function parseSetFilter(raw: unknown): { ok: true; filter: SetFilter } | { ok: false; error: string } {
  let rules = 0;
  const walk = (node: unknown, depth: number, path: string): SetFilter => {
    if (depth > MAX_DEPTH) throw new Error(`${path}: nested deeper than ${MAX_DEPTH}`);
    if (!isRecord(node)) throw new Error(`${path}: expected an object`);
    const keys = Object.keys(node);
    if (keys.length === 0) return { kind: 'all' };
    if (keys.length !== 1) throw new Error(`${path}: one key per object (use "and"/"or" to combine)`);
    const key = keys[0] ?? '';
    const body = node[key];
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(body) || body.length === 0) throw new Error(`${path}.${key}: expected a non-empty array`);
      return { kind: key, items: body.map((b, i) => walk(b, depth + 1, `${path}.${key}[${i}]`)) };
    }
    if (!isOneOf(SET_FIELDS, key)) throw new Error(`${path}: unsupported field "${key}" (allowed: ${SET_FIELDS.join(', ')})`);
    if (!isRecord(body) || Object.keys(body).length !== 1) throw new Error(`${path}.${key}: expected one operator, e.g. {"eq": "value"}`);
    const op = Object.keys(body)[0] ?? '';
    const value = body[op];
    if (++rules > MAX_RULES) throw new Error(`more than ${MAX_RULES} rules`);
    if (key === 'price_amount') {
      if (!isOneOf(NUMBER_OPS, op) || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${path}.price_amount: use lt/lte/gt/gte/eq/neq with whole cents, e.g. {"lt": 2500}`);
      }
      return { kind: 'rule', field: key, op, value };
    }
    if (!isOneOf(STRING_OPS, op)) throw new Error(`${path}.${key}: unsupported operator "${op}"`);
    if (op === 'is_any' || op === 'is_not_any') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 500 || !value.every((v) => typeof v === 'string' && v.length <= 200)) {
        throw new Error(`${path}.${key}.${op}: expected a non-empty array of strings`);
      }
      return { kind: 'rule', field: key, op, value: value.filter((v): v is string => typeof v === 'string') };
    }
    if (typeof value !== 'string' || value.length > 200) throw new Error(`${path}.${key}.${op}: expected a string up to 200 chars`);
    return { kind: 'rule', field: key, op, value };
  };
  try {
    return { ok: true, filter: walk(raw, 0, 'filter') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Back to Meta's JSON format. */
export function toMetaFilter(f: SetFilter): Record<string, unknown> {
  switch (f.kind) {
    case 'all':
      return {};
    case 'and':
    case 'or':
      return { [f.kind]: f.items.map(toMetaFilter) };
    case 'rule':
      return { [f.field]: { [f.op]: f.value } };
    default: {
      const unreachable: never = f;
      throw new Error(`unhandled filter ${JSON.stringify(unreachable)}`);
    }
  }
}

function fieldValue(row: MetaRow, field: SetField): string | number {
  switch (field) {
    case 'retailer_id':
      return row.id;
    case 'price_amount': {
      const amount = Number(row.price.split(' ')[0]);
      return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
    }
    default:
      return row[field];
  }
}

/** Local evaluation, case-insensitive like Meta's operators. */
export function matchesSet(f: SetFilter, row: MetaRow): boolean {
  switch (f.kind) {
    case 'all':
      return true;
    case 'and':
      return f.items.every((i) => matchesSet(i, row));
    case 'or':
      return f.items.some((i) => matchesSet(i, row));
    case 'rule': {
      const actual = fieldValue(row, f.field);
      if (typeof actual === 'number' || typeof f.value === 'number') {
        const a = Number(actual);
        const v = Number(f.value);
        switch (f.op) {
          case 'lt':
            return a < v;
          case 'lte':
            return a <= v;
          case 'gt':
            return a > v;
          case 'gte':
            return a >= v;
          case 'eq':
            return a === v;
          case 'neq':
            return a !== v;
          default:
            return false;
        }
      }
      const text = actual.toLowerCase();
      const list = Array.isArray(f.value) ? f.value.map((v) => v.toLowerCase()) : [];
      const v = typeof f.value === 'string' ? f.value.toLowerCase() : '';
      switch (f.op) {
        case 'eq':
          return text === v;
        case 'neq':
          return text !== v;
        case 'contains':
        case 'i_contains':
          return text.includes(v);
        case 'not_contains':
        case 'i_not_contains':
          return !text.includes(v);
        case 'is_any':
          return list.includes(text);
        case 'is_not_any':
          return !list.includes(text);
        default:
          return false;
      }
    }
    default: {
      const unreachable: never = f;
      throw new Error(`unhandled filter ${JSON.stringify(unreachable)}`);
    }
  }
}
