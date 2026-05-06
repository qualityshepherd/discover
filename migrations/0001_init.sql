-- feeds: all playlist metadata
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT,
  tags TEXT,            -- JSON array
  cover_image TEXT,
  author TEXT,          -- JSON object { name, url, pubkey }
  owner_pubkey TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  imports INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  update_frequency TEXT,
  last_checked TEXT,
  last_updated TEXT,
  preview_posts TEXT,   -- JSON array cached by cron
  fail_streak INTEGER NOT NULL DEFAULT 0,
  curator_pubkey TEXT,
  curator_name TEXT,
  curator_url TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- feed_sources: many-to-many between feeds and source URLs
CREATE TABLE IF NOT EXISTS feed_sources (
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (feed_id, source_url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS feed_sources_url ON feed_sources(source_url);

-- sources: RSS source metadata + cached posts (merges KV source-data and source-index)
CREATE TABLE IF NOT EXISTS sources (
  url TEXT PRIMARY KEY,
  site_url TEXT,
  posts TEXT,           -- JSON array of last 3 posts
  image TEXT,
  status_code INTEGER,
  error TEXT,
  frequency TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  has_posts INTEGER NOT NULL DEFAULT 0,
  latest_post_url TEXT,
  latest_post_date TEXT,
  last_fetched TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- mentions: cross-source link graph
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY,
  from_source TEXT NOT NULL,
  from_post TEXT NOT NULL,
  from_title TEXT,
  from_date TEXT,
  from_content TEXT,
  to_domain TEXT NOT NULL,
  to_url TEXT,
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_post, to_domain)
);
CREATE INDEX IF NOT EXISTS mentions_to_domain ON mentions(to_domain);

-- curators: invited curators with playlist assignments
CREATE TABLE IF NOT EXISTS curators (
  pubkey TEXT PRIMARY KEY,
  playlist_id TEXT,
  name TEXT,
  site_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT
);

-- sessions: auth tokens
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_pubkey ON sessions(pubkey);

-- rate_limits: login brute-force protection
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- pending: submitted feeds awaiting approval
CREATE TABLE IF NOT EXISTS pending (
  url TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- blocked: domains never accepted
CREATE TABLE IF NOT EXISTS blocked (
  domain TEXT PRIMARY KEY
);

-- curate_candidates: auto-discovered potential sources
CREATE TABLE IF NOT EXISTS curate_candidates (
  domain TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0,
  sources TEXT,
  first_seen TEXT,
  probed_at TEXT,
  feed_url TEXT
);

-- dismissed_domains: domains excluded from curate candidates
CREATE TABLE IF NOT EXISTS dismissed_domains (
  domain TEXT PRIMARY KEY
);

-- user_feed: personal RSS feed configs keyed by slug
CREATE TABLE IF NOT EXISTS user_feed (
  slug TEXT PRIMARY KEY,
  ids TEXT,
  sources TEXT,
  custom_feeds TEXT
);

-- settings: key-value store for misc singleton state (cron:lastOk, user-feed:slug, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
