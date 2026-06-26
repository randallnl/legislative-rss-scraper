const DEFAULT_LIMIT = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "legislative-rss-scraper" });
      }

      if (request.method === "POST" && url.pathname === "/scrape") {
        const limit = readPositiveInt(url.searchParams.get("limit"), env.MAX_FEED_ITEMS_PER_SOURCE, DEFAULT_LIMIT);
        const result = await scrapeAllSources(env, { limit });
        return json(result);
      }

      if (request.method === "GET" && url.pathname === "/review") {
        const limit = readPositiveInt(url.searchParams.get("limit"), "100", 100);
        const status = url.searchParams.get("status") || "pending";
        return json(await listReviewArticles(env, { limit, status }));
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/review-ui")) {
        const limit = readPositiveInt(url.searchParams.get("limit"), "50", 50);
        const status = url.searchParams.get("status") || "pending";
        return html(await renderReviewPage(env, { limit, status, tokenConfigured: Boolean(env.REVIEW_TOKEN) }));
      }

      if (request.method === "POST" && url.pathname === "/approve") {
        await requireReviewToken(request, env);
        const payload = await request.json();
        return json(await approveReviewArticles(env, payload));
      }

      if (request.method === "POST" && url.pathname === "/reject") {
        await requireReviewToken(request, env);
        const payload = await request.json();
        return json(await rejectReviewArticles(env, payload));
      }

      if (request.method === "GET" && url.pathname === "/sources") {
        return json(await listSources(env));
      }

      if (request.method === "GET" && url.pathname === "/entities") {
        return json(await listEntities(env, url.searchParams.get("q")));
      }

      if (request.method === "GET" && url.pathname === "/matches") {
        const limit = readPositiveInt(url.searchParams.get("limit"), "50", 50);
        return json(await listRecentMatches(env, limit));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json(
        { error: error?.status === 401 ? "Unauthorized" : "Internal error", detail: String(error?.message || error) },
        error?.status || 500
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scrapeAllSources(env, {
      limit: readPositiveInt(null, env.MAX_FEED_ITEMS_PER_SOURCE, DEFAULT_LIMIT)
    }));
  }
};

export async function scrapeAllSources(env, options = {}) {
  const startedAt = new Date().toISOString();
  const run = await env.DB.prepare("INSERT INTO scrape_runs (started_at) VALUES (?)")
    .bind(startedAt)
    .run();

  const runId = run.meta.last_row_id;
  const errors = [];
  let sourcesChecked = 0;
  let articlesSeen = 0;
  let articlesQueued = 0;
  let mentionsQueued = 0;

  const [sources, entities] = await Promise.all([
    listSources(env),
    loadTrackedEntities(env)
  ]);

  for (const source of sources) {
    sourcesChecked += 1;
    try {
      const sourceResult = await scrapeSource(env, source, entities, options);
      articlesSeen += sourceResult.articlesSeen;
      articlesQueued += sourceResult.articlesQueued;
      mentionsQueued += sourceResult.mentionsQueued;

      await env.DB.prepare(
        "UPDATE rss_sources SET last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), new Date().toISOString(), source.id).run();
    } catch (error) {
      const detail = { source: source.name, feed_url: source.feed_url, error: String(error?.message || error) };
      errors.push(detail);
      await env.DB.prepare(
        "UPDATE rss_sources SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), detail.error, new Date().toISOString(), source.id).run();
    }
  }

  await env.DB.prepare(
    `UPDATE scrape_runs
     SET finished_at = ?, sources_checked = ?, articles_seen = ?, articles_saved = ?, mentions_saved = ?, errors_json = ?
     WHERE id = ?`
  ).bind(
    new Date().toISOString(),
    sourcesChecked,
    articlesSeen,
    articlesQueued,
    mentionsQueued,
    JSON.stringify(errors),
    runId
  ).run();

  return { runId, sourcesChecked, articlesSeen, articlesQueued, mentionsQueued, errors };
}

async function scrapeSource(env, source, entities, options) {
  const timeoutMs = readPositiveInt(null, env.REQUEST_TIMEOUT_MS, 12000);
  const feedText = await fetchText(source.feed_url, timeoutMs);
  const items = parseFeed(feedText, source.feed_url).slice(0, options.limit || DEFAULT_LIMIT);

  let articlesQueued = 0;
  let mentionsQueued = 0;

  for (const item of items) {
    if (!item.url || !item.title) continue;

    let searchableText = compactText([
      item.title,
      item.summary,
      item.content
    ].join(" "));

    if (source.fetch_article_pages) {
      const articleText = await safeFetchArticleText(item.url, timeoutMs);
      if (articleText && articleText.length > searchableText.length) {
        searchableText = compactText(`${searchableText} ${articleText}`);
      }
    }

    const matches = findEntityMatches(searchableText, entities, {
      minConfidence: Number(env.MIN_MATCH_CONFIDENCE || 0.72)
    });

    if (matches.length === 0) continue;

    const reviewId = await upsertReviewArticle(env, source, item);
    articlesQueued += 1;
    mentionsQueued += await saveReviewMatches(env, reviewId, matches);
  }

  return { articlesSeen: items.length, articlesQueued, mentionsQueued };
}

async function upsertReviewArticle(env, source, item) {
  const now = new Date().toISOString();
  const reviewId = await reviewIdForUrl(item.url);
  const hash = await sha256Hex(compactText([item.title, item.summary, item.content].join(" ")));
  await env.DB.prepare(
    `INSERT INTO rss_review_articles
       (review_id, source_id, url, title, summary, author, published_at, feed_url, content_hash, raw_feed_item_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       source_id = excluded.source_id,
       title = excluded.title,
       summary = excluded.summary,
       author = excluded.author,
       published_at = excluded.published_at,
       feed_url = excluded.feed_url,
       content_hash = excluded.content_hash,
       raw_feed_item_json = excluded.raw_feed_item_json,
       updated_at = excluded.updated_at`
  ).bind(
    reviewId,
    source.id,
    item.url,
    item.title,
    item.summary || null,
    item.author || null,
    item.publishedAt || null,
    source.feed_url,
    hash,
    JSON.stringify(item),
    now
  ).run();

  const row = await env.DB.prepare("SELECT review_id FROM rss_review_articles WHERE url = ?")
    .bind(item.url)
    .first();
  return row.review_id;
}

async function saveReviewMatches(env, reviewId, matches) {
  let saved = 0;
  const statements = matches.map((match) => env.DB.prepare(
    `INSERT OR REPLACE INTO rss_review_mentions
       (review_id, entity_source_id, entity_type, display_name, matched_text, confidence, context, entity_payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reviewId,
    match.entity.id,
    match.entity.entity_type,
    match.entity.display_name,
    match.matchedText,
    match.confidence,
    match.context,
    JSON.stringify(reviewEntityPayload(match.entity))
  ));

  if (statements.length === 0) return 0;
  const results = await env.DB.batch(statements);
  for (const result of results) {
    saved += result.meta?.changes || 0;
  }
  return saved;
}

async function upsertApprovedArticle(env, article, articleId) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO d1_articles
       (article_id, title, resource_type, publisher, url, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       title = excluded.title,
       resource_type = excluded.resource_type,
       publisher = excluded.publisher,
       url = excluded.url,
       summary = excluded.summary,
       updated_at = excluded.updated_at`
  ).bind(
    articleId,
    article.title,
    "rss",
    article.source_name || "RSS",
    article.url,
    article.summary || null,
    now,
    now
  ).run();

  await env.DB.prepare(
    `INSERT INTO rss_article_metadata
       (article_id, source_id, feed_url, author, published_at, content_hash, raw_feed_item_json, fetched_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       source_id = excluded.source_id,
       feed_url = excluded.feed_url,
       author = excluded.author,
       published_at = excluded.published_at,
       content_hash = excluded.content_hash,
       raw_feed_item_json = excluded.raw_feed_item_json,
       last_seen_at = excluded.last_seen_at`
  ).bind(
    articleId,
    article.source_id || null,
    article.feed_url || null,
    article.author || null,
    article.published_at || null,
    article.content_hash,
    article.raw_feed_item_json || null,
    now,
    now
  ).run();
}

async function saveApprovedMatches(env, articleId, mentions) {
  const statements = [];

  for (const mention of mentions) {
    const entity = parseJsonObject(mention.entity_payload_json);
    statements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO rss_article_mentions
         (article_id, entity_source_id, entity_type, display_name, matched_text, confidence, context)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      articleId,
      mention.entity_source_id,
      mention.entity_type,
      mention.display_name,
      mention.matched_text,
      mention.confidence,
      mention.context
    ));

    if (mention.entity_type === "bill") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_bills
           (article_id, sessionyear, condensedbillno, legislationid, bill_label_raw)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        articleId,
        entity.sessionyear || null,
        entity.condensedbillno,
        entity.legislationid || null,
        mention.matched_text
      ));
    }

    if (mention.entity_type === "legislator") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_legislators
           (article_id, personid, employeeno, legislator_name_raw)
         VALUES (?, ?, ?, ?)`
      ).bind(
        articleId,
        entity.personid || null,
        entity.employeeno || null,
        mention.matched_text
      ));
    }

    if (mention.entity_type === "candidate") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_candidates
           (article_id, filer_entity_number, candidate_name_raw)
         VALUES (?, ?, ?)`
      ).bind(
        articleId,
        entity.filer_entity_number,
        mention.matched_text
      ));
    }
  }

  if (statements.length === 0) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
}

async function listSources(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, feed_url, site_url, enabled, fetch_article_pages, last_checked_at, last_error
     FROM rss_sources
     WHERE enabled = 1
     ORDER BY name`
  ).all();
  return results || [];
}

async function listEntities(env, query) {
  const entities = await loadTrackedEntities(env);
  if (!query) return entities.slice(0, 250).map(publicEntity);

  const needle = compactText(query).toLowerCase();
  return entities
    .filter((entity) => [
      entity.display_name,
      entity.id,
      entity.chamber,
      entity.district,
      ...entity.terms
    ].some((value) => String(value || "").toLowerCase().includes(needle)))
    .slice(0, 100)
    .map(publicEntity);
}

async function listRecentMatches(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT created_at, entity_type, display_name, canonical_key, matched_text, confidence, context, title, url, published_at, source_name
     FROM recent_entity_mentions
     LIMIT ?`
  ).bind(limit).all();
  return results || [];
}

async function listReviewArticles(env, options = {}) {
  const status = options.status || "pending";
  const limit = options.limit || 100;
  const { results } = await env.DB.prepare(
    `SELECT
       r.review_id, r.status, r.title, r.url, r.summary, r.author, r.published_at,
       r.created_at, r.updated_at, r.approved_article_id, r.notes,
       s.name AS source_name,
       GROUP_CONCAT(m.entity_type || ':' || m.display_name || ' (' || ROUND(m.confidence, 2) || ')', '; ') AS matches
     FROM rss_review_articles r
     LEFT JOIN rss_sources s ON s.id = r.source_id
     LEFT JOIN rss_review_mentions m ON m.review_id = r.review_id
     WHERE r.status = ?
     GROUP BY r.review_id
     ORDER BY COALESCE(r.published_at, r.created_at) DESC
     LIMIT ?`
  ).bind(status, limit).all();
  return results || [];
}

async function listReviewArticlesDetailed(env, options = {}) {
  const articles = await listReviewArticles(env, options);
  const detailed = [];
  for (const article of articles) {
    detailed.push({
      ...article,
      mentions: await loadReviewMentions(env, article.review_id)
    });
  }
  return detailed;
}

async function renderReviewPage(env, options = {}) {
  const articles = await listReviewArticlesDetailed(env, options);
  const status = options.status || "pending";
  const tokenHelp = `<label class="token">Review token <input id="review-token" type="password" autocomplete="off" placeholder="x-review-token"></label>`;
  const tokenWarning = options.tokenConfigured
    ? ""
    : `<div class="warning">Approval is disabled until the Worker secret <code>REVIEW_TOKEN</code> is configured.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Legislative RSS Review</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --text: #182026;
      --muted: #62717d;
      --line: #d9e0e5;
      --accent: #126b5b;
      --danger: #a23a2f;
      --soft: #eef5f3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: rgba(255,255,255,.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 22px auto 48px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .toolbar a, button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 8px 12px;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .toolbar a[aria-current="page"] {
      background: var(--soft);
      border-color: #9fc7bc;
      color: var(--accent);
      font-weight: 650;
    }
    .token {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .token input {
      width: 180px;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
    }
    .count {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 14px;
    }
    .warning {
      margin: 0 0 14px;
      border: 1px solid #e2c36f;
      background: #fff7dc;
      color: #614c00;
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 14px;
    }
    .article {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 14px;
      padding: 18px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
    }
    .meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 19px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    h2 a {
      color: var(--text);
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    p {
      margin: 0 0 12px;
      color: #33424d;
      line-height: 1.45;
    }
    .matches {
      display: grid;
      gap: 8px;
      margin: 14px 0;
    }
    .match {
      border-left: 3px solid #9fc7bc;
      background: #f8fbfa;
      padding: 9px 10px;
      border-radius: 0 6px 6px 0;
    }
    .match strong {
      display: inline-block;
      margin-right: 8px;
    }
    .match small {
      color: var(--muted);
    }
    .context {
      margin-top: 4px;
      color: #42515d;
      font-size: 13px;
      line-height: 1.4;
    }
    .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-end;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .approve {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .reject {
      background: white;
      border-color: #d7a8a2;
      color: var(--danger);
    }
    .empty {
      padding: 48px 20px;
      text-align: center;
      background: white;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
    }
    @media (max-width: 720px) {
      header { align-items: flex-start; flex-direction: column; padding: 14px 16px; }
      main { width: min(100vw - 20px, 1180px); margin-top: 14px; }
      .actions { justify-content: stretch; }
      .actions button { flex: 1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Legislative RSS Review</h1>
    <div class="toolbar">
      <a href="/review-ui?status=pending" aria-current="${status === "pending" ? "page" : "false"}">Pending</a>
      <a href="/review-ui?status=approved" aria-current="${status === "approved" ? "page" : "false"}">Approved</a>
      <a href="/review-ui?status=rejected" aria-current="${status === "rejected" ? "page" : "false"}">Rejected</a>
      ${tokenHelp}
    </div>
  </header>
  <main>
    ${tokenWarning}
    <p class="count">${articles.length} ${escapeHtml(status)} article${articles.length === 1 ? "" : "s"}</p>
    ${articles.length ? articles.map(renderReviewCard).join("") : `<div class="empty">No ${escapeHtml(status)} articles.</div>`}
  </main>
  <script>
    async function decide(reviewId, action, button) {
      const card = button.closest(".article");
      const notes = action === "reject" ? prompt("Optional rejection note", "") : "";
      button.disabled = true;
      const headers = { "content-type": "application/json" };
      const tokenInput = document.querySelector("#review-token");
      if (tokenInput && tokenInput.value) headers["x-review-token"] = tokenInput.value;
      const response = await fetch("/" + action, {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewId, approvedBy: "review-ui", notes })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || (result.errors && result.errors.length)) {
        alert((result.detail || result.error || JSON.stringify(result.errors || result)) || "Action failed");
        button.disabled = false;
        return;
      }
      card.remove();
      const count = document.querySelector(".count");
      const remaining = document.querySelectorAll(".article").length;
      count.textContent = remaining + " pending article" + (remaining === 1 ? "" : "s");
    }
  </script>
</body>
</html>`;
}

function renderReviewCard(article) {
  const matches = article.mentions.length
    ? article.mentions.map(renderReviewMention).join("")
    : `<div class="match">No matches recorded.</div>`;
  return `<article class="article" data-review-id="${escapeHtml(article.review_id)}">
    <div class="meta">
      <span>${escapeHtml(article.source_name || "RSS")}</span>
      <span>${escapeHtml(article.published_at || article.created_at || "")}</span>
      <span>${escapeHtml(article.review_id)}</span>
    </div>
    <h2><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a></h2>
    <p>${escapeHtml(article.summary || "")}</p>
    <div class="matches">${matches}</div>
    ${article.status === "pending" ? `<div class="actions">
      <button class="reject" type="button" onclick="decide('${escapeJs(article.review_id)}', 'reject', this)">Deny</button>
      <button class="approve" type="button" onclick="decide('${escapeJs(article.review_id)}', 'approve', this)">Approve</button>
    </div>` : ""}
  </article>`;
}

function renderReviewMention(mention) {
  return `<div class="match">
    <strong>${escapeHtml(mention.display_name)}</strong>
    <small>${escapeHtml(mention.entity_type)} / ${escapeHtml(mention.matched_text)} / ${Number(mention.confidence || 0).toFixed(2)}</small>
    <div class="context">${escapeHtml(mention.context || "")}</div>
  </div>`;
}

async function approveReviewArticles(env, payload) {
  const reviewIds = normalizeReviewIds(payload);
  const approvedBy = compactText(payload?.approvedBy || payload?.approved_by || "reviewer");
  const notes = compactText(payload?.notes || "");
  const approved = [];
  const errors = [];

  for (const reviewId of reviewIds) {
    try {
      const article = await loadReviewArticle(env, reviewId);
      if (!article) {
        errors.push({ reviewId, error: "Review article not found" });
        continue;
      }
      if (article.status !== "pending") {
        errors.push({ reviewId, error: `Review article is ${article.status}` });
        continue;
      }

      const mentions = await loadReviewMentions(env, reviewId);
      const articleId = await articleIdForUrl(article.url);
      await upsertApprovedArticle(env, article, articleId);
      const mentionsSaved = await saveApprovedMatches(env, articleId, mentions);

      await env.DB.prepare(
        `UPDATE rss_review_articles
         SET status = 'approved', approved_article_id = ?, approved_by = ?, notes = ?, approved_at = ?, updated_at = ?
         WHERE review_id = ?`
      ).bind(articleId, approvedBy, notes || article.notes || null, new Date().toISOString(), new Date().toISOString(), reviewId).run();

      approved.push({ reviewId, articleId, mentionsSaved });
    } catch (error) {
      errors.push({ reviewId, error: String(error?.message || error) });
    }
  }

  return { approved, errors };
}

async function rejectReviewArticles(env, payload) {
  const reviewIds = normalizeReviewIds(payload);
  const notes = compactText(payload?.notes || "");
  const rejectedAt = new Date().toISOString();
  const statements = reviewIds.map((reviewId) => env.DB.prepare(
    `UPDATE rss_review_articles
     SET status = 'rejected', notes = ?, rejected_at = ?, updated_at = ?
     WHERE review_id = ? AND status = 'pending'`
  ).bind(notes || null, rejectedAt, rejectedAt, reviewId));

  if (statements.length === 0) return { rejected: 0 };
  const results = await env.DB.batch(statements);
  return { rejected: results.reduce((total, result) => total + (result.meta?.changes || 0), 0) };
}

async function loadReviewArticle(env, reviewId) {
  return await env.DB.prepare(
    `SELECT r.*, s.name AS source_name
     FROM rss_review_articles r
     LEFT JOIN rss_sources s ON s.id = r.source_id
     WHERE r.review_id = ?`
  ).bind(reviewId).first();
}

async function loadReviewMentions(env, reviewId) {
  const { results } = await env.DB.prepare(
    `SELECT review_id, entity_source_id, entity_type, display_name, matched_text, confidence, context, entity_payload_json
     FROM rss_review_mentions
     WHERE review_id = ?
     ORDER BY confidence DESC`
  ).bind(reviewId).all();
  return results || [];
}

async function loadTrackedEntities(env) {
  const [legislators, candidates, bills] = await Promise.all([
    loadLegislators(env),
    loadCandidates(env),
    loadBills(env)
  ]);
  return [...legislators, ...candidates, ...bills].filter((entity) => entity.terms.length > 0);
}

async function loadLegislators(env) {
  const { results } = await env.DB.prepare(
    `SELECT personid, employeeno, firstname, middlename, lastname, legislativebody, active, district, party, slug
     FROM d1_legislators
     WHERE active = 1
     ORDER BY lastname, firstname`
  ).all();

  return (results || []).map((row) => {
    const displayName = compactText([row.firstname, row.middlename, row.lastname].join(" "));
    const chamber = compactText(row.legislativebody);
    const title = chamber.toLowerCase().includes("sen") ? "Sen." : "Rep.";
    return buildEntity({
      id: String(row.personid),
      entity_type: "legislator",
      display_name: displayName,
      canonical_key: row.slug || String(row.personid),
      chamber,
      district: row.district,
      personid: row.personid,
      employeeno: row.employeeno,
      aliases: [
        `${title} ${displayName}`,
        `${title} ${row.lastname}`,
        chamber.toLowerCase().includes("sen") ? `Senator ${row.lastname}` : `Representative ${row.lastname}`
      ]
    });
  });
}

async function loadCandidates(env) {
  const { results } = await env.DB.prepare(
    `SELECT filer_entity_number, candidate_first_name, candidate_last_name, office_type, office, county, district, political_party, election_year, slug
     FROM candidates
     ORDER BY election_year DESC, candidate_last_name, candidate_first_name`
  ).all();

  return (results || []).map((row) => {
    const displayName = compactText([row.candidate_first_name, row.candidate_last_name].join(" "));
    return buildEntity({
      id: String(row.filer_entity_number),
      entity_type: "candidate",
      display_name: displayName,
      canonical_key: row.slug || String(row.filer_entity_number),
      chamber: row.office_type || row.office,
      district: row.district,
      filer_entity_number: row.filer_entity_number,
      aliases: [
        `${row.candidate_last_name} for ${row.office || row.office_type || "office"}`,
        `${displayName} for ${row.office || row.office_type || "office"}`
      ]
    });
  });
}

async function loadBills(env) {
  const { results } = await env.DB.prepare(
    `SELECT sessionyear, legislationid, condensedbillno, expandedbillno, legislativebody, description
     FROM d1_bills
     ORDER BY sessionyear DESC, condensedbillno`
  ).all();

  return (results || []).map((row) => {
    const billNumber = compactText(row.expandedbillno || row.condensedbillno);
    const description = compactText(row.description);
    return buildEntity({
      id: `${row.sessionyear}:${row.legislationid}`,
      entity_type: "bill",
      display_name: description ? `${billNumber}: ${description}` : billNumber,
      canonical_key: `${row.sessionyear}:${row.condensedbillno}`,
      chamber: row.legislativebody,
      sessionyear: row.sessionyear,
      legislationid: row.legislationid,
      condensedbillno: row.condensedbillno,
      expandedbillno: row.expandedbillno,
      aliases: [
        row.condensedbillno,
        row.expandedbillno,
        ...billNumberVariants(row.condensedbillno),
        description.length >= 8 && description.length <= 140 ? description : ""
      ]
    });
  });
}

function buildEntity(entity) {
  const terms = new Set();
  terms.add(entity.display_name);
  if (entity.canonical_key && entity.entity_type === "bill") terms.add(entity.canonical_key);
  for (const alias of entity.aliases || []) terms.add(alias);
  return {
    ...entity,
    terms: [...terms].map((term) => compactText(term)).filter((term) => term.length >= 3)
  };
}

function publicEntity(entity) {
  return {
    id: entity.id,
    entity_type: entity.entity_type,
    display_name: entity.display_name,
    canonical_key: entity.canonical_key,
    chamber: entity.chamber,
    district: entity.district,
    terms: entity.terms
  };
}

function reviewEntityPayload(entity) {
  return {
    id: entity.id,
    entity_type: entity.entity_type,
    display_name: entity.display_name,
    personid: entity.personid,
    employeeno: entity.employeeno,
    filer_entity_number: entity.filer_entity_number,
    sessionyear: entity.sessionyear,
    legislationid: entity.legislationid,
    condensedbillno: entity.condensedbillno,
    expandedbillno: entity.expandedbillno
  };
}

function billNumberVariants(value) {
  const bill = compactText(value).toUpperCase();
  const match = /^([A-Z]+)\s*0*([0-9]+)(.*)$/.exec(bill);
  if (!match) return [];
  const [, prefix, number, suffix] = match;
  return [
    `${prefix} ${number}${suffix}`,
    `${prefix}${number}${suffix}`,
    `${prefix}. ${number}${suffix}`
  ];
}

export function findEntityMatches(text, entities, options = {}) {
  const normalized = compactText(text);
  const matchesByEntity = new Map();

  for (const entity of entities) {
    for (const term of entity.terms) {
      const found = findWholePhrase(normalized, term);
      if (!found) continue;

      const confidence = scoreMatch(entity, term, found.context);
      if (confidence < (options.minConfidence || 0)) continue;

      const match = {
        entity,
        matchedText: term,
        confidence,
        context: found.context
      };
      const entityKey = `${entity.entity_type}:${entity.id}`;
      const previous = matchesByEntity.get(entityKey);
      if (!previous || match.confidence > previous.confidence) {
        matchesByEntity.set(entityKey, match);
      }
    }
  }

  return [...matchesByEntity.values()].sort((a, b) => b.confidence - a.confidence);
}

function scoreMatch(entity, term, context) {
  let score = 0.72;
  if (term === compactText(entity.display_name)) score += 0.12;
  if (entity.entity_type === "bill" && /\b(h\.?\s*r\.?|s\.|sb|hb|act|bill|resolution)\b/i.test(context)) score += 0.1;
  if (entity.entity_type !== "bill" && /\b(rep\.?|representative|sen\.?|senator|gov\.?|governor|mayor|candidate)\b/i.test(context)) score += 0.08;
  if (term.split(/\s+/).length >= 2) score += 0.04;
  return Math.min(score, 0.98);
}

function findWholePhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, "i");
  const match = pattern.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - 160);
  const end = Math.min(text.length, match.index + match[0].length + 160);
  return { context: text.slice(start, end).trim() };
}

export function parseFeed(xml, feedUrl) {
  const itemBlocks = matchBlocks(xml, "item");
  if (itemBlocks.length > 0) return itemBlocks.map((block) => parseRssItem(block, feedUrl));

  return matchBlocks(xml, "entry").map((block) => parseAtomEntry(block, feedUrl));
}

function parseRssItem(block, feedUrl) {
  return {
    title: decodeEntities(stripTags(readTag(block, "title"))),
    url: normalizeUrl(decodeEntities(readTag(block, "link") || readTag(block, "guid")), feedUrl),
    summary: decodeEntities(stripTags(readTag(block, "description"))),
    content: decodeEntities(stripTags(readNamespacedTag(block, "content", "encoded"))),
    author: decodeEntities(stripTags(readTag(block, "author") || readNamespacedTag(block, "dc", "creator"))),
    publishedAt: normalizeDate(readTag(block, "pubDate") || readTag(block, "published"))
  };
}

function parseAtomEntry(block, feedUrl) {
  return {
    title: decodeEntities(stripTags(readTag(block, "title"))),
    url: normalizeUrl(readAtomLink(block) || readTag(block, "id"), feedUrl),
    summary: decodeEntities(stripTags(readTag(block, "summary"))),
    content: decodeEntities(stripTags(readTag(block, "content"))),
    author: decodeEntities(stripTags(readTag(matchBlocks(block, "author")[0] || "", "name"))),
    publishedAt: normalizeDate(readTag(block, "published") || readTag(block, "updated"))
  };
}

function matchBlocks(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function readTag(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = pattern.exec(xml);
  return match ? unwrapCdata(match[1]).trim() : "";
}

function readNamespacedTag(xml, namespace, tagName) {
  const pattern = new RegExp(`<${namespace}:${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${namespace}:${tagName}>`, "i");
  const match = pattern.exec(xml);
  return match ? unwrapCdata(match[1]).trim() : "";
}

function readAtomLink(block) {
  const alternate = /<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i.exec(block);
  if (alternate) return alternate[1];
  const any = /<link\b(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i.exec(block);
  return any ? any[1] : "";
}

async function safeFetchArticleText(url, timeoutMs) {
  try {
    const html = await fetchText(url, timeoutMs, "text/html,application/xhtml+xml");
    return extractReadableText(html);
  } catch {
    return "";
  }
}

async function fetchText(url, timeoutMs, accept = "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": accept,
        "User-Agent": "LegislativeRSSScraper/0.1 (+https://workers.cloudflare.com/)"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractReadableText(html) {
  return compactText(stripTags(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
  ));
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function unwrapCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value, baseUrl) {
  const cleaned = compactText(value);
  if (!cleaned) return "";
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return cleaned;
  }
}

function normalizeDate(value) {
  const date = new Date(decodeEntities(stripTags(value)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeReviewIds(payload) {
  if (Array.isArray(payload?.reviewIds)) return payload.reviewIds.map(compactText).filter(Boolean);
  if (Array.isArray(payload?.review_ids)) return payload.review_ids.map(compactText).filter(Boolean);
  if (payload?.reviewId) return [compactText(payload.reviewId)].filter(Boolean);
  if (payload?.review_id) return [compactText(payload.review_id)].filter(Boolean);
  return [];
}

function readPositiveInt(primary, fallback, defaultValue) {
  const value = Number(primary || fallback || defaultValue);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function articleIdForUrl(url) {
  return `rss_${(await sha256Hex(url)).slice(0, 24)}`;
}

async function reviewIdForUrl(url) {
  return `review_${(await sha256Hex(url)).slice(0, 24)}`;
}

async function requireReviewToken(request, env) {
  if (!env.REVIEW_TOKEN) {
    const error = new Error("REVIEW_TOKEN is not configured");
    error.status = 503;
    throw error;
  }
  const provided = request.headers.get("x-review-token") || "";
  if (provided !== env.REVIEW_TOKEN) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJs(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
