UPDATE sources
SET title = json_extract(posts, '$[0].feed.title')
WHERE title IS NULL AND posts IS NOT NULL AND posts != '[]' AND posts != 'null';
