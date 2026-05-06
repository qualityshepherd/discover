CREATE VIRTUAL TABLE IF NOT EXISTS feeds_fts USING fts5(
  feed_id UNINDEXED,
  title,
  description,
  tags,
  author
);

INSERT INTO feeds_fts (feed_id, title, description, tags, author)
SELECT
  id,
  COALESCE(title, ''),
  COALESCE(description, ''),
  COALESCE(tags, '[]'),
  COALESCE(author, '')
FROM feeds;
