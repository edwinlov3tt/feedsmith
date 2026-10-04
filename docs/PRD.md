# Phase 1: Feedsmith, catalog feeds for stores without a feed export

## Problem

Stores on platforms like PrismRBS (campus stores) have no product feed export,
so they can't run Meta catalog (Advantage+ / dynamic product) ads. Their Meta
pixel also sends no product IDs, so even with a catalog Meta couldn't match
visitors to products for retargeting.

First client: University of Alabama Supply Store (universitysupplystore.com,
PrismRBS). Built to serve any store with a reader ("adapter") per platform.

## Goals

1. A Meta catalog feed for every site: CSV at a stable URL Meta fetches on a schedule.
2. Stock and price changes reach Meta within about two hours, not on the next daily fetch.
3. The pixel sends `content_ids` that match the feed, so retargeting works.
4. One engine for many sites: adding a platform means one adapter, nothing else.
5. Never publish a bad feed: a broken crawl keeps the last good feed live.

## Non-goals (this phase)

- An admin UI (the API plus Scalar docs covers operation; see followups).
- Google Merchant Center and TikTok feed formats (same data, different columns).
- Checkout and purchase tracking (needs a real order to observe the confirmation page).

## What was verified (2026-10-02)

- PrismRBS product pages embed every in-stock variant as inline JS (`itemList`)
  with SKU, price and labeled options. Sold-out sizes drop out of the list.
- The same markup on a second PrismRBS store (bookstore.illinois.edu), unchanged.
- Book pages (`type=3`) use a different SKU input and expose ISBNs.
- The store's Meta pixel (624924851908088 via GTM-KB52PZMG) sends PageView plus
  Meta-estimated AddToCart/InitiateCheckout with no `content_ids` (capture from a
  real browser session with the supe-capture extension).
- Generic stores: schema.org JSON-LD in two shapes (ProductGroup + hasVariant;
  Product with one Offer per size), found via robots.txt and sitemaps.

## Scope delivered

| Part | Where |
|---|---|
| Platform-neutral product model, diffing, Meta feed rows | `src/core/` |
| PrismRBS adapter, generic JSON-LD adapter | `src/adapters/` |
| Queue-driven crawl, publish gates, R2 feed, Meta Batch API push | `src/pipeline/` |
| Operator REST API (OpenAPI 3.1 + Scalar at `/docs`), Basic-auth feed URL | `src/api/` |
| GTM tag sending ViewContent/AddToCart with feed IDs | `gtm/` |
| Decisions | `docs/adr/` |

## Success measures

- Feed accepted by Commerce Manager with no rejected items for missing fields.
- A size selling out on the site shows "out of stock" in Meta within one sweep (2 h).
- Events Manager shows ViewContent/AddToCart matched to catalog items.
