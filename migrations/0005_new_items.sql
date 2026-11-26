-- "New items" merchandising flag found at discovery, like featured (0003).
ALTER TABLE products ADD COLUMN new_item INTEGER NOT NULL DEFAULT 0;
