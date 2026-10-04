-- Clients own sites. A client is the business we run feeds for; a site is one
-- storefront of theirs.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE sites ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;

-- Product sets: named filters over the feed, kept in Meta's filter format so
-- the same definition is synced to Meta and evaluated locally.
CREATE TABLE product_sets (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  meta_set_id TEXT,
  meta_synced_at TEXT,
  meta_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, slug)
);
