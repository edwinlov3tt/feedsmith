// Meta Commerce catalog updates through the Graph API Batch endpoint:
//   POST /{catalog_id}/items_batch  item_type=PRODUCT_ITEM, requests=[{method, data}]
// The token is a system-user token with catalog_management. It is sent in
// the Authorization header, never in the URL.
//
// VERIFY-LIVE: request and response shapes follow Meta's published docs but
// have not been exercised against a real catalog yet (no credentials). See
// docs/followups.md.

import { z } from 'zod';
import { feedProblem, toMetaRow, toVehicleRow } from '../core/feed.ts';
import { asRecord } from '../core/json.ts';
import { truncate } from '../core/normalize.ts';
import type { Variant } from '../core/model.ts';

const GRAPH = 'https://graph.facebook.com';
// Meta allows 5,000 requests per call and recommends under 3,000.
const BATCH_SIZE = 1000;
const TIMEOUT_MS = 30_000;

export const CatalogIdSchema = z.string().regex(/^\d{5,25}$/, 'numeric catalog ID');

export interface MetaTarget {
  catalogId: string;
  token: string;
  graphVersion: string;
}

const API_TITLE_MAX = 100; // the CSV allows 200; the Batch API caps title at 100
const API_DESCRIPTION_MAX = 5000; // the CSV allows 9,999; the Batch API caps at 5,000
const API_IMAGES_MAX = 21;

export type BatchValue = string | number | Array<{ url: string }> | Record<string, string | number>;
export type BatchData = Record<string, BatchValue>;

/**
 * A product item for items_batch, per Meta's PRODUCT_ITEM field reference
 * (October 2026). Images go in `image` (Meta's recommended form, up to 21);
 * when `image` is present Meta ignores image_link/additional_image_link.
 */
export function batchItem(v: Variant): BatchData {
  const row = toMetaRow(v);
  const images = [v.imageLink, ...v.additionalImageLinks].filter((u): u is string => u !== null).slice(0, API_IMAGES_MAX);
  const data: BatchData = {
    id: row.id,
    title: truncate(row.title, API_TITLE_MAX),
    description: truncate(row.description, API_DESCRIPTION_MAX),
    availability: row.availability,
    condition: row.condition,
    price: row.price,
    link: row.link,
    image: images.map((url) => ({ url })),
    brand: row.brand,
    item_group_id: row.item_group_id,
  };
  for (const k of ['sale_price', 'size', 'color', 'gender', 'age_group', 'product_type', 'gtin', 'mpn', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3'] as const) {
    if (row[k]) data[k] = row[k];
  }
  return data;
}

/**
 * A VEHICLE item for items_batch, in Meta's automotive field names. Nested
 * fields (mileage, address) are objects, as in the API, where the CSV feed
 * flattens them to mileage.value, address.city and so on.
 */
export function batchVehicle(v: Variant): BatchData {
  const car = v.vehicle;
  if (!car) throw new Error(`variant ${v.id} has no vehicle fields`);
  const row = toVehicleRow(v);
  const images = [v.imageLink, ...v.additionalImageLinks].filter((u): u is string => u !== null).slice(0, 20);
  const data: BatchData = {
    vehicle_id: v.id,
    title: truncate(v.title, 500),
    description: truncate(v.description, API_DESCRIPTION_MAX),
    url: v.link,
    make: car.make,
    model: car.model,
    year: car.year,
    mileage: { value: car.mileage, unit: car.mileageUnit },
    image: images.map((url) => ({ url })),
    body_style: car.bodyStyle,
    price: row['price'] ?? '',
    exterior_color: v.color ?? 'Other',
    state_of_vehicle: car.state,
    address: {
      addr1: car.dealer.addr1,
      city: car.dealer.city,
      region: car.dealer.region,
      country: car.dealer.country,
      ...(car.dealer.postalCode ? { postal_code: car.dealer.postalCode } : {}),
    },
    latitude: car.dealer.latitude,
    longitude: car.dealer.longitude,
    availability: row['availability'] ?? 'available',
    dealer_name: car.dealer.name,
  };
  for (const k of ['vin', 'trim', 'transmission', 'drivetrain', 'fuel_type', 'interior_color', 'stock_number', 'dealer_phone', 'sale_price', 'custom_label_0'] as const) {
    const value = row[k];
    if (value) data[k] = value;
  }
  return data;
}

export function batchItemType(variants: readonly Variant[]): 'PRODUCT_ITEM' | 'VEHICLE' {
  return variants.some((v) => v.vehicle) ? 'VEHICLE' : 'PRODUCT_ITEM';
}

export function batchRequests(variants: readonly Variant[]): Array<{ method: 'UPDATE'; data: BatchData }> {
  // Same exclusions as the feed, so Meta never gets an item the feed leaves out.
  return variants.filter((v) => feedProblem(v) === null).map((v) => ({ method: 'UPDATE', data: v.vehicle ? batchVehicle(v) : batchItem(v) }));
}

function graphUrl(target: MetaTarget, path: string): string {
  const version = /^v\d+\.\d+$/.test(target.graphVersion) ? target.graphVersion : 'v23.0';
  return `${GRAPH}/${version}/${CatalogIdSchema.parse(target.catalogId)}${path}`;
}

const Issues = z.array(z.object({ message: z.string() }).passthrough()).optional();
const BatchResponse = z
  .object({
    handles: z.array(z.string()).optional(),
    validation_status: z.array(z.object({ retailer_id: z.string(), errors: Issues, warnings: Issues }).passthrough()).optional(),
  })
  .passthrough();
const GraphError = z.object({ error: z.object({ message: z.string(), code: z.number().optional() }) });

export interface ItemIssue {
  id: string;
  message: string;
}

export interface PushResult {
  sent: number;
  handles: string[];
  /** Items Meta refused at submission (validation_status errors). */
  rejected: ItemIssue[];
  warnings: number;
}

/** Sends variants as upserts. Throws on the first failed call so nothing is marked pushed wrongly. */
export async function pushVariants(target: MetaTarget, variants: readonly Variant[], fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<PushResult> {
  const requests = batchRequests(variants);
  const result: PushResult = { sent: requests.length, handles: [], rejected: [], warnings: 0 };
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const res = await fetchImpl(graphUrl(target, '/items_batch'), {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ item_type: batchItemType(variants), allow_upsert: true, requests: requests.slice(i, i + BATCH_SIZE) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = GraphError.safeParse(body);
      // 80014 is Meta's per-catalog batch rate limit; the changes stay unpushed and go next run.
      throw new Error(`Meta items_batch ${res.status}${err.success && err.data.error.code ? ` (code ${err.data.error.code})` : ''}: ${err.success ? err.data.error.message : 'no error body'}`);
    }
    const parsed = BatchResponse.safeParse(body).data;
    result.handles.push(...(parsed?.handles ?? []));
    for (const s of parsed?.validation_status ?? []) {
      for (const e of s.errors ?? []) result.rejected.push({ id: s.retailer_id, message: e.message });
      result.warnings += s.warnings?.length ?? 0;
    }
  }
  return result;
}

const BatchStatus = z.object({
  data: z.array(
    z
      .object({
        handle: z.string().optional(),
        status: z.string().optional(),
        errors_total_count: z.number().optional(),
        warnings_total_count: z.number().optional(),
        errors: z.array(z.object({ id: z.string().optional(), message: z.string() }).passthrough()).optional(),
        ids_of_invalid_requests: z.array(z.string()).optional(),
      })
      .passthrough(),
  ),
});

export interface BatchStatusResult {
  handle: string;
  status: string;
  errorsTotal: number;
  errors: ItemIssue[];
  invalidIds: string[];
}

/** Meta processes batches asynchronously; this reports how a submitted batch ended. */
export async function checkBatchStatus(target: MetaTarget, handle: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<BatchStatusResult> {
  const params = new URLSearchParams({
    handle,
    load_ids_of_invalid_requests: 'true',
    fields: 'handle,status,errors_total_count,errors,ids_of_invalid_requests',
  });
  const res = await fetchImpl(`${graphUrl(target, '/check_batch_request_status')}?${params}`, {
    headers: { authorization: `Bearer ${target.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = GraphError.safeParse(body);
    throw new Error(`Meta check_batch_request_status ${res.status}: ${err.success ? err.data.error.message : 'no error body'}`);
  }
  const first = BatchStatus.safeParse(body).data?.data[0];
  return {
    handle,
    status: first?.status ?? 'unknown',
    errorsTotal: first?.errors_total_count ?? 0,
    errors: (first?.errors ?? []).slice(0, 50).map((e) => ({ id: e.id ?? '', message: e.message })),
    invalidIds: (first?.ids_of_invalid_requests ?? []).slice(0, 200),
  };
}

/**
 * Confirms the token can see this catalog before it is stored. Without this
 * an admin could attach someone else's catalog ID to a site and have the
 * service write into it with the wrong token (or vice versa).
 */
export async function verifyCatalogAccess(target: MetaTarget, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const res = await fetchImpl(`${graphUrl(target, '')}?fields=id,name`, {
    headers: { authorization: `Bearer ${target.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = GraphError.safeParse(body);
    return { ok: false, error: err.success ? err.data.error.message : `HTTP ${res.status}` };
  }
  const parsed = z.object({ id: z.string(), name: z.string().default('') }).safeParse(body);
  if (!parsed.success || parsed.data.id !== target.catalogId) return { ok: false, error: 'catalog ID in response does not match' };
  return { ok: true, name: parsed.data.name };
}

// ---------- product sets ----------
// POST /{catalog_id}/product_sets  name, filter (JSON string), retailer_id
// GET  /{catalog_id}/product_sets?retailer_id=...   find our own set again
// POST /{product_set_id}  name, filter      update
// DELETE /{product_set_id}                  delete
// Feedsmith tags every set it creates with retailer_id "feedsmith:<slug>", so a
// lost meta_set_id (or a create whose response was lost) never duplicates a set.

export const setRetailerId = (slug: string): string => `feedsmith:${slug}`;

const ProductSetNode = z.object({ id: z.string(), name: z.string().optional(), retailer_id: z.string().optional() }).passthrough();

async function graphCall(target: MetaTarget, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { authorization: `Bearer ${target.token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = GraphError.safeParse(body);
    const code = err.success && err.data.error.code !== undefined ? ` (code ${err.data.error.code})` : '';
    throw new Error(`Meta ${res.status}${code}: ${err.success ? err.data.error.message : 'no error body'}`);
  }
  return body;
}

function setNodeUrl(target: MetaTarget, setId: string): string {
  const version = /^v\d+\.\d+$/.test(target.graphVersion) ? target.graphVersion : 'v23.0';
  return `${GRAPH}/${version}/${z.string().regex(/^\d{5,25}$/).parse(setId)}`;
}

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() };
}

export async function findProductSet(target: MetaTarget, slug: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<string | null> {
  const params = new URLSearchParams({ retailer_id: setRetailerId(slug), fields: 'id,name,retailer_id', limit: '25' });
  const body = await graphCall(target, `${graphUrl(target, '/product_sets')}?${params}`, { method: 'GET' }, fetchImpl);
  const list = z.object({ data: z.array(ProductSetNode) }).safeParse(body);
  // Match on retailer_id ourselves too, in case Meta ignores the filter param.
  return list.success ? (list.data.data.find((s) => s.retailer_id === setRetailerId(slug))?.id ?? null) : null;
}

/** Order-independent comparison of filter JSON (Meta may reorder keys). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const rec = asRecord(v);
  if (rec) {
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(typeof v === 'string' ? v.toLowerCase() : v);
}

/** Finds a catalog set whose filter equals `filter`, paging through up to 1,000 sets. */
export async function findSetByFilter(target: MetaTarget, filter: Record<string, unknown>, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<string | null> {
  const want = canonical(filter);
  let url: string | null = `${graphUrl(target, '/product_sets')}?${new URLSearchParams({ fields: 'id,name,filter', limit: '200' })}`;
  for (let page = 0; url && page < 5; page++) {
    const body = await graphCall(target, url, { method: 'GET' }, fetchImpl);
    const parsed = z
      .object({ data: z.array(z.object({ id: z.string(), filter: z.string().optional() }).passthrough()), paging: z.object({ next: z.string().optional() }).passthrough().optional() })
      .safeParse(body);
    if (!parsed.success) return null;
    for (const s of parsed.data.data) {
      try {
        if (s.filter && canonical(JSON.parse(s.filter)) === want) return s.id;
      } catch {
        // A filter Meta returns in some other form can't be ours.
      }
    }
    const next = parsed.data.paging?.next ?? null;
    // Only follow Graph API pagination links.
    url = next && new URL(next).hostname === 'graph.facebook.com' ? next : null;
  }
  return null;
}

export interface SetSyncResult {
  metaSetId: string;
  action: 'created' | 'updated' | 'adopted';
}

/** Creates or updates one product set on Meta. */
export async function upsertProductSet(
  target: MetaTarget,
  set: { slug: string; name: string; filter: Record<string, unknown>; metaSetId: string | null },
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<SetSyncResult> {
  const fields = { name: set.name, filter: JSON.stringify(set.filter) };
  let id = set.metaSetId;
  let action: SetSyncResult['action'] = 'updated';
  if (!id) {
    id = await findProductSet(target, set.slug, fetchImpl);
    action = 'adopted';
  }
  if (id) {
    await graphCall(target, setNodeUrl(target, id), form(fields), fetchImpl);
    return { metaSetId: id, action };
  }
  let created: unknown;
  try {
    created = await graphCall(target, graphUrl(target, '/product_sets'), form({ ...fields, retailer_id: setRetailerId(set.slug) }), fetchImpl);
  } catch (err) {
    // 10803: the catalog already has a set with exactly this filter (often one
    // made by hand in Commerce Manager). Link to it rather than fail; its name
    // is left as the owner chose it.
    if (!(err instanceof Error && err.message.includes('(code 10803)'))) throw err;
    const existing = await findSetByFilter(target, set.filter, fetchImpl);
    if (!existing) throw err;
    return { metaSetId: existing, action: 'adopted' };
  }
  const parsed = z.object({ id: z.string() }).safeParse(created);
  if (!parsed.success) throw new Error('Meta created the set but returned no id');
  return { metaSetId: parsed.data.id, action: 'created' };
}

export async function deleteProductSet(target: MetaTarget, metaSetId: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<void> {
  await graphCall(target, setNodeUrl(target, metaSetId), { method: 'DELETE' }, fetchImpl);
}
