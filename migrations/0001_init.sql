-- Sites being crawled. config_json is validated by SiteConfigSchema on every read.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  platform TEXT NOT NULL,
  config_json TEXT NOT NULL,
  -- SHA-256 of the feed password (a random 32-byte token), for HTTP Basic on the feed URL.
  feed_password_hash TEXT NOT NULL,
  meta_catalog_id TEXT,
  -- AES-GCM ciphertext of the Meta system-user token, keyed by TOKEN_ENC_KEY. Never returned by the API.
  meta_token_enc TEXT,
  last_discovery_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One crawl. mode: full (discover + read) or sweep (re-read known products).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'sweep')),
  status TEXT NOT NULL CHECK (status IN ('discovering', 'crawling', 'finalizing', 'published', 'rejected', 'failed')),
  total INTEGER NOT NULL DEFAULT 0,
  discovered INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  notes_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX runs_site_started ON runs (site_id, started_at DESC);

-- Per-product outcome within a run. The primary key makes queue redelivery
-- idempotent: a product read twice is still counted once.
CREATE TABLE run_items (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ref_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'gone', 'not_product', 'error')),
  message TEXT,
  PRIMARY KEY (run_id, ref_key)
);

-- Products known for a site, kept so sweeps can skip discovery.
CREATE TABLE products (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ref_key TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'gone', 'not_product')),
  last_discovered_run_id TEXT,
  missing_full_runs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, ref_key)
);

-- Current state of every variant ever seen. Variants are never deleted: a
-- vanished SKU becomes "out of stock" so Meta keeps its ad history.
CREATE TABLE variants (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  availability TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX variants_ref ON variants (site_id, ref_key);

-- Change log. pushed_at stays NULL until the change reaches Meta's Batch API.
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'out_of_stock', 'back_in_stock')),
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pushed_at TEXT
);
CREATE INDEX changes_site_created ON changes (site_id, created_at DESC);
CREATE INDEX changes_unpushed ON changes (site_id, pushed_at) WHERE pushed_at IS NULL;
