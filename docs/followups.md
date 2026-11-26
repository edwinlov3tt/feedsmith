# Followups

Non-blocking items, most important first.

## Needs credentials or a decision

- **Deployed 2026-10-04** to the "Edwins Cloudflare" account as
  `https://feedsmith.edwin-6f1.workers.dev` (D1 `feedsmith`, R2 `feedsmith-feeds`,
  queues `feedsmith-crawl` and `feedsmith-crawl-dlq`). Secrets live in
  `.secrets/` (git-ignored, mode 600): `admin-token`, `token-enc-key`, and one
  `feed-password-<site-id>` per site (`supe-store`, `northstar-ford`,
  `uwyo-store`). Move them into a password manager.
- **Verified 2026-10-04: Commerce Manager scheduled URL feed with a password**
  fetches `/feeds/supe-store/meta.csv` (test catalog 2072477680053581).
- **Verified 2026-10-04: Batch API and product sets** against test catalog
  2072477680053581: 5,398 items pushed in 6 batches, all `finished` with 0
  errors; 8 product sets created/adopted, update and delete calls succeeded.
- **Install the GTM tag** (`gtm/prismrbs-meta-events.html`) in GTM-KB52PZMG, and
  turn off Meta's "Track events automatically without code" so its estimated
  AddToCart stops double counting. Tested live with a stubbed pixel only.
- **TikTok catalog (Supply Store), 2026-10-27.** The team first loaded the
  Meta feed URL into TikTok; items showed "In stock" but Status "Unavailable".
  Status is TikTok's product review, not our availability column. Switch the
  TikTok data source to `/feeds/supe-store/tiktok.csv` (same credentials), and
  get the reason from an item's "View product details" if items stay
  Unavailable after review. Not yet checked on TikTok's side.
  TikTok's Oct 26 diagnostics then reported "TikTok doesn't have permissions
  to access the image" on 6,878 items (50%), about the whole old Meta-URL
  import. Checked 2026-10-29 from outside: the store's image host returns 200
  JPEGs to every user agent tried (including TikTok/ByteDance ones), robots.txt
  allows `/outerweb/`, there's no rate limit across 40 quick requests, and the
  TLS chain verifies (Let's Encrypt YR2 to ISRG Root X1, TLS 1.2 and 1.3). Not
  tested from TikTok's own network. If the error persists on a report for the
  tiktok.csv source, either the store's host (PrismRBS) allowlists TikTok's
  fetcher or feedsmith mirrors product images to R2 and serves them itself.
  2026-11-05: all 6,907 items still show Status "Unavailable", a week after
  the tiktok.csv upload, so a review backlog is now unlikely. The live feed
  checks out (6,933 rows, required fields filled, 5,854 in stock; 30 sampled
  images were 200 JPEGs, none under 500 px). The cause is still unconfirmed:
  needs TikTok's reason from "View product details" and a diagnostics report
  for the tiktok.csv source, with Issue category set to All (the catalog-wide
  "frozen, no ad activity in 28 days" and "not bound to pixel" issues would
  also hit every item).
  **Strong lead, 2026-11-05: the store's host refuses HTTPS from outside the
  US.** Tested from temporary AWS machines: Virginia and Oregon get 200 for
  images and product pages; Singapore and Frankfurt get "connection refused"
  on port 443 of 52.142.31.64 (port 80 answers). uwyostore.com behaves the
  same, so it looks like a PrismRBS-wide rule. Controls from Singapore (Google,
  example.com, the feedsmith host) worked. TikTok's help page lists Singapore
  addresses for image fetching (103.136.220.238/.239, 103.136.221.238/.239,
  plus 3.225.193.57 and 34.196.227.34) and Singapore and Germany for product
  information. Not proven to be what TikTok hits; its feed fetcher reaches us
  from 18.99.47.x, which isn't on that May 2025 list. Fix: PrismRBS allowlists
  those addresses. Hosting images ourselves (2026-11-06, `mirrorImages`, on for
  supe-store only; measured 753 MB for Alabama, inside R2's free 10 GB and 1-2
  cents a month without it) fixes images only, not product pages.
- **TikTok feed cleanup, found 2026-11-05 against TikTok's issue list.** Line
  breaks in 6,809 of 6,933 descriptions ("control characters are not allowed");
  ™ and ® in descriptions (602 characters; both count as emoji in Unicode);
  literal `<br` in 46 descriptions. All cleaned from the TikTok file since
  2026-11-06 (`tiktokDescription`); the Meta feed keeps the original text, and
  the stray `<br` comes from the PrismRBS adapter's text extraction, so it's
  still in Meta's copy. Titles aren't cleaned: Alabama's have no symbols, but
  3,662 of Wyoming's contain ®. Clean them before uwyo-store goes on TikTok. Main image
  under 500x500 on 122 rows (64 images, mostly 400x400) and one main image link
  that returns an HTML page with a 200 (`14139857L.jpeg`, SKU 14139871112) are
  handled by image hosting on sites with it on. Clean: no duplicate SKUs, column counts,
  links, item group IDs, feed format. Unfixable from the store's data: GTIN
  (missing on 6,923 rows) and additional images (3,669).
- **Turn on image hosting for uwyo-store.** Off for now: followups below say its
  robots.txt disallowed image folders (2026-10-20), and today's file doesn't
  list `/outerweb/`. Confirm, then `PATCH` `mirrorImages`. Estimated 450 MB.
- **Old image copies stay in R2.** A replaced or unused image's file isn't
  deleted, because the live feed may still link to it until the next publish.
  Costs next to nothing; add a cleanup if a store churns images heavily.
- **Syncing an adopted Meta set renames it.** The first sync links to a
  hand-made set and keeps its name (`src/pipeline/meta.ts:352`), but it stores
  the set's ID, so the next sync sends our name (`meta.ts:339`). README says
  the name is kept. Found by reading the code, not tested against Meta. Fix
  before any UI or MCP tool can sync sets.
- **Supply Store department sets are stale.** The store split "Bama
  Merchandise" into Apparel, Bama Gear, Accessories, Home & Office, Athletics
  and Media (new catalog groups 28, 29, 32 and others, seen 2026-10-27), and
  the feed's `custom_label_0` follows. The `dept-bama-merchandise` set now
  matches 2 items. Replace it with sets for the new departments (`PUT
  .../product-sets/dept-apparel` and so on, then delete the old one) once
  the client says which they want; any ad set using it is nearly empty.
- **TikTok image rule with query strings.** `isJpgOrPng` checks the URL path,
  so `photo.png?v=2` counts as PNG. PrismRBS image URLs have no query string,
  but Shopify's all do. Confirm on a first Shopify or JSON-LD TikTok upload
  that TikTok accepts them.
- **TikTok product sets aren't synced.** They're built by hand in TikTok
  Catalog Manager. Syncing them needs TikTok's Catalog API (a TikTok for
  Business developer app plus advertiser authorization).

## Product gaps

- **One shared queue for every site (seen 2026-10-20 with three sites).** The
  queue runs 2 consumers in arrival order, so sites crawled at the same time
  slow each other, and a small site's finalize waits behind larger sites'
  reads: the 22:45 UTC sweeps of a 311-car lot sat in `finalizing` for 30+
  minutes behind two campus stores (~960 read messages), and a 2,138-product
  full run went from 18 to 35+ minutes. Per-site politeness
  (`crawlConcurrency`) doesn't need a global cap of 2. Options: raise queue
  `max_concurrency`, send finalize through its own queue, stagger cron starts
  per site. Matters before onboarding more clients.

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
- **Supply Store department labels rest on a breadcrumb cycle.** Its nav links
  the catch-all "Bama Merchandise" page (69 categories) alongside the specific
  departments (Apparel, Bama Gear, Athletics ...). The Gift Ideas breadcrumb
  links back to Bama Merchandise in the same discovery round, which keeps the
  catch-all from naming every category, so the specific names win. Dropping
  that breadcrumb, or a "most specific department wins" rule, would relabel 29
  categories (e.g. Caps, Hats & Beanies from Apparel to Accessories, League
  from Apparel to Brands) and move items between its live product sets.
  Decide the intended rule with the client before changing it; the behaviour
  is pinned by a test.
- **Departments need a landing page.** Departments come from the store's
  `shop_main.asp` department pages. A nav menu with no landing page (Tech on
  uwyostore.com) leaves its categories without `custom_label_0`; they keep
  their `product_type`.
- **Store-side typos in brand prefixes** (uwyostore.com titles spell Zoozatz
  three ways, and Zephyr two). Keywords return their own spelling, so only the
  correct spelling is listed and the misspelled items fall back to the store
  name. Aliases (keyword to brand) would fix it.
- **Brands come from title keywords.** Anything without a keyword match gets the
  store name (4,154 of 5,034 items). A per-site keyword list covers the big
  brands; a real brand field isn't exposed by PrismRBS.
- **Vehicles: which price to publish.** DealerOn pages show the structured offer
  price (used now), plus `data-price` and `data-msrp` attributes. For example, a
  2026 Bronco Sport is $33,118 structured, $35,518 data-price and $37,425 MSRP.
  Confirm with the dealer which is the advertised price; MSRP could go in
  `price` with the offer as `sale_price`.
- **Vehicles: "Call for Price" cars** (18 of 284 at NorthStar Ford) have no price
  anywhere and are left out of the feed, since Meta requires one.
- **Vehicles pixel.** Dealer sites need `ViewContent` with `content_ids = VIN`
  for vehicle retargeting; DealerOn's own pixel setup hasn't been checked.
- **More dealer platforms.** Dealer.com, Dealer Inspire, DealerSocket. Two of the
  four Google-Sheet-fed agency dealers (Griffeth Ford, New Bedford Mitsubishi)
  return HTTP 403 to automated requests and need another approach.
- **More adapters.** Shopify (`/products.json`) and WooCommerce Store API would
  be faster and more complete than JSON-LD for those platforms.
- **PrismRBS adapter does not read robots.txt.** The shop pages it reads
  (`shop_main.asp`, `shop_product_list.asp`, `shop_product_detail.asp`) are
  allowed on the Supply Store (checked 2026-10-02) and uwyostore.com (checked
  2026-10-20; it disallows `/_`, `/cart`, `/search_`, `/textbook`, `/trade` and
  the image folders). Check each new PrismRBS store at onboarding; the generic
  adapter does honor robots.txt.

## Notes

- TODO(legal): crawling stores hosted on PrismRBS (vendor ToS) and other
  third-party platforms; collected for the end-of-project review.
