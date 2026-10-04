-- A full run strikes each undiscovered product at most once, even if its
-- finalize is redelivered.
ALTER TABLE products ADD COLUMN struck_run_id TEXT;

-- Finalize is claimed by queue message ID: retries of the same message may
-- proceed, a duplicate finalize message may not.
ALTER TABLE runs ADD COLUMN finalize_msg_id TEXT;

-- At most one run in progress per site, enforced by the database rather than
-- a check-then-insert that a cron run and an API call could race.
CREATE UNIQUE INDEX runs_one_active_per_site ON runs (site_id) WHERE status IN ('discovering', 'crawling', 'finalizing');
