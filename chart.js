/* Chaotic Era — packed-bubble "map of political Substack".
   EXPERIMENTAL. Self-contained: fetches the data, joins lean + overrides,
   and renders a force-packed landscape bubble chart with D3.
   To remove: delete the .chart-section block in index.html, the two script
   tags (d3 + chart.js), this file, and the chart styles in styles.css. */
(() => {
  "use strict";

  const COLORS = { left: "#419eff", right: "#fa2c5d", neutral: "#9aa6b2", unrated: "#9aa6b2" };
  const LEAN_LABEL = { left: "Left", right: "Right", neutral: "Neutral", unrated: "Unrated" };
  const NF = new Intl.NumberFormat("en-US");

  const leanKey = (url) =>
    String(url || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");

  async function getJSON(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function build() {
    const el = document.getElementById("bubble-chart");
    if (!el || typeof d3 === "undefined") return;

    const [us, news, leanDoc, ovDoc] = await Promise.all([
      getJSON("data/us-politics.json"),
      getJSON("data/news.json"),
      getJSON("data/lean.json"),
      getJSON("data/overrides.json"),
    ]);

    const leans = {};
    if (leanDoc && leanDoc.leans)
      for (const [u, v] of Object.entries(leanDoc.leans)) leans[leanKey(u)] = v;
    const overrides = {};
    if (ovDoc && ovDoc.overrides)
      for (const [u, v] of Object.entries(ovDoc.overrides)) overrides[leanKey(u)] = v;

    const seen = new Set();
    const items = [];
    for (const doc of [us, news]) {
      if (!doc || !Array.isArray(doc.publications)) continue;
      for (const p of doc.publications) {
        const k = leanKey(p.url);
        if (seen.has(k)) continue; // dedupe publications that appear in both lists
        seen.add(k);
        let total = p.freeSubscribers || 0;
        const ov = overrides[k];
        if (ov && typeof ov.totalSubscribers === "number") total = ov.totalSubscribers;
        if (total <= 0) continue; // can't size hidden counts
        items.push({
          name: String(p.publicationName || "").trim(),
          url: p.url,
          total,
          lean: leans[k] || "unrated",
          estimated: !!(ov && ov.estimated),
        });
      }
    }
    if (!items.length) return;
    render(el, items);
  }

  function render(el, items) {
    const PAD = 2; // minimum gap between bubble edges
    const maxT = d3.max(items, (d) => d.total) || 1;
    const r = d3.scaleSqrt().domain([0, maxT]).range([3.5, 52]);
    // Seed positions in an ellipse taller than it is wide.
    items.forEach((d, i) => {
      d.r = r(d.total);
      const a = (i / items.length) * 2 * Math.PI;
      d.x = Math.cos(a) * 90;
      d.y = Math.sin(a) * 140;
    });

    // Force pass for an even, vertically-biased cluster (stronger vertical pull
    // = narrower/taller). forceX weaker than forceY -> less wide than tall.
    const sim = d3
      .forceSimulation(items)
      .force("x", d3.forceX(0).strength(0.025))
      .force("y", d3.forceY(0).strength(0.18))
      .force("collide", d3.forceCollide((d) => d.r + PAD).iterations(6).strength(1))
      .stop();
    for (let i = 0; i < 400; i++) sim.tick();

    // Deterministic relaxation pass to GUARANTEE no two bubbles overlap.
    resolveOverlaps(items, PAD, 400);

    // Fit the viewBox tightly to the resulting cluster (no clipping, no gaps).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of items) {
      minX = Math.min(minX, d.x - d.r);
      maxX = Math.max(maxX, d.x + d.r);
      minY = Math.min(minY, d.y - d.r);
      maxY = Math.max(maxY, d.y + d.r);
    }
    const m = 4;
    const vbX = minX - m, vbY = minY - m;
    const vbW = maxX - minX + 2 * m, vbH = maxY - minY + 2 * m;

    const svg = d3
      .select(el)
      .append("svg")
      .attr("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`)
      .attr("class", "bubbles-svg")
      .attr("role", "img")
      .attr("aria-label", "Packed bubbles of Substack publications, sized by subscribers and coloured by partisan lean");

    const tip = d3.select(el).append("div").attr("class", "bubble-tip").style("opacity", 0);

    svg
      .selectAll("circle")
      .data(items)
      .join("circle")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", (d) => d.r)
      .attr("fill", (d) => COLORS[d.lean] || COLORS.unrated)
      .attr("fill-opacity", 0.88)
      .attr("stroke", (d) => d3.color(COLORS[d.lean] || COLORS.unrated).darker(0.6))
      .attr("stroke-width", 0.6)
      .style("cursor", "pointer")
      .on("mousemove", function (event, d) {
        const [mx, my] = d3.pointer(event, el);
        tip
          .html(
            `<strong>${escapeHTML(d.name)}</strong><br>${NF.format(d.total)}${
              d.estimated ? "*" : ""
            } total subs · ${LEAN_LABEL[d.lean]}`
          )
          .style("left", mx + 12 + "px")
          .style("top", my + 12 + "px")
          .style("opacity", 1);
      })
      .on("mouseleave", () => tip.style("opacity", 0))
      .on("click", (event, d) => d.url && window.open(d.url, "_blank", "noopener"));
  }

  // Push overlapping circles apart until none overlap (or maxPasses reached).
  function resolveOverlaps(items, pad, maxPasses) {
    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        for (let j = i + 1; j < items.length; j++) {
          const b = items[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const min = a.r + b.r + pad;
          if (dist < min) {
            const shift = (min - dist) / 2 / dist;
            const sx = dx * shift;
            const sy = dy * shift;
            a.x -= sx; a.y -= sy;
            b.x += sx; b.y += sy;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  document.addEventListener("DOMContentLoaded", build);
})();
