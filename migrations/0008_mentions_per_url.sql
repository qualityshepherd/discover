-- UNIQUE(from_post, to_domain) meant a roundup post linking three of your
-- posts only recorded the first href. Per-post mentions (the footer embed)
-- need every link kept, so the unique key moves to (from_post, to_url).
-- sqlite can't alter a unique constraint, hence the rebuild.
CREATE TABLE mentions_new (
  id INTEGER PRIMARY KEY,
  from_source TEXT NOT NULL,
  from_post TEXT NOT NULL,
  from_title TEXT,
  from_date TEXT,
  from_content TEXT,
  to_domain TEXT NOT NULL,
  to_url TEXT NOT NULL DEFAULT '',
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_post, to_url)
);
INSERT INTO mentions_new (from_source, from_post, from_title, from_date, from_content, to_domain, to_url, found_at)
  SELECT from_source, from_post, from_title, from_date, from_content, to_domain, COALESCE(to_url, ''), found_at FROM mentions;
DROP TABLE mentions;
ALTER TABLE mentions_new RENAME TO mentions;
CREATE INDEX IF NOT EXISTS mentions_to_domain ON mentions(to_domain);
