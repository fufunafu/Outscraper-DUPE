# Outscraper-dupe: Google Maps scraper

Rebuild of the Google Maps Scraper at <https://outscraper.com/google-maps-scraper/> for our own use.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Shape | Engine library + CLI first, web UI after | The engine is the hard part and is testable on its own; the UI is a form over it |
| Data source | Unofficial scraping | The official Places API caps at 60 results/query, costs ~$32/1000 details, and returns no emails — it cannot reproduce Outscraper's output or price |
| Geography | US + Canada | Preload GeoNames ZIP + Canadian FSA centroids; the grid engine works anywhere regardless |
| Language | TypeScript on Node 22 | Same language as the eventual Next.js UI; native type stripping means no build step |

## The actual problem

Google caps a single Maps search at a fixed number of results — you cannot ask
for "all 40,000 restaurants in Texas" in one query and page through. Everything
else in this project is downstream of that one constraint.

Two ways around it, and every commercial scraper uses one or both:

1. **Grid tiling.** Subdivide the region geographically and search each cell
   separately. If a cell returns a saturated result count, Google truncated it,
   so split that cell into four and search each child. Recurse until every cell
   comes back under the cap. Dense downtowns end up finely subdivided; empty
   countryside gets one search. This is `packages/engine/src/geo/quadtree.ts`.
2. **Postal codes.** Iterate a region's ZIP/FSA list and search `"restaurants,
   90210"` for each. Simpler and needs no viewport math, but coverage is only as
   good as the postal boundaries, and Google's interpretation of a ZIP in a
   query is fuzzy. This is what Outscraper's `Use zip codes` checkbox does.

We implement tiling as the primary engine and postal codes as an alternate
seeding strategy, because tiling is provably exhaustive and postal codes are not.

## Pipeline

```
query + region
  ↓ coverage      split region into search cells until none saturate
  ↓ search        fetch each cell's result list
  ↓ parse         extract place fields
  ↓ dedupe        collapse by stable place key across overlapping cells
  ↓ enrich        crawl each business site for emails + socials  (optional)
  ↓ filter        the UI's quick filters: has website, has phone, rating, …
  ↓ export        CSV / XLSX / JSON
```

Dedupe is not optional: adjacent cells overlap at their edges and a place near a
boundary is returned by both, so the same business will be seen many times.

## Agents

Research (done in parallel, up front — findings in `docs/research/`):

| # | Scope |
| --- | --- |
| R1 | Outscraper's own API: parameters, output schema, pricing, what each UI control maps to |
| R2 | Coverage strategy: tiling vs postal codes, zoom↔metres math, the real result cap, dedupe keys |
| R3 | Extraction mechanics: internal endpoint vs headless browser, anti-bot, which OSS project to build on |
| R4 | Enrichment: email/social extraction from business sites, verification, compliance |

Build (sequenced after research, since the schema drives everything):

| # | Scope |
| --- | --- |
| B1 | Search + parse: fetch a cell, extract places into our schema |
| B2 | Coverage + dedupe + store: wire the quadtree to the searcher, persist to SQLite |
| B3 | Enrichment: website crawl → emails, socials, phones |
| B4 | CLI + export: the `scrape` command, CSV/XLSX writers, filters |
| B5 | Web UI: Next.js clone of the screenshotted form, job queue, history, downloads |

## Legal note

Scraping public business listings from Google Maps is against Google's Terms of
Service, though the data itself is public and factual and this is the basis on
which the whole commercial scraping industry (Outscraper included) operates.
Separately, cold-emailing scraped addresses is regulated: Canada's CASL requires
consent or a demonstrable existing business relationship and carries real
penalties, and it is stricter than US CAN-SPAM. Worth knowing before the
enrichment output gets pointed at a mail merge.
