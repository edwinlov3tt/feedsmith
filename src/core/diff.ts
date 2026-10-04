// Compares what the site shows now with what was stored, product by product.

import { changedColumns, type MetaColumn } from './feed.ts';
import type { Variant } from './model.ts';

export type ChangeKind = 'created' | 'updated' | 'out_of_stock' | 'back_in_stock';

export interface Change {
  variantId: string;
  kind: ChangeKind;
  fields: MetaColumn[];
}

export interface ProductDiff {
  /** Variants to write: new, changed, or newly marked out of stock. */
  upserts: Variant[];
  changes: Change[];
}

const unavailable = (v: Variant): boolean => v.availability === 'out of stock' || v.availability === 'discontinued';

function outOfStock(v: Variant): Variant {
  return { ...v, availability: 'out of stock', lowStockHint: null };
}

/**
 * `fresh === 'gone'` means the site says the whole product is unavailable.
 * Stored variants missing from `fresh` are sold-out sizes: PrismRBS drops them
 * from the page instead of flagging them. Neither case deletes anything.
 */
export function diffProduct(stored: readonly Variant[], fresh: readonly Variant[] | 'gone'): ProductDiff {
  const upserts: Variant[] = [];
  const changes: Change[] = [];
  const freshList = fresh === 'gone' ? [] : fresh;
  const freshIds = new Set(freshList.map((v) => v.id));
  const storedById = new Map(stored.map((v) => [v.id, v]));

  for (const next of freshList) {
    const prev = storedById.get(next.id);
    if (!prev) {
      upserts.push(next);
      changes.push({ variantId: next.id, kind: 'created', fields: [] });
      continue;
    }
    const fields = changedColumns(prev, next);
    // Low-stock hints aren't in the feed but are worth keeping current.
    if (fields.length === 0) {
      if (prev.lowStockHint !== next.lowStockHint) upserts.push(next);
      continue;
    }
    upserts.push(next);
    const kind: ChangeKind =
      fields.includes('availability') && unavailable(next) !== unavailable(prev)
        ? unavailable(next)
          ? 'out_of_stock'
          : 'back_in_stock'
        : 'updated';
    changes.push({ variantId: next.id, kind, fields });
  }

  for (const prev of stored) {
    if (freshIds.has(prev.id) || unavailable(prev)) continue;
    upserts.push(outOfStock(prev));
    changes.push({ variantId: prev.id, kind: 'out_of_stock', fields: ['availability'] });
  }
  return { upserts, changes };
}
