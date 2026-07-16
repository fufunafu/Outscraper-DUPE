# Verified findings

Everything here was measured against the live endpoint on 2026-07-16, not taken
from documentation or a blog. Where a source claimed otherwise, the measurement wins.

## The endpoint works without a browser

`GET google.com/search?tbm=map&q=<query>&pb=<viewport>` returns `)]}'`-prefixed
JSON, ~20 places per request in a few hundred ms, no cookies needed from US
egress. No Playwright anywhere in the search path.

## The result cap is 129, not 500

Measured at Times Square, `restaurants`:

| offset | places returned |
| --- | --- |
| 0, 20, 100 | 20 |
| 120 | **9** |
| 140, 200, 300 | 0 |

So a query+viewport yields at most **129** places, and `!8i<offset>` pages 20 at
a time until then. Outscraper's "500 places per query" is not a single query —
it's their own fan-out across sub-queries, billed per record. gosom's ~120 was
approximately right; the exact number is 129.

`saturationThreshold` is therefore set to 100 — comfortably under the cap, so a
truncated cell is caught even if the cap drifts a little.

## Zoom (`!4f`) is NOT inert

This was worth checking: SerpApi's pb decoder reads `!4f` as camera tilt, while
gosom writes the zoom level into it. If SerpApi were right, every cell would
search an identical area and the entire coverage engine would silently no-op.

Measured — same centre, `restaurants`, comparing returned place_ids:

    zoom 11 vs zoom 19 → 9/20 results in common

Different result sets, so **`!4f` does steer the search area**. gosom's reading
is correct for this field. The coverage engine's core assumption holds.

## Fields present in a search response

Confirmed populated (fill rate across 20 Times Square restaurants):

| Field | Index | Fill |
| --- | --- | --- |
| name | `[11]` | 20/20 |
| place_id | `[78]` | 20/20 |
| google_id (feature id) | `[10]` | 20/20 |
| address lines | `[2]` | 20/20 |
| full address | `[39]`, `[18]` | 20/20 |
| structured address | `[183][1][…]` | 20/20 |
| lat / lng | `[9][2]` / `[9][3]` | 20/20 |
| **phone** | `[178][0][0]` | **19/20** |
| website | `[7][0]` | 20/20 |
| categories | `[13]` | 20/20 |
| rating | `[4][7]` | 20/20 |
| hours | `[203][0]` | 20/20 |
| timezone | `[30]` | 20/20 |
| attributes/about | `[100][1]` | 20/20 |
| description | `[32][1][1]` | 18/20 |

Note the request/response coordinate inversion: the pb sends `!2d<lng>!3d<lat>`,
but the response is `[9][2]=lat, [9][3]=lng`. Swapping these is silent and ruinous.

## Review count: at [4][8], but only a headful browser is served it

Review count lives at **`[4][8]`** — gosom's index was right all along. What
varies is whether Google sends it:

| Client | payload | `[4]` len | `[4][8]` |
| --- | --- | --- | --- |
| `pb` HTTP endpoint | — | 8 | absent |
| Headless Chrome | 264 KB | 15 | **null** |
| Headful Chrome, logged out | **862 KB** | 15 | **26089** ✓ |
| Real Chrome, logged in | 892 KB | 15 | 26089 ✓ |

**Google serves a degraded payload to headless Chrome.** Same URL, same anonymous
cookies, same everything — a real window gets 862KB with review counts, a
headless one gets 264KB with them stripped. This is anti-bot behaviour, not a
login gate: a logged-out headful browser gets the full data. So no Google account
is needed, and scraping must never be run on the user's own session anyway —
that would attach bulk activity to their personal account.

Verified against the DOM rather than by eyeballing plausibility, which mattered:

| Place | DOM renders | `[4][8]` | `[37][1]` |
| --- | --- | --- | --- |
| Joe's Pizza Broadway | 26,089 | **26,089** | 22,853 |
| Roma Pizza | 1,586 | **1,586** | 1,000 |
| Madison Pizza NYC | 194 | **194** | 256 |
| Angelo's Coal Oven | 3,677 | **3,677** | 2,373 |

`[4][8]` matches 7/7. **`[37][1]` does not** — it is some other per-place integer
that happens to look like a review count, and it was nearly shipped as one.

Three separate decoys sat in this payload: `[75][0][0][4]` = 21631 (a constant,
identical for every place), `[88][4][*]` (rendering metadata), and `[37][1]`
(varies per place, wrong values). Every one is a plausible integer at a plausible
path. **Only cross-checking against what Google actually renders distinguishes
them** — so any new field mapping gets verified against the DOM before it ships.

## Two extraction paths, by cost

| | `pb` HTTP | headful browser |
| --- | --- | --- |
| Per request | ~200 ms | ~2 s |
| Places per request | 20 | 20 |
| Review count, reviews_per_score | no | **yes** |
| Cost per 1k places | ~10 s | ~100 s |

The browser path is ~10× slower but still amortises over 20 places per load —
it is not the one-fetch-per-place tax it first appeared to be. Default to `pb`
for coverage sweeps; use the browser when review counts matter for filtering.

Headless is not a middle option: it costs browser latency and returns endpoint
data. Either go fast over HTTP or go complete with a real window (`xvfb` on a
server, or a stealth-patched runtime such as `patchright`).
