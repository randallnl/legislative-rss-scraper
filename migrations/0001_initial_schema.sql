PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rss_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL UNIQUE,
  site_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  fetch_article_pages INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rss_article_metadata (
  article_id TEXT PRIMARY KEY,
  source_id INTEGER REFERENCES rss_sources(id) ON DELETE SET NULL,
  feed_url TEXT,
  author TEXT,
  published_at TEXT,
  content_hash TEXT NOT NULL,
  raw_feed_item_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rss_article_metadata_published
  ON rss_article_metadata(published_at DESC);

CREATE TABLE IF NOT EXISTS rss_article_mentions (
  article_id TEXT NOT NULL,
  entity_source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  matched_text TEXT NOT NULL,
  confidence REAL NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, entity_type, entity_source_id)
);

CREATE INDEX IF NOT EXISTS idx_rss_article_mentions_entity
  ON rss_article_mentions(entity_type, entity_source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS d1_article_candidates (
  article_id TEXT NOT NULL,
  filer_entity_number TEXT NOT NULL,
  candidate_name_raw TEXT NOT NULL,
  PRIMARY KEY (article_id, filer_entity_number)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  sources_checked INTEGER NOT NULL DEFAULT 0,
  articles_seen INTEGER NOT NULL DEFAULT 0,
  articles_saved INTEGER NOT NULL DEFAULT 0,
  mentions_saved INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);

DROP VIEW IF EXISTS recent_entity_mentions;

CREATE VIEW IF NOT EXISTS recent_entity_mentions AS
SELECT
  am.created_at,
  am.entity_type,
  am.display_name,
  am.entity_source_id AS canonical_key,
  am.matched_text,
  am.confidence,
  am.context,
  da.title,
  da.url,
  ram.published_at,
  rs.name AS source_name
FROM rss_article_mentions am
JOIN d1_articles da ON da.article_id = am.article_id
LEFT JOIN rss_article_metadata ram ON ram.article_id = am.article_id
LEFT JOIN rss_sources rs ON rs.id = ram.source_id
ORDER BY am.created_at DESC;
