CREATE TABLE IF NOT EXISTS post_tags (
  source_url TEXT NOT NULL,
  post_url   TEXT NOT NULL,
  tag        TEXT NOT NULL,
  post_date  TEXT,
  PRIMARY KEY (post_url, tag)
);

CREATE INDEX IF NOT EXISTS post_tags_tag    ON post_tags (tag, post_date DESC);
CREATE INDEX IF NOT EXISTS post_tags_source ON post_tags (source_url);
