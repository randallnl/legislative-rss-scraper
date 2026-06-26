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
      return json({ error: "Internal error", detail: String(error?.message || error) }, 500);
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
  let articlesSaved = 0;
  let mentionsSaved = 0;

  const [sources, entities] = await Promise.all([
    listSources(env),
    loadTrackedEntities(env)
  ]);

  for (const source of sources) {
    sourcesChecked += 1;
    try {
      const sourceResult = await scrapeSource(env, source, entities, options);
      articlesSeen += sourceResult.articlesSeen;
      articlesSaved += sourceResult.articlesSaved;
      mentionsSaved += sourceResult.mentionsSaved;

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
    articlesSaved,
    mentionsSaved,
    JSON.stringify(errors),
    runId
  ).run();

  return { runId, sourcesChecked, articlesSeen, articlesSaved, mentionsSaved, errors };
}

async function scrapeSource(env, source, entities, options) {
  const timeoutMs = readPositiveInt(null, env.REQUEST_TIMEOUT_MS, 12000);
  const feedText = await fetchText(source.feed_url, timeoutMs);
  const items = parseFeed(feedText, source.feed_url).slice(0, options.limit || DEFAULT_LIMIT);

  let articlesSaved = 0;
  let mentionsSaved = 0;

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

    const articleId = await upsertArticle(env, source, item);
    articlesSaved += 1;
    mentionsSaved += await saveMatches(env, articleId, matches);
  }

  return { articlesSeen: items.length, articlesSaved, mentionsSaved };
}

async function upsertArticle(env, source, item) {
  const now = new Date().toISOString();
  const articleId = await articleIdForUrl(item.url);
  const hash = await sha256Hex(compactText([item.title, item.summary, item.content].join(" ")));
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
    item.title,
    "rss",
    source.name,
    item.url,
    item.summary || null,
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
    source.id,
    source.feed_url,
    item.author || null,
    item.publishedAt || null,
    hash,
    JSON.stringify(item),
    now,
    now
  ).run();

  return articleId;
}

async function saveMatches(env, articleId, matches) {
  let saved = 0;
  const statements = [];

  for (const match of matches) {
    statements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO rss_article_mentions
         (article_id, entity_source_id, entity_type, display_name, matched_text, confidence, context)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      articleId,
      match.entity.id,
      match.entity.entity_type,
      match.entity.display_name,
      match.matchedText,
      match.confidence,
      match.context
    ));

    if (match.entity.entity_type === "bill") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_bills
           (article_id, sessionyear, condensedbillno, legislationid, bill_label_raw)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        articleId,
        match.entity.sessionyear || null,
        match.entity.condensedbillno,
        match.entity.legislationid || null,
        match.matchedText
      ));
    }

    if (match.entity.entity_type === "legislator") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_legislators
           (article_id, personid, employeeno, legislator_name_raw)
         VALUES (?, ?, ?, ?)`
      ).bind(
        articleId,
        match.entity.personid || null,
        match.entity.employeeno || null,
        match.matchedText
      ));
    }

    if (match.entity.entity_type === "candidate") {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO d1_article_candidates
           (article_id, filer_entity_number, candidate_name_raw)
         VALUES (?, ?, ?)`
      ).bind(
        articleId,
        match.entity.filer_entity_number,
        match.matchedText
      ));
    }
  }

  if (statements.length === 0) return 0;
  const results = await env.DB.batch(statements);
  for (const result of results) {
    saved += result.meta?.changes || 0;
  }
  return saved;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
