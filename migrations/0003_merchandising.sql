-- Merchandising labels found at discovery, kept on the product so 2-hourly
-- sweeps (which skip discovery) still label items for product sets.
ALTER TABLE products ADD COLUMN department TEXT;
ALTER TABLE products ADD COLUMN clearance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
