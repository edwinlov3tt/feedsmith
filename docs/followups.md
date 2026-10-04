# Followups

Non-blocking items, most important first.

## Needs credentials or a decision

- **Deployed 2026-10-04** to the "Edwins Cloudflare" account as
  `https://feedsmith.edwin-6f1.workers.dev` (D1 `feedsmith`, R2 `feedsmith-feeds`,
  queues `feedsmith-crawl` and `feedsmith-crawl-dlq`). Secrets live in
  `.secrets/` (git-ignored, mode 600): `admin-token`, `token-enc-key`,
  `feed-password-supe-store`. Move them into a password manager.
- **Verified 2026-10-04: Commerce Manager scheduled URL feed with a password**
  fetches `/feeds/supe-store/meta.csv` (test catalog 2072477680053581).
- **Verified 2026-10-04: Batch API and product sets** against test catalog
  2072477680053581: 5,398 items pushed in 6 batches, all `finished` with 0
  errors; 8 product sets created/adopted, update and delete calls succeeded.
- **Install the GTM tag** (`gtm/prismrbs-meta-events.html`) in GTM-KB52PZMG, and
  turn off Meta's "Track events automatically without code" so its estimated
  AddToCart stops double counting. Tested live with a stubbed pixel only.

## Product gaps

- **Purchase and InitiateCheckout events.** Checkout sits behind a login, so
  the order confirmation page hasn't been observed. Capture one real order with
  the supe-capture extension (`~/dev/supe-capture`), then extend the GTM tag.
- **Admin UI.** Deferred: the API and `/docs` cover operation. If built, put it
  behind Cloudflare Access, not the bearer token.
- **Google Merchant Center and TikTok feeds.** Same variants, different
  columns. Google also wants `identifier_exists=no` where there's no GTIN.
- **Pre-order availability.** Items like the Tide Together shirt only say
  "PRE-ORDER" in their description; they're published as "in stock".
- **Per-color images on PrismRBS.** All variants use the product's main image;
  the page has an attribute-photo slot that may hold color-specific images.
- **`maxProducts` trims after discovery,** so a trial still reads every category
  page (about 130 pages, ~95 s on the Supply Store).
- **Gone products leave sweeps.** A product the site reports gone is skipped by
  2-hourly sweeps until the nightly full run rediscovers it, so a restock of a
  fully sold-out product can take up to a day to show.
- **Images under 500x500.** Meta's minimum for catalog ads. A 25-image sample of
  the Supply Store had 2 under it (300x388, 400x400), so roughly 8% of products.
  Fix: read image dimensions during the crawl (once per image URL, cached) and
  flag or skip them.
- **google_product_category.** Optional in Meta's template but helps delivery.
  Needs a per-site map from store categories to Google's taxonomy.
- **Brands come from title keywords.** Anything without a keyword match gets the
  store name (4,154 of 5,034 items). A per-site keyword list covers the big
  brands; a real brand field isn't exposed by PrismRBS.
- **More adapters.** Shopify (`/products.json`) and WooCommerce Store API would
  be faster and more complete than JSON-LD for those platforms.
- **PrismRBS adapter does not read robots.txt.** The Supply Store's robots.txt
  allows the shop pages we read (checked 2026-10-02); the generic adapter does
  honor robots.txt.

## Notes

- TODO(legal): crawling stores hosted on PrismRBS (vendor ToS) and other
  third-party platforms; collected for the end-of-project review.
