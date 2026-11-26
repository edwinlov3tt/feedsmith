-- Product images copied to R2 and served from our own host, for feeds whose
-- platform can't fetch from the store (see docs/adr/0001-architecture.md, 7g).
CREATE TABLE images (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  -- pending: not copied yet, or the last try failed in a way that can recover.
  -- ok: copied. bad: the store answered, and it isn't a usable image.
  status TEXT NOT NULL DEFAULT 'pending',
  file TEXT,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  error TEXT,
  checked_at TEXT,
  PRIMARY KEY (site_id, source_url)
);
CREATE INDEX images_due ON images (site_id, status, checked_at);
