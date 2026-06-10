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
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");

const API_BASE = "https://substack.com/api/v1";
const PAGE_SIZE = 25;
const TARGET = 100; // top N publications per category
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

// Bestseller badge tier -> estimated paid subscribers (lower bound).
// Source: https://support.substack.com/hc/en-us/articles/10661509585428
const TIER_TO_PAID = {
  0: { estimate: 0, label: "—" },
  1: { estimate: 100, label: "100+" },
  2: { estimate: 1000, label: "1,000+" },
  3: { estimate: 10000, label: "10,000+" },
};

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
  const tierRaw = Number(
    pick(pub, ["bestsellerTier", "bestseller_tier", "leaderboardStatus.bestsellerTier"], 0)
  );
  const tier = Number.isFinite(tierRaw) ? Math.max(0, Math.min(3, tierRaw)) : 0;
  const paid = TIER_TO_PAID[tier] ?? TIER_TO_PAID[0];

  const free = Number(
    pick(
      pub,
      [
        "roughNumFreeSubscribers",
        "rough_num_free_subscribers",
        "subscriberCount",
        "subscriber_count",
        "followerCount",
        "follower_count",
      ],
      0
    )
  );

  return {
    rank: Number(
      pick(pub, ["rank", "leaderboardStatus.rank", "leaderboardStatus.ranking"], fallbackRank)
    ),
    author: pick(
      pub,
      ["authorName", "author_name", "author", "identityHandle", "name"],
      "Unknown"
    ),
    publicationName: pick(
      pub,
      ["publicationName", "publication_name", "leaderboardStatus.publicationName", "name", "title"],
      "Untitled"
    ),
    url: normalizeUrl(pub),
    freeSubscribers: Number.isFinite(free) ? free : 0,
    bestsellerTier: tier,
    paidBadge: paid.label,
    paidEstimate: paid.estimate,
  };
}

async function fetchCategory({ slug, label, match }) {
  process.stdout.write(`\n→ ${label} (${slug})\n`);
  const categoryId = await resolveCategoryId(match);
  process.stdout.write(`   category id: ${categoryId}\n`);

  const collected = [];
  const seen = new Set();
  let page = 0;
  while (collected.length < TARGET) {
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
      if (collected.length >= TARGET) break;
    }
    process.stdout.write(`   page ${page}: ${collected.length}/${TARGET}\n`);
    const more = Array.isArray(data) ? pubs.length === PAGE_SIZE : data.more;
    if (!more) break;
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
        "Estimated lower bound from the Substack Bestseller badge tier " +
        "(100+ / 1,000+ / 10,000+). Substack does not publish exact paid counts.",
      freeSubscribers: "Approximate free/total subscriber count reported by Substack.",
    },
    publications: collected,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const file = resolve(DATA_DIR, `${slug}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(`   ✓ wrote ${collected.length} publications -> data/${slug}.json\n`);
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length
    ? CATEGORIES.filter((c) => requested.includes(c.slug))
    : CATEGORIES;

  if (targets.length === 0) {
    console.error(`No matching categories for: ${requested.join(", ")}`);
    process.exit(1);
  }

  let failures = 0;
  for (const cat of targets) {
    try {
      await fetchCategory(cat);
    } catch (err) {
      failures += 1;
      console.error(`   ✗ ${cat.slug}: ${err.message}`);
    }
  }
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
