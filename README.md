# Feedsmith

Product catalog feeds for online stores that can't export one.

Feedsmith reads a store's public product pages and tracks every size and color
of every product (price, stock, images). From that it keeps a Meta catalog
current in three ways:

- **A feed URL** that Commerce Manager fetches on a schedule (CSV, Meta's
  template format, password protected).
- **Live updates** pushed through Meta's Catalog Batch API as soon as prices or
  stock change, so Meta doesn't wait for the next scheduled fetch.
- **Product sets**, defined once in Feedsmith, created and kept in sync in
  Meta, and also available as their own item lists and feeds.

It runs on Cloudflare (Workers, D1, R2, Queues, Cron) and handles many clients
from one deployment.

Live instance: `https://feedsmith.edwin-6f1.workers.dev`. Interactive API
docs are at `/docs`, and the OpenAPI contract is at `/openapi.json`.

---

## Contents

- [Concepts](#concepts)
- [How it works](#how-it-works)
- [Onboarding a client](#onboarding-a-client)
- [Product sets](#product-sets)
- [The Meta pixel (GTM tag)](#the-meta-pixel-gtm-tag)
- [Operating it](#operating-it)
- [API at a glance](#api-at-a-glance)
- [Development and deployment](#development-and-deployment)
- [Repository layout](#repository-layout)

---

## Concepts

| Term | Meaning |
|---|---|
| **Client** | The business you run feeds for. Holds one or more sites. |
| **Site** | One storefront: base URL, platform, crawl settings, feed password, Meta connection. |
| **Platform / adapter** | How a storefront is read. Detected automatically. `prismrbs` (campus stores on PrismRBS) and `jsonld` (any store that publishes schema.org Product data: many Shopify, WooCommerce, BigCommerce and custom sites) produce product catalogs. `dealeron` (car dealer sites on DealerOn) produces a **vehicles** catalog. |
| **Catalog type** | `commerce` (Meta product catalog) or `vehicles` (Meta automotive inventory). It follows the platform, and sets the feed columns, the Batch API item type and the product-set fields. |
| **Product / variant** | A product (one page) has variants: one per size/color, each with its own SKU. Each variant is one row in the feed (`id` = SKU, `item_group_id` = product). |
| **Run** | One crawl. `full` finds every product, then reads each. `sweep` re-reads known products for price and stock. |
| **Change** | A variant created, updated, sold out or back in stock. Changes are what get pushed to Meta. |
| **Product set** | A named filter over the feed (for example Women's, Kids, Clearance). Synced to Meta, and also served as its own list and feed. |

## How it works

```
Cron ──► full crawl nightly (07:15 UTC) / sweep every 2 h (:45)
           │
           ▼
 discover products ──► queue (5 products per message) ──► read page, parse,
                                                           diff against last known,
                                                           store variants + changes
           │
           ▼ last read
 finalize: publish gates ──► feed CSV to R2 ──► push changes to Meta Batch API
```

Safety rules, so a bad crawl never damages a client's catalog:

- **Sold out is never "deleted".** A size that disappears from the page, or a
  product the store removes, becomes `out of stock`, and Meta keeps the
  item's ad history.
- **A page that can't be read changes nothing.** Only positive evidence changes
  stock.
- **Publish gates.** A run is rejected, and the last good feed stays live, if
  any of these is true:
  - more than 20% of pages fail to read;
  - more than 10% of products report gone;
  - more than 25% of in-stock items sell out in one run;
  - discovery finds under 80% of last time's products;
  - the feed would shrink by more than 20%.

  All of these thresholds are configurable per site.
- **Every step is safe to retry.** Queue redelivery, crashes and duplicate
  messages don't double count or double push.

Design decisions are recorded in [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).

---

## Onboarding a client

Takes about 30 minutes, most of it waiting for the first crawl.

### 0. Shell setup

Every API call uses the admin token. Run this from the repo:

```sh
export FEEDSMITH=https://feedsmith.edwin-6f1.workers.dev
export FS_ADMIN="$(cat .secrets/admin-token)"
api() { curl -s -H "authorization: Bearer $FS_ADMIN" -H 'content-type: application/json' "$@"; echo; }
```

### 1. Create the client

```sh
api -X POST $FEEDSMITH/admin/clients -d '{
  "id": "ua-supply-store",
  "name": "University of Alabama Supply Store",
  "notes": "PrismRBS. Contact: ..."
}'
```

IDs are lowercase letters, digits and dashes.

### 2. Check a product page reads correctly

Create the site, then preview one product URL. Preview shows exactly what
Feedsmith extracts, without saving anything.

```sh
api -X POST $FEEDSMITH/admin/sites -d '{
  "id": "supe-store",
  "clientId": "ua-supply-store",
  "name": "University of Alabama Supply Store",
  "baseUrl": "https://www.universitysupplystore.com/",
  "config": {
    "defaultBrand": "University of Alabama Supply Store",
    "brandKeywords": ["Nike", "Jordan", "Columbia", "Champion", "Under Armour"]
  }
}'
```

- **Save the `feedPassword` from the response.** It's shown once. You can make a new one later
  with `POST /admin/sites/{id}/feed-password`.
- **`platform`** is detected from the homepage. Pass `"platform": "prismrbs"` or
  `"jsonld"` to force it.
- **`defaultBrand`** is used when a title names no brand. Meta requires a brand,
  so set this to the store's name.
- **`brandKeywords`** are brand names to pick out of product titles.

```sh
api -X POST $FEEDSMITH/admin/sites/supe-store/preview -d '{
  "url": "https://www.universitysupplystore.com/shop_product_detail.asp?pf_id=211098&type=1"
}'
```

Check the variants: SKUs, prices, sizes, images, availability.

Optional `config` settings:

| Setting | Use |
|---|---|
| `maxProducts` | Cap a trial crawl. |
| `excludeCatalogIds` | Skip store categories (PrismRBS), e.g. gift cards. |
| `includeUrlPatterns`, `excludeUrlPatterns` | Limit which sitemap URLs are read (generic sites). |
| `crawlConcurrency` | Requests in parallel. Default 2; keep it low. |
| `maxErrorRate`, `minDiscoveryRatio`, `maxGoneRate`, `maxSoldOutRate`, `minFeedRatio` | Publish gate thresholds. |

### 3. First full crawl

```sh
api -X POST $FEEDSMITH/admin/sites/supe-store/runs -d '{"mode":"full"}'
# poll until status is "published"
api $FEEDSMITH/admin/runs/<run-id>
```

The run's `notes` include counts, gate results and feed size. A 2,500-product
store takes about 15–18 minutes. Download and check the feed:

```sh
curl -u supe-store:<feed-password> $FEEDSMITH/feeds/supe-store/meta.csv -o feed.csv
node scripts/validate-feed.ts feed.csv   # checks Meta's required fields and formats
```

From here the schedule takes over: a full crawl nightly and a sweep every 2 hours.

### 4. Connect the feed URL in Commerce Manager

In the client's catalog, go to **Data sources**, then **Add items**, then
**Data feed**, then **Use a URL or Google Sheets**.

| Field | Value |
|---|---|
| URL | `https://feedsmith.edwin-6f1.workers.dev/feeds/<site-id>/meta.csv` |
| Username | the site ID |
| Password | the feed password |
| Schedule | Daily (or Hourly) |
| Currency | USD |

The first fetch should report the same item count as the run's feed. Copy the
**catalog ID** from Catalog, then Settings.

### 5. Connect live updates (Batch API)

You need a system-user token with `catalog_management` from the client's
Business Manager:

1. **App:** at developers.facebook.com/apps, create a **Business**-type app
   connected to the client's business portfolio (skip if one exists).
2. **System user:** Business Settings, then Users, then **System users**,
   then **Add**, with role Admin.
3. **Assign assets** on the system user:
   - the catalog, with **Full control**;
   - the app, with full control.
4. **Generate new token:** pick the app, set expiry to **Never**, and check
   **`catalog_management`**. If it isn't listed, add the Marketing API
   product to the app first.
5. Connect it from your own terminal, so the token never lands in chat logs
   or shell history:

   ```sh
   read -s META_TOKEN   # paste, Enter
   curl -X PUT $FEEDSMITH/admin/sites/supe-store/meta \
     -H "authorization: Bearer $FS_ADMIN" -H 'content-type: application/json' \
     -d "{\"catalogId\":\"<CATALOG_ID>\",\"accessToken\":\"$META_TOKEN\"}"
   unset META_TOKEN
   ```

   Feedsmith checks the token against the catalog, then stores it encrypted.
   It is never returned. A reply with the catalog's name means it's connected.

The next run pushes every item once. After that, pushes carry only changes.
To see how Meta processed a run's pushes:

```sh
api $FEEDSMITH/admin/runs/<run-id>/meta-status   # status per batch, with item errors
```

### 6. Product sets

```sh
api -X POST $FEEDSMITH/admin/sites/supe-store/product-sets/defaults
```

This creates the recommended sets from what's in the feed and syncs them to
Meta. See [Product sets](#product-sets).

### 7. The pixel

Install the GTM tag so the Meta pixel sends product IDs that match the
catalog. See [The Meta pixel](#the-meta-pixel-gtm-tag).

### Checklist

- [ ] Client created, site created and assigned
- [ ] Preview of 2–3 product URLs looks right (prices, sizes, images)
- [ ] First full run `published`, `validate-feed` shows no problems
- [ ] Feed URL connected in Commerce Manager, first fetch counts match
- [ ] Batch API token connected; `meta-status` of the first push shows `finished`, 0 errors
- [ ] Product sets created and visible in Commerce Manager
- [ ] GTM tag live; Events Manager shows ViewContent/AddToCart matched to catalog items

---

## Product sets

A product set is a filter over the feed, in Meta's own filter format. Feedsmith
stores each one per site and:

- creates it in the site's Meta catalog, tagged `retailer_id = feedsmith:<slug>`,
  and updates it when you change it;
- counts its items live;
- serves its items as JSON and as **its own feed**, separate from the full
  catalog.

### Recommended sets

`POST /admin/sites/{id}/product-sets/defaults` builds these from the labels
present in the feed. Sets that would be empty are skipped, because Meta won't
deliver ads from an empty set.

| Slug | Filter |
|---|---|
| `all-in-stock` | in stock AND not clearance (the default prospecting set) |
| `dept-<name>` | one per store department (`custom_label_0`) |
| `womens` | `gender` = female |
| `kids` | `age_group` is kids, toddler, infant or newborn |
| `clearance` | `custom_label_1` = clearance |

Existing slugs are left alone; add `?overwrite=true` to reset them.

**Hand-made sets:** if the catalog already has a set with exactly the same filter
(made by hand in Commerce Manager), Feedsmith links to it instead of
duplicating it, and keeps its name.

### Custom sets

```sh
api -X PUT $FEEDSMITH/admin/sites/supe-store/product-sets/gifts-under-25 -d '{
  "name": "Gifts under $25",
  "filter": { "and": [
    { "custom_label_2": { "eq": "Under $25" } },
    { "custom_label_1": { "neq": "clearance" } }
  ] }
}'
```

Fields you can filter on:

| Field | Values |
|---|---|
| `availability` | in stock, out of stock |
| `brand` | |
| `product_type` | the store's category, e.g. T-Shirts |
| `gender` | female, male, unisex |
| `age_group` | adult, kids, toddler, infant, newborn |
| `color`, `size`, `condition` | |
| `custom_label_0` | department |
| `custom_label_1` | `clearance` |
| `custom_label_2` | price band: Under $25, $25-$50, $50-$100, $100+ |
| `custom_label_3` | `featured` |
| `retailer_id` | SKU |
| `price_amount` | price in cents |

Operators:
- text and enum fields: `eq`, `neq`, `contains`, `not_contains`, `i_contains`, `i_not_contains`, `is_any`, `is_not_any`;
- `price_amount`: `lt`, `lte`, `gt`, `gte`, `eq`, `neq`;
- combining: `and` / `or` (up to 4 levels, 50 rules).

Invalid filters are rejected with the reason.

### Pulling sets

```sh
api $FEEDSMITH/admin/sites/supe-store/product-sets                     # all sets, live counts, Meta IDs, sync errors
api "$FEEDSMITH/admin/sites/supe-store/product-sets/kids/items?limit=100"   # items as JSON; pass "next" as &after= for more
curl -u supe-store:<feed-password> $FEEDSMITH/feeds/supe-store/sets/kids/meta.csv   # the set as its own feed
api -X POST $FEEDSMITH/admin/sites/supe-store/product-sets/sync        # re-push every set to Meta
api -X DELETE $FEEDSMITH/admin/sites/supe-store/product-sets/kids      # delete here and on Meta
```

Meta refuses to delete a set that live ads use. The error is returned and the
set is kept.

The full set recipe, with item counts for the Supply Store, is in
[docs/product-sets.md](docs/product-sets.md).

---

## The Meta pixel (GTM tag)

The feed lets Meta show products. Retargeting people who viewed specific
products also needs the pixel to send the same IDs. `gtm/prismrbs-meta-events.html`
is a GTM Custom HTML tag for PrismRBS stores:

| Event | When | `content_ids` |
|---|---|---|
| `ViewContent` | on product pages | `pf_id` (= `item_group_id`) |
| `AddToCart` | only after the store confirms the add | the chosen SKU (= `id`), with value and currency |

Install:

1. In GTM, go to Tags, then New, then **Custom HTML**, and paste the file.
2. Trigger: **All Pages (DOM Ready)**.
3. Tag sequencing: fire the existing Meta pixel tag first.
4. Publish.
5. In Events Manager, turn off **Track events automatically without code**, so
   Meta stops estimating its own AddToCart.

Test it with `node test/gtm.e2e.ts`. It runs the tag on a live product page
with a recording pixel stub, and adds one item to a throwaway cart (it never
checks out).

---

## Operating it

**Schedules:**

| Job | When |
|---|---|
| Full crawl | 07:15 UTC nightly |
| Sweep | :45 every 2 hours (skipped at 06:45 so it can't block the full crawl) |

Runs stuck over 6 hours are marked failed.

**Health of a site:**

```sh
api "$FEEDSMITH/admin/sites/supe-store/runs?limit=5"   # status, error per run
api $FEEDSMITH/admin/runs/<run-id>                     # counts, gates, feed stats, Meta push, error sample
api "$FEEDSMITH/admin/sites/supe-store/changes?limit=50"
api $FEEDSMITH/admin/sites/supe-store                  # variant counts by availability
```

**When a run is rejected:** read `error` and `notes.gates.reasons` on the run.
The last good feed is still live.

| Gate | What it usually means |
|---|---|
| Error rate | The store was down or changed its page layout. Preview a product URL to see. |
| Gone rate | Products are returning 404; check the store's URLs. |
| Sell-out rate | Usually a layout change that hides sizes. |
| Discovery ratio or feed shrink | Categories moved, or a config change dropped required fields (such as brand). |

A real large change can be accepted by loosening that site's threshold for one
run with `PATCH /admin/sites/{id}`.

**Secrets:**
- They live in `.secrets/` (git-ignored, mode 600); keep a copy in your
  password manager.
- Rotate a site's feed password with `POST /admin/sites/{id}/feed-password`,
  then update Commerce Manager.
- Replace a Meta token with `PUT /admin/sites/{id}/meta`; remove it with
  `DELETE /admin/sites/{id}/meta`.

**Known gaps** are listed in [docs/followups.md](docs/followups.md).

---

## API at a glance

All `/admin/*` routes need `Authorization: Bearer <ADMIN_TOKEN>`. Feeds use
HTTP Basic with the site ID and feed password. Full reference: `/docs`.

| Area | Routes |
|---|---|
| Clients | `POST/GET /admin/clients`, `GET/PATCH /admin/clients/{id}`, `PUT /admin/sites/{id}/client` |
| Sites | `POST/GET /admin/sites`, `GET/PATCH /admin/sites/{id}`, `POST /admin/sites/{id}/preview`, `POST /admin/sites/{id}/feed-password` |
| Runs | `POST/GET /admin/sites/{id}/runs`, `GET /admin/runs/{id}`, `GET /admin/sites/{id}/changes` |
| Meta | `PUT/DELETE /admin/sites/{id}/meta`, `GET /admin/runs/{id}/meta-status` |
| Product sets | `GET /admin/sites/{id}/product-sets`, `PUT/DELETE …/product-sets/{slug}`, `POST …/product-sets/defaults`, `POST …/product-sets/sync`, `GET …/product-sets/{slug}/items` |
| Feeds | `GET /feeds/{site}/meta.csv`, `GET /feeds/{site}/sets/{slug}/meta.csv` |

---

## Development and deployment

Requires Node 22.18+ and pnpm (the version is pinned in `package.json` via
Corepack).

```sh
pnpm install
cp .dev.vars.example .dev.vars    # ADMIN_TOKEN (24+ chars), TOKEN_ENC_KEY: openssl rand -base64 32
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787 (local D1, R2 and queues)
```

Checks (CI runs the first four on every push, plus secret scanning):

```sh
pnpm typecheck
pnpm test                         # parsers on real store pages, plus the whole pipeline on SQLite with injected crashes
node scripts/audit-routes.ts      # warning-only: undocumented or unwired routes
node scripts/validate-feed.ts f.csv
node test/gtm.e2e.ts              # live: GTM tag on the real store
```

Deploy:

```sh
pnpm exec wrangler d1 migrations apply feedsmith --remote
pnpm exec wrangler deploy
```

For a fresh Cloudflare account:
1. Create D1 `feedsmith`, R2 bucket `feedsmith-feeds`, and queues
   `feedsmith-crawl` and `feedsmith-crawl-dlq`.
2. Put the D1 ID in `wrangler.jsonc`.
3. Run `wrangler secret put ADMIN_TOKEN` and `wrangler secret put TOKEN_ENC_KEY`.

Re-run `pnpm exec wrangler types` after changing bindings in `wrangler.jsonc`.

**Adding a platform:** write an adapter in `src/adapters/` implementing
`detect`, `discover`, `read` and `refFromUrl`, register it in
`registry.ts`, and add fixtures from real pages. Nothing downstream changes.

## Repository layout

```
src/
  adapters/    platform readers: prismrbs.ts, jsonld.ts, registry
  core/        model, HTML/HTTP helpers, diffing, feed format, set filters, crypto
  pipeline/    D1 store, crawl orchestration, feed publishing, Meta API, product sets
  api/         Hono + OpenAPI routes, auth
  index.ts     Worker entry: fetch, queue, cron
migrations/    D1 schema
gtm/           pixel tag for PrismRBS stores
scripts/       feed validator, route audit
test/          unit, integration (SQLite) and live e2e tests; fixtures are saved store pages
docs/          PRD, ADR, product sets, followups
```
