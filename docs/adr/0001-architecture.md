# ADR-0001: Crawl architecture, change model and delivery to Meta

Status: accepted (2026-10-02)

## Context

The stores have no feed export or product API. Products must be read from
public pages, kept current, and delivered to Meta. Several stores, on more than
one platform, should share one system.

## Decisions

**1. Cloudflare Worker + D1 + R2 + Queues + Cron.** Cron starts runs; a queue
fans product reads out in messages of 5 refs; D1 holds sites, products,
variants and the change log; R2 holds the published CSV. Queue settings
(`max_batch_size` 2, `max_concurrency` 2) and per-site `crawlConcurrency` (default 2)
keep load on a store to a few requests at a time. Requires the Workers Paid
plan (subrequests per invocation; Queues).

**2. Adapters isolate platform knowledge.** `Adapter` = detect, discover, read,
refFromUrl. Everything downstream sees only `Variant`. PrismRBS and generic
JSON-LD ship now. Parsing is targeted string extraction against known markup,
not a DOM library, to keep the Worker small; fixtures from real pages pin it.

**3. Two run modes.** `full` (nightly, 07:15 UTC) discovers every product, then reads
them. `sweep` (every 2 hours at :45) re-reads known active products only. The
first run of a site is always full.

**4. Variants are never deleted.** A size missing from its product page, a
product page that says "not available" (or 404s), or a product missing from
discovery in two consecutive full runs all become `out of stock`. Meta keeps ad
history and the item comes back cleanly if restocked. Whole-product removals
("gone") are applied only in finalize, after the run passes its gates, and
expiry works from current state so an interrupted finalize catches up. A full
run whose discovery was truncated (a cap hit or a listing page failed) never
strikes undiscovered products.

**5. Errors never change stock.** A page that can't be fetched or parsed, or
whose variants fail schema validation, records an `error` outcome and writes
nothing. A known product page that suddenly has no product data (bot challenge,
template change) is also an error. Only positive evidence changes availability.

**6. Publish gates.** A run is rejected, and the last good feed stays live, if
more than `maxErrorRate` (20%) of reads fail; more than `maxGoneRate` (10%) of
products are reported gone (a site-wide 404); more than `maxSoldOutRate` (25%) of
in-stock variants sell out in one run; or a full run discovers fewer than
`minDiscoveryRatio` (80%) of the previous run's products. Per-variant reads from a
rejected run are still stored (each is a real observation, and the next good run
corrects them), but nothing is published or pushed until a run passes.

**7. Two delivery paths to Meta.** The CSV feed URL is the source of truth Meta
fetches on a schedule. Changes are also pushed with the Graph API
`items_batch` endpoint (UPDATE with `allow_upsert`), sending each changed
variant's *current* state rather than a delta, so redelivery and reordering are
harmless. Pushes only happen after a run passes its gates.

**7a. Matching Meta's formats (checked 2026-10-04 against Meta's catalog
template and the items_batch reference).** CSV columns follow the order of
Meta's template, required columns first. Store size labels such as "SM UNISEX"
or "10 WOMEN'S" are split into Meta's `size`, `gender` and `age_group`. Batch API
items use Meta's tighter limits (title 100 chars, description 5,000), send
images as the recommended `image` array (up to 21), and map pre-orders to
"available for order", since neither the template nor the API lists
"preorder". Per-item rejections from `validation_status` are recorded on the
run, and `GET /admin/runs/{id}/meta-status` asks `check_batch_request_status`
how Meta finished processing.

**7b. Labels for product sets (2026-10-04).** PrismRBS discovery reads the
store's department pages (scoped to `<main>`, since the global nav links every
category) to map each category to its department, and merges every category a
product is listed in. The lowest-ID non-promotional category becomes
`product_type`; clearance/sale and featured listings become flags. The feed
carries `custom_label_0` department, `custom_label_1` clearance,
`custom_label_2` price band and `custom_label_3` featured, which product sets
filter on (docs/product-sets.md). Labels live on the product row, so sweeps
keep them without rediscovering.

**8. Idempotent queue handling.** Outcomes are keyed (run, product) with
INSERT OR IGNORE. The last reader claims finalize with a conditional UPDATE, and
finalize itself is claimed by queue message ID, so a redelivery proceeds but a
duplicate message doesn't. Strikes are recorded per run. A redelivered discover
re-enqueues its reads. A database index allows one active run per site. A
malformed message is logged and dropped; a failing one is retried with backoff,
then dead-lettered, and the dead-letter consumer records its products as errors
so the run still reaches finalize. Runs stuck over 6 hours are failed. The
06:45 sweep is skipped so it can't block the 07:15 full run.

**9. IDs.** Meta `id` = the store's SKU (`itemNumber`); `item_group_id` = the
product (`pf_id` on PrismRBS). The GTM tag sends the same values:
`ViewContent` with `content_type=product_group` and `[pf_id]`, `AddToCart` with
`content_type=product` and `[sku]`.

## Security decisions

- **Operator auth is a single bearer secret (`ADMIN_TOKEN`).** This is a
  machine credential for one operator, not a user session system. If more people
  need access, put the admin routes behind Cloudflare Access (SSO) or real
  server-side sessions before handing out access. Compared constant-time; fails
  closed (503) when unset.
- **Feed URL uses HTTP Basic per site** (user = site ID, password = random
  32-byte token, stored as SHA-256). No credential in the URL. Unknown site and
  wrong password return the same 401.
- **Meta tokens are encrypted** (AES-256-GCM, key `TOKEN_ENC_KEY`) and never
  returned. Before storing, the token is checked against the catalog ID through
  the Graph API, so one site can't be pointed at a catalog its token doesn't own.
  The catalog ID is validated as numeric before it is placed in a URL.
- **Outbound fetches are confined to the site's own host** (plus its www/apex
  twin), https only, redirects re-checked each hop, 20 s timeout, 8 MB body cap.
  Admin-supplied base URLs must be public https hostnames (no IP literals,
  localhost, or internal names).
- **Request limits:** 64 KB admin bodies; zod validation with length/range caps
  on every input; per-site config parsed by schema on every read.
- **Docs page exception:** `/docs` (Scalar) loads its UI script from a CDN. It
  serves only the public OpenAPI document; no app data or credentials.

## Consequences

- New platforms cost one adapter plus fixtures.
- Stock freshness is bounded by the sweep interval (2 h) plus Meta's processing.
- A store template change shows up as a rejected run (error rate gate), not as
  a catalog of wrongly sold-out items.
