# Substack Politics & News Leaderboard — Chaotic Era

A sortable leaderboard of the **top 100 Substack publications** in **U.S. Politics**
and **News**, branded for [Chaotic Era](https://chaoticera.news) (Kyle Tharp's
newsletter on politics, media, and online influence).

The page shows, for each publication: **Author**, **Publication name**,
**Publication URL**, **Paid subscribers (estimated)**, and **Free subscribers**.
Click any column header to sort; use the tabs to switch between U.S. Politics and
News, and the search box to filter.

## Project layout

```
index.html / styles.css / app.js   # static, sortable front-end (no build step)
scripts/fetch-leaderboard.mjs       # pulls rankings from Substack's API → data/*.json
scripts/serve.mjs                   # tiny local preview server
data/us-politics.json               # U.S. Politics publications
data/news.json                      # News publications
```

The front-end is plain static HTML/CSS/JS — it just reads the two JSON files,
so it can be hosted anywhere (GitHub Pages, Netlify, Vercel, …).

## Hosting it on GitHub Pages (free)

This is a static site, so the easiest host is GitHub Pages:

1. Go to **Settings → Pages** in this repo.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to `/ (root)`, then click **Save**.
4. Wait ~1 minute. Your site appears at:
   **https://kylewilsontharp.github.io/SubstackPoliticsLeaderboard/**

That's it — every push to `main` re-publishes automatically.

## Refreshing the data

⚠️ **Substack blocks automated/datacenter requests.** Its API returns
`403 Forbidden` to GitHub's servers and most cloud hosts, so the data **cannot**
be refreshed from a CI job. It generally works from a normal home/office
internet connection. To pull fresh numbers:

```bash
# Run on your own computer (Node 18+), where Substack is reachable:
npm run fetch          # top 250 per category -> data/us-politics.json, data/news.json
git add data/ && git commit -m "Refresh leaderboard data" && git push
```

By default it pulls the **top 250** per category. To pull a different amount (Substack's
category listing usually contains far more than 100), pass a limit — the fetch
stops automatically when Substack reports no more results:

```bash
node scripts/fetch-leaderboard.mjs --limit 250          # both categories, top 250
node scripts/fetch-leaderboard.mjs us-politics --limit 500
node scripts/fetch-leaderboard.mjs --limit all          # everything Substack returns
```

> Going beyond ~100 means more API requests (higher chance of a temporary 403/
> rate-limit) and increasingly "category directory" rather than "leaderboard"
> ordering. If you raise the count, update the "Top 100" heading in `index.html`.

Then preview locally before/after:

```bash
npm run serve          # → http://localhost:8000
```

Until a successful fetch runs, the page shows **clearly-labelled sample data**
(with a banner) so the layout and sorting are fully visible.

## Data sources & important caveats

Rankings come from Substack's **public, undocumented** category leaderboard API
(`/api/v1/category/public/<id>/all`). Two columns need explanation:

- **Paid subscribers — *estimate only.*** Substack does **not** publish exact
  paid-subscriber counts. The only public signal is the **Bestseller badge tier**,
  which maps to paid-subscriber milestones
  ([Substack docs](https://support.substack.com/hc/en-us/articles/10661509585428)):

  | Badge tier | Color  | Estimated paid subscribers |
  | ---------- | ------ | -------------------------- |
  | 1          | white  | 100+                       |
  | 2          | orange | 1,000+                     |
  | 3          | purple | 10,000+                    |

  Values shown are **lower bounds**, presented as estimates — not exact figures.

- **Free subscribers** are the **approximate** free/total subscriber counts
  Substack itself reports on the leaderboard.

## Customizing the branding

All brand tokens (colors, fonts) live at the top of `styles.css` under `:root`.
The palette evokes Chaotic Era's high-contrast editorial look; drop in the exact
hex values / logo from chaoticera.news to match pixel-for-pixel.

## Changing categories

Edit the `CATEGORIES` array in `scripts/fetch-leaderboard.mjs`. Category IDs are
resolved by name at runtime from `/api/v1/categories`, so you only need the
display name (e.g. `"World Politics"`). Then add a matching tab in `index.html`
and an entry in the `CATEGORIES` map in `app.js`.
