CREATE TABLE IF NOT EXISTS rss_review_articles (
  review_id TEXT PRIMARY KEY,
  source_id INTEGER REFERENCES rss_sources(id) ON DELETE SET NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  author TEXT,
  published_at TEXT,
  feed_url TEXT,
  content_hash TEXT NOT NULL,
  raw_feed_item_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_article_id TEXT,
  approved_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  rejected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rss_review_articles_status
  ON rss_review_articles(status, published_at DESC);

CREATE TABLE IF NOT EXISTS rss_review_mentions (
  review_id TEXT NOT NULL REFERENCES rss_review_articles(review_id) ON DELETE CASCADE,
  entity_source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  matched_text TEXT NOT NULL,
  confidence REAL NOT NULL,
  context TEXT,
  entity_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (review_id, entity_type, entity_source_id)
);

CREATE INDEX IF NOT EXISTS idx_rss_review_mentions_entity
  ON rss_review_mentions(entity_type, entity_source_id, created_at DESC);
