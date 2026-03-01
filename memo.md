Token usage: total=1,069,267 input=897,855 (+ 45,083,136 cached) output=171,412 (reasoning 47,104)
To continue this session, run codex resume 019c5063-daf9-71c0-a1ba-d5d67338220a

## 2026-02-12 Daily Summary

### What Changed
- Renamed the generator script to align with the new page name: `scripts/news-overview.js`.
- Updated server to read `news-overview.json` and added an auto-refresh switch so `/api/news-overview` can regenerate the file when missing or stale.
- Standardized navigation order and layout across `index.html`, `news-overview.html`, and `news-aggregator.html`.
- Consolidated Online indicator styling and behavior (icon-only, bar-style container, consistent spacing).
- Introduced flip-card behavior for Sources in News Overview (front: overview, back: sources).
- Synced News Overview as the homepage (`index.html` mirrors the overview page).
- Tightened UI alignment for header, meta, and top nav.

### Auto-Refresh Toggle
- `NEWS_OVERVIEW_AUTO_REFRESH=0|1` (off by default)
- `NEWS_OVERVIEW_TTL_MIN=30` (staleness threshold in minutes)

### Files Touched
- `server.js`
- `scripts/news-overview.js` (renamed from `daily-brief.js`)
- `news-overview.html`
- `news-aggregator.html`
- `index.html`
- `.env.example`
