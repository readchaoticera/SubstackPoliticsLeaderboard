#!/usr/bin/env node
/**
 * Fetches the top publications for the configured Substack leaderboard
 * categories and writes them to /data/<slug>.json.
 *
 * Substack exposes an undocumented (but public) leaderboard API:
 *
 *   GET https://substack.com/api/v1/categories
 *       -> [{ id, name, slug? }, ...]
 *
 *   GET https://substack.com/api/v1/category/public/<categoryId>/all?page=<n>
 *       -> { publications: [...], more: <bool> }   (25 publications / page)
 *
 * IMPORTANT — data availability:
 *   Substack does NOT publish exact paid-subscriber counts. The only paid
 *   signal is the Bestseller badge tier. Per Substack's own docs the tiers map
 *   to paid-subscriber milestones:
 *       tier 1 (white)  -> 100+   paid
 *       tier 2 (orange) -> 1,000+ paid
 *       tier 3 (purple) -> 10,000+ paid ("tens of thousands")
 *   We surface that as an ESTIMATE (a lower bound), clearly labelled as such.
 *   Free-subscriber counts from the API are themselves approximate ("rough").
 *
 * Usage:
 *   node scripts/fetch-leaderboard.mjs            # fetch all configured categories
 *   node scripts/fetch-leaderboard.mjs us-politics
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");

const API_BASE = "https://substack.com/api/v1";
const PAGE_SIZE = 25;
const DEFAULT_LIMIT = 250; // top N per category; override with --limit N (or --limit all)
const MAX_PAGES = 1000; // hard safety stop (~25k publications)
// A real-browser User-Agent improves the odds Substack serves the request.
// Substack blocks datacenter/cloud IPs outright, so run this from a normal
// residential/office connection.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://substack.com/",
  Origin: "https://substack.com",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

// Which leaderboards to build. `name` is matched (case-insensitively) against
// the names returned by /api/v1/categories so we don't hard-code volatile IDs.
const CATEGORIES = [
  { slug: "us-politics", label: "U.S. Politics", match: ["u.s. politics", "us politics"] },
  { slug: "news", label: "News", match: ["news"] },
];

// Parse a loose integer like "2,900,000" or "Over 2,900,000 subscribers".
function parseLooseInt(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const digits = v.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

// Short label for an order-of-magnitude estimate (100000 -> "100K+").
function magnitudeLabel(n) {
  if (!n || n < 1) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M+`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K+`;
  return `${n}+`;
}

// Substack Bestseller badge threshold (100 / 1,000 / 10,000) -> colour bucket.
function badgeColorTier(n) {
  if (n >= 10000) return 3;
  if (n >= 1000) return 2;
  if (n >= 100) return 1;
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, attempt = 0) {
  const MAX_RETRIES = 3;
  let res;
  try {
    res = await fetch(url, { headers: BROWSER_HEADERS });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      return getJSON(url, attempt + 1);
    }
    throw err;
  }
  // Retry transient blocks/rate limits with exponential backoff.
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleep(1000 * 2 ** attempt);
    return getJSON(url, attempt + 1);
  }
  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (Substack is blocking this request — run from a residential/office connection, not a cloud server or VPN.)"
        : "";
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}${hint}`);
  }
  return res.json();
}

/** Try several common field names, returning the first defined value. */
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

async function resolveCategoryId(match) {
  const cats = await getJSON(`${API_BASE}/categories`);
  const list = Array.isArray(cats) ? cats : cats.categories || [];
  const wanted = match.map((m) => m.toLowerCase());
  const hit = list.find((c) => {
    const name = String(c.name || c.label || "").toLowerCase();
    return wanted.includes(name);
  });
  if (!hit) {
    const available = list.map((c) => c.name).join(", ");
    throw new Error(
      `Could not find a category matching ${JSON.stringify(match)}. ` +
        `Available: ${available}`
    );
  }
  return hit.id ?? hit.categoryId;
}

function normalizeUrl(pub) {
  // Prefer a custom domain, then the substack subdomain, then the profile URL.
  const custom = pick(pub, ["customDomain", "custom_domain"]);
  if (custom) return custom.startsWith("http") ? custom : `https://${custom}`;
  const base = pick(pub, ["baseUrl", "base_url", "subdomainUrl"]);
  if (base) return base.startsWith("http") ? base : `https://${base}`;
  const sub = pick(pub, ["subdomain"]);
  if (sub) return `https://${sub}.substack.com`;
  const profile = pick(pub, ["profileUrl", "profile_url", "canonicalUrl"]);
  if (profile) return profile.startsWith("http") ? profile : `https://substack.com${profile}`;
  return "";
}

function normalizePublication(pub, fallbackRank) {
  // Bestseller badge threshold (100 / 1,000 / 10,000) drives the pill colour.
  const badgeThreshold = parseLooseInt(
    pick(pub, ["author_bestseller_tier", "author_badge.tier", "contributors.0.status.bestsellerTier"], 0)
  );
  const colorTier = badgeColorTier(badgeThreshold);

  // Paid-subscriber estimate: prefer Substack's published "ranking detail"
  // order of magnitude (e.g. 100000 = "Hundreds of thousands of paid
  // subscribers"); fall back to the Bestseller badge threshold.
  const paidEstimate =
    parseLooseInt(pick(pub, ["rankingDetailOrderOfMagnitude"], 0)) || badgeThreshold || 0;
  const paidDetail = pick(pub, ["rankingDetail"], "");
  const paidBadge = paidEstimate > 0 ? magnitudeLabel(paidEstimate) : "—";

  // Free/total subscriber count (Substack reports a rounded figure).
  const freeSubscribers = parseLooseInt(
    pick(pub, ["freeSubscriberCount", "rankingDetailFreeSubscriberCount", "rough_num_free_subscribers"], 0)
  );

  return {
    rank: parseLooseInt(pick(pub, ["rank", "leaderboardStatus.rank"], fallbackRank)) || fallbackRank,
    author: pick(pub, ["author_name", "authorName", "primary_profile_name", "author"], "Unknown"),
    publicationName: pick(pub, ["name", "publicationName", "publication_name", "title"], "Untitled"),
    url: normalizeUrl(pub),
    freeSubscribers,
    bestsellerTier: colorTier,
    paidBadge,
    paidDetail,
    paidEstimate,
  };
}

async function fetchCategory({ slug, label, match }, limit = DEFAULT_LIMIT) {
  const goal = Number.isFinite(limit) ? String(limit) : "all";
  process.stdout.write(`\n→ ${label} (${slug}) — target: ${goal}\n`);
  const categoryId = await resolveCategoryId(match);
  process.stdout.write(`   category id: ${categoryId}\n`);

  const collected = [];
  const seen = new Set();
  let page = 0;
  while (collected.length < limit && page < MAX_PAGES) {
    const url = `${API_BASE}/category/public/${categoryId}/all?page=${page}`;
    const data = await getJSON(url);
    const pubs = Array.isArray(data) ? data : data.publications || [];
    if (pubs.length === 0) break;
    for (const pub of pubs) {
      const norm = normalizePublication(pub, collected.length + 1);
      const key = norm.url || norm.publicationName;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(norm);
      if (collected.length >= limit) break;
    }
    process.stdout.write(`   page ${page}: ${collected.length}/${goal}\n`);
    const more = Array.isArray(data) ? pubs.length === PAGE_SIZE : data.more;
    if (!more) {
      process.stdout.write(`   (end of category reached)\n`);
      break;
    }
    page += 1;
  }

  // Re-rank sequentially in case the API ranks were sparse/missing.
  collected.forEach((p, i) => {
    if (!Number.isFinite(p.rank) || p.rank <= 0) p.rank = i + 1;
  });

  const out = {
    category: label,
    categorySlug: slug,
    leaderboardUrl: `https://substack.com/leaderboard/${slug}`,
    generatedAt: new Date().toISOString(),
    source: "live",
    count: collected.length,
    notes: {
      paidSubscribers:
        "Estimated order-of-magnitude from Substack's published ranking detail " +
        "(e.g. 'Hundreds of thousands of paid subscribers'); pill colour follows " +
        "the Bestseller badge tier. Substack does not publish exact paid counts.",
      freeSubscribers: "Rounded free/total subscriber count reported by Substack.",
    },
    publications: collected,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const file = resolve(DATA_DIR, `${slug}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(`   ✓ wrote ${collected.length} publications -> data/${slug}.json\n`);
}

function parseArgs(argv) {
  let limit = DEFAULT_LIMIT;
  const slugs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--limit=") ? a.slice(8) : null;
    if (a === "--limit" || a === "-l") {
      const v = argv[++i];
      limit = /^all$/i.test(v) ? Infinity : Math.max(1, parseInt(v, 10) || DEFAULT_LIMIT);
    } else if (eq !== null) {
      limit = /^all$/i.test(eq) ? Infinity : Math.max(1, parseInt(eq, 10) || DEFAULT_LIMIT);
    } else if (!a.startsWith("-")) {
      slugs.push(a);
    }
  }
  return { limit, slugs };
}

async function main() {
  const { limit, slugs } = parseArgs(process.argv.slice(2));
  const targets = slugs.length
    ? CATEGORIES.filter((c) => slugs.includes(c.slug))
    : CATEGORIES;

  if (targets.length === 0) {
    console.error(`No matching categories for: ${slugs.join(", ")}`);
    process.exit(1);
  }

  let failures = 0;
  for (const cat of targets) {
    try {
      await fetchCategory(cat, limit);
    } catch (err) {
      failures += 1;
      console.error(`   ✗ ${cat.slug}: ${err.message}`);
    }
  }
  if (failures > 0) process.exit(1);
}

// Only run when invoked directly (so the helpers can be imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { normalizePublication, normalizeUrl, parseLooseInt, magnitudeLabel, badgeColorTier, parseArgs };
