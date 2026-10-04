# Feedsmith

Product feeds for stores that can't export one. Feedsmith reads a storefront's
public pages, tracks every variant's price and stock, and publishes a Meta
catalog feed. Changes are also pushed to Meta's Batch API between feed fetches.

- **Platforms:** PrismRBS (campus stores) and any site with schema.org Product
  JSON-LD. Add more with one adapter (`src/adapters/`).
- **Runs on:** Cloudflare Workers, D1, R2, Queues and Cron.
- **Pixel fix:** `gtm/prismrbs-meta-events.html` makes the Meta pixel send IDs
  that match the feed.

Docs: [PRD](docs/PRD.md), [ADR-0001](docs/adr/0001-architecture.md),
[followups](docs/followups.md). API reference is served at `/docs`, and the
contract at `/openapi.json`.

## How it works

```
cron  -> full (07:15 UTC) or sweep (every 2 h)
full  -> discover products -> queue reads (5 per message) -> parse, diff, store
sweep -> queue reads for known products
last read -> finalize: publish gates -> CSV to R2 -> Meta items_batch push
```

Variants are never deleted. A sold-out size becomes `out of stock`.

A page that can't be read changes nothing. A run is rejected, and the last good
feed stays live, if any of these is true:

- over 20% of reads fail
- over 10% of products report gone
- over 25% of in-stock variants sell out at once
- discovery finds under 80% of last time's products

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set ADMIN_TOKEN (24+ chars) and TOKEN_ENC_KEY (openssl rand -base64 32)
pnpm exec wrangler types         # regenerate worker-configuration.d.ts if wrangler.jsonc changes
pnpm db:migrate:local
pnpm dev                         # http://localhost:8787, API docs at /docs
```

Add a site and crawl it. The platform is detected when `platform` is omitted:

```sh
T=$ADMIN_TOKEN
curl -X POST localhost:8787/admin/sites -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{
  "id": "supe-store", "name": "University of Alabama Supply Store",
  "baseUrl": "https://www.universitysupplystore.com/",
  "config": { "defaultBrand": "University of Alabama Supply Store", "brandKeywords": ["Nike", "Columbia"], "maxProducts": 40 }
}'
# -> returns feedPassword once; keep it
curl -X POST localhost:8787/admin/sites/supe-store/runs -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"mode":"full"}'
curl -u supe-store:$FEED_PASSWORD localhost:8787/feeds/supe-store/meta.csv
```

Onboarding a new store: `POST /admin/sites/{id}/preview` with a product URL
shows exactly what will be extracted, without saving anything.

## Checks

```sh
pnpm typecheck
pnpm test                  # unit tests on real-page fixtures, plus the full pipeline on SQLite with injected crashes
node scripts/audit-routes.ts   # warning-only: undocumented or unwired routes
node test/gtm.e2e.ts       # live: GTM tag on the real store (adds 1 item to a throwaway cart)
```

## Connecting Meta

1. **Feed:** in Commerce Manager, add a data source with a scheduled feed. Use
   `https://<worker>/feeds/<site>/meta.csv` with username = site ID and
   password = feed password. Rotate it with `POST /admin/sites/{id}/feed-password`.
2. **Live updates:** `PUT /admin/sites/{id}/meta` with `catalogId` and a
   system-user token that has `catalog_management`. The token is checked
   against the catalog, then stored encrypted.
3. **Pixel:** add `gtm/prismrbs-meta-events.html` as a GTM Custom HTML tag (the
   instructions are at the top of the file). Then turn off automatic event
   tracking in Events Manager.

## Deploying

See [followups](docs/followups.md#needs-credentials-or-a-decision). You'll need
the D1/R2/Queue resources, the two secrets, then `pnpm exec wrangler d1
migrations apply feedsmith --remote` and `pnpm deploy`.
