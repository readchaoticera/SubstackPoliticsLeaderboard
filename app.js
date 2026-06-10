/* Chaotic Era — Substack Leaderboard front-end.
   Loads data/<category>.json, renders a sortable, filterable table. */
(() => {
  "use strict";

  const CATEGORIES = {
    "us-politics": "data/us-politics.json",
    news: "data/news.json",
  };

  // Subjective partisan-lean buckets (data/lean.json maps URL -> key).
  const LEAN_META = {
    left: { label: "Left", cls: "lean-left", full: "Left-leaning, Progressive, or Democrat" },
    right: { label: "Right", cls: "lean-right", full: "Right-leaning, Conservative, or Republican" },
    neutral: { label: "Neutral", cls: "lean-neutral", full: "Neutral or Nonpartisan" },
    unrated: { label: "Unrated", cls: "lean-unrated", full: "Not yet classified — suggestions welcome" },
  };

  const state = {
    category: "us-politics",
    data: {}, // slug -> parsed json
    leans: null, // normalized url -> lean key
    overrides: null, // normalized url -> manual data override
    sortKey: "rank",
    sortDir: 1, // 1 asc, -1 desc
    filter: "",
  };

  const els = {
    rows: document.getElementById("rows"),
    empty: document.getElementById("empty"),
    meta: document.getElementById("meta"),
    banner: document.getElementById("banner"),
    search: document.getElementById("search"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    headers: Array.from(document.querySelectorAll("th.sortable")),
  };

  const NF = new Intl.NumberFormat("en-US");

  function fmtInt(n) {
    return Number.isFinite(n) && n > 0 ? NF.format(n) : "—";
  }

  function paidBadgeHTML(pub) {
    const tier = pub.bestsellerTier || 0;
    const label = pub.paidBadge || "—";
    const detail = pub.paidDetail || "Estimated from Substack's Bestseller badge";
    return `<span class="badge badge-t${tier}" title="${escapeHTML(detail)}">${label}</span>`;
  }

  function leanHTML(pub) {
    const meta = LEAN_META[pub.lean] || LEAN_META.unrated;
    return `<span class="lean ${meta.cls}" title="${escapeHTML(meta.full)}">${meta.label}</span>`;
  }

  // Normalize a URL for matching against data/lean.json keys.
  function leanKey(url) {
    return String(url || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url || "";
    }
  }

  function currentList() {
    const doc = state.data[state.category];
    return doc && Array.isArray(doc.publications) ? doc.publications : [];
  }

  function compare(a, b) {
    const k = state.sortKey;
    let va = a[k];
    let vb = b[k];
    if (typeof va === "string" || typeof vb === "string") {
      va = String(va ?? "").toLowerCase();
      vb = String(vb ?? "").toLowerCase();
      return va < vb ? -state.sortDir : va > vb ? state.sortDir : 0;
    }
    va = Number(va) || 0;
    vb = Number(vb) || 0;
    return (va - vb) * state.sortDir;
  }

  function render() {
    const list = currentList()
      .filter((p) => {
        if (!state.filter) return true;
        const leanLabel = (LEAN_META[p.lean] || {}).label || "";
        const hay = `${p.author} ${p.publicationName} ${leanLabel}`.toLowerCase();
        return hay.includes(state.filter);
      })
      .slice()
      .sort(compare);

    els.rows.innerHTML = list
      .map((p) => {
        const rankClass = p.rank <= 3 ? `rank rank-${p.rank}` : "rank";
        const host = hostFromUrl(p.url);
        const link = p.url
          ? `<a class="pub-link" href="${escapeHTML(p.url)}" target="_blank" rel="noopener">${escapeHTML(host)}</a>`
          : "—";
        return `<tr>
          <td class="num" data-label="#"><span class="${rankClass}">${p.rank}</span></td>
          <td data-label="Author">${escapeHTML(p.author)}</td>
          <td data-label="Publication" class="pub-name">${escapeHTML(p.publicationName)}</td>
          <td data-label="Lean">${leanHTML(p)}</td>
          <td data-label="URL">${link}</td>
          <td class="num" data-label="Paid Subs">${paidBadgeHTML(p)}</td>
          <td class="num" data-label="Total Subs">${fmtInt(p.freeSubscribers)}${p.totalEstimated ? '<span class="est-mark" title="Rough estimate — see notes at the bottom of the page">*</span>' : ""}</td>
        </tr>`;
      })
      .join("");

    els.empty.hidden = list.length > 0;

    const doc = state.data[state.category];
    if (doc) {
      const when = doc.source === "sample"
        ? "sample data"
        : doc.generatedAt
        ? `updated ${new Date(doc.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`
        : "";
      els.meta.textContent = `${list.length} shown · ${when}`;

      if (doc.source === "sample") {
        els.banner.hidden = false;
        els.banner.innerHTML =
          "⚠️ Showing <strong>sample data</strong>. Run <code>npm run fetch</code> " +
          "(where outbound network access to substack.com is allowed) to load the live leaderboard.";
      } else {
        els.banner.hidden = true;
      }
    }
  }

  function updateHeaderIndicators() {
    els.headers.forEach((th) => {
      if (th.dataset.key === state.sortKey) {
        th.setAttribute("aria-sort", state.sortDir === 1 ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });
  }

  function setSort(key) {
    if (state.sortKey === key) {
      state.sortDir *= -1;
    } else {
      state.sortKey = key;
      // Text columns default A→Z; numeric default high→low (except rank).
      state.sortDir = key === "author" || key === "publicationName" || key === "rank" ? 1 : -1;
    }
    updateHeaderIndicators();
    render();
  }

  async function loadLeans() {
    if (state.leans) return;
    state.leans = {};
    try {
      const res = await fetch("data/lean.json", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        for (const [url, val] of Object.entries(json.leans || {})) {
          state.leans[leanKey(url)] = val;
        }
      }
    } catch {
      /* no lean file -> everything shows as Unrated */
    }
  }

  async function loadOverrides() {
    if (state.overrides) return;
    state.overrides = {};
    try {
      const res = await fetch("data/overrides.json", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        for (const [url, val] of Object.entries(json.overrides || {})) {
          state.overrides[leanKey(url)] = val;
        }
      }
    } catch {
      /* no overrides file -> use fetched data as-is */
    }
  }

  function enrich(doc) {
    if (!doc || !Array.isArray(doc.publications)) return;
    doc.publications.forEach((p) => {
      p.lean = (state.leans && state.leans[leanKey(p.url)]) || "unrated";
      const ov = state.overrides && state.overrides[leanKey(p.url)];
      if (ov) {
        if (typeof ov.totalSubscribers === "number") p.freeSubscribers = ov.totalSubscribers;
        p.totalEstimated = !!ov.estimated;
      }
    });
  }

  async function loadCategory(slug) {
    if (state.data[slug]) return;
    try {
      const res = await fetch(CATEGORIES[slug], { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data[slug] = await res.json();
    } catch (err) {
      state.data[slug] = {
        category: slug,
        source: "error",
        publications: [],
        generatedAt: null,
      };
      els.banner.hidden = false;
      els.banner.innerHTML = `Could not load <code>${CATEGORIES[slug]}</code> (${escapeHTML(
        err.message
      )}).`;
    }
  }

  async function selectCategory(slug) {
    state.category = slug;
    els.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.category === slug));
    await Promise.all([loadCategory(slug), loadLeans(), loadOverrides()]);
    enrich(state.data[slug]);
    render();
  }

  function init() {
    els.tabs.forEach((tab) =>
      tab.addEventListener("click", () => selectCategory(tab.dataset.category))
    );
    els.headers.forEach((th) =>
      th.addEventListener("click", () => setSort(th.dataset.key))
    );
    els.search.addEventListener("input", (e) => {
      state.filter = e.target.value.trim().toLowerCase();
      render();
    });
    updateHeaderIndicators();
    selectCategory(state.category);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
