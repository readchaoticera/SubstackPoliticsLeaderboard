#!/usr/bin/env node
/**
 * Diagnostic helper: prints the RAW shape of one publication from Substack's
 * leaderboard API so we can map the correct field names for subscriber counts
 * and the Bestseller badge tier.
 *
 * Run from the project root (on a residential/office connection):
 *   node scripts/inspect-fields.mjs            # defaults to U.S. Politics
 *   node scripts/inspect-fields.mjs news
 *
 * Copy the entire output back to Claude.
 */

const API_BASE = "https://substack.com/api/v1";
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://substack.com/",
  Origin: "https://substack.com",
};

const MATCH = {
  "us-politics": ["u.s. politics", "us politics"],
  news: ["news"],
};

async function getJSON(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

const slug = process.argv[2] || "us-politics";
const wanted = (MATCH[slug] || [slug]).map((s) => s.toLowerCase());

const cats = await getJSON(`${API_BASE}/categories`);
const list = Array.isArray(cats) ? cats : cats.categories || [];
const cat = list.find((c) => wanted.includes(String(c.name || "").toLowerCase()));
if (!cat) {
  console.error(`No category match for "${slug}". Available:`, list.map((c) => c.name));
  process.exit(1);
}
const id = cat.id ?? cat.categoryId;
console.log(`Category "${cat.name}" -> id ${id}\n`);

const data = await getJSON(`${API_BASE}/category/public/${id}/all?page=0`);
const pubs = Array.isArray(data) ? data : data.publications || [];
console.log(`Top-level keys: ${Object.keys(data).join(", ")}`);
console.log(`Publications on page 0: ${pubs.length}\n`);
console.log("=== FIRST PUBLICATION (raw) ===");
console.log(JSON.stringify(pubs[0], null, 2));
