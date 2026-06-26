# Legislative RSS Scraper

A Cloudflare Worker that watches RSS/Atom feeds, checks articles against legislators, candidates, and bills stored in your `nhdb` Cloudflare D1 database, and queues matching articles for review before adding approved articles to D1.

The scraper prefers feed data first. If a source has `fetch_article_pages = 1`, it also fetches the article URL and extracts readable page text when the feed summary is too thin.

## What It Creates

- `rss_sources`: news feeds to poll.
- `d1_legislators`, `candidates`, and `d1_bills`: existing `nhdb` source tables used to build search terms.
- `rss_review_articles` and `rss_review_mentions`: pending scraper matches for spreadsheet review.
- `d1_articles`: existing `nhdb` article table where approved RSS articles are saved.
- `d1_article_legislators`, `d1_article_bills`, and `d1_article_candidates`: approved article/entity link tables.
- `rss_article_mentions`: approved scraper match details with confidence and context.
- `rss_article_metadata`: feed-specific article metadata.
- `scrape_runs`: run metadata and errors.
- `recent_entity_mentions`: a convenience view for latest matches.

## Setup

Install dependencies:

```bash
npm install
```

This project is configured to use the existing D1 database `nhdb`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "nhdb",
    "database_id": "e72f4c03-671f-47d5-8f70-a6792ba8f6c0"
  }
]
```

Apply migrations locally:

```bash
npm run db:migrate:local
```

Apply migrations to Cloudflare:

```bash
npm run db:migrate:remote
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## Use

Trigger a scrape manually:

```bash
curl -X POST "http://localhost:8787/scrape?limit=20"
```

Open pending review rows as JSON:

```bash
curl "http://localhost:8787/review?status=pending&limit=100"
```

Open the browser review UI:

```bash
open "http://localhost:8787/review-ui"
```

Approve reviewed articles by `review_id`:

```bash
curl -X POST "http://localhost:8787/approve" \
  -H "content-type: application/json" \
  -d '{"reviewIds":["review_abc123"],"approvedBy":"Randall","notes":"approved from sheet"}'
```

Reject reviewed articles by `review_id`:

```bash
curl -X POST "http://localhost:8787/reject" \
  -H "content-type: application/json" \
  -d '{"reviewIds":["review_abc123"],"notes":"not relevant"}'
```

See approved matches:

```bash
curl "http://localhost:8787/matches?limit=25"
```

Check configured sources and entities:

```bash
curl "http://localhost:8787/sources"
curl "http://localhost:8787/entities?q=smith"
```

The Worker also runs on the cron in `wrangler.jsonc`: every four hours at minute 17.

## Review UI

The Worker does not write straight into approved article tables during scraping. Instead:

1. Scrapes create pending rows in `rss_review_articles`.
2. Open `/review-ui` in a browser.
3. Review the article title, summary, source URL, matched entities, confidence, and context.
4. Click `Approve` to promote the article into D1, or `Deny` to reject it.
5. Approved rows are promoted into `d1_articles`, `rss_article_metadata`, `rss_article_mentions`, and the article/entity link tables.

Set a Worker secret named `REVIEW_TOKEN` before approving or rejecting from the UI. `/approve` and `/reject` require an `x-review-token` header with that value.

## Default Sources

The seed migration starts with:

- NHPR NH Politics
- InDepthNH
- NH Fiscal Policy Institute
- Union Leader Politics
- NHCADSV
- Open Democracy NH

## Add Sources

```sql
INSERT INTO rss_sources (name, feed_url, site_url, fetch_article_pages)
VALUES ('Local News', 'https://example.com/rss.xml', 'https://example.com', 1);
```

Set `fetch_article_pages` to `0` for sites that block bots, serve huge pages, or have restrictive terms.

## Entity Sources

The scraper builds search terms from existing `nhdb` rows:

- legislators from `d1_legislators`, including `Rep. Lastname`, `Sen. Lastname`, and full-name variants;
- candidates from `candidates`, including campaign-style variants like `Lastname for Office`;
- bills from `d1_bills`, including condensed and expanded bill-number variants plus short descriptions.

## Matching Behavior

The matcher looks for whole phrase matches across title, feed summary/content, and optional article page text. It assigns a simple confidence score based on:

- exact display-name matches,
- role words near people, such as `Sen.` or `Representative`,
- bill words near legislation, such as `H.R.`, `Act`, or `bill`,
- multi-word terms.

This is intentionally conservative and transparent. A good next step is to add a review queue or domain-specific rules for states, districts, and committees.
