-- Candidates get their feed read once at probe time. stats is the JSON the
-- checks ran on (posts/mo, authors, full text, last post, link-backs...),
-- rejected is why the machine said no, null if it passed. A machine no is
-- soft: probed_at is when, and it gets rechecked after 90 days.
-- pending.stats carries the same numbers onto submissions and approved
-- candidates so the pending row can show them.
ALTER TABLE curate_candidates ADD COLUMN stats TEXT;
ALTER TABLE curate_candidates ADD COLUMN rejected TEXT;
ALTER TABLE pending ADD COLUMN stats TEXT;
