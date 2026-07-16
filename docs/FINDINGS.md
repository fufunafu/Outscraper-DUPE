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

## Review count is absent from search responses

`[4]` has length 8 in **every** record — rating at `[4][7]` is the last element,
so `[4][8]` (gosom's documented review-count index) cannot exist here. gosom
reads `[4][8]` from *place-detail* responses, which have a longer `[4]`; the
search-list `[4]` is truncated. Either Google trimmed it (they moved hours from
`[34][1]` to `[203][0]` in Nov 2025, so this is in character) or it was never
there for list responses.

Ruled out, each by measurement rather than reasoning:

- **pb flag variants** — `!9b1`, `!24b1!25b1`, minimal tail, and a browser-like
  `!12m16` block all returned `[4].length === 8`. Two variants returned zero
  results, since an `m`-cluster's node count must be exact.
- **`[75][0][0][4]` = 21631** looked like Carmine's review count. It is the same
  constant for every place in the response, so it is not a per-place field. This
  is the trap: a plausible number at a plausible path that is simply wrong.
- **The SSR page** (`/maps/search/…`) is a 176KB shell with no results in it;
  Google fetches them via XHR from this same endpoint after load.

So review count needs either the real frontend's `pb` (requires capturing live
browser network traffic) or a per-place detail fetch — one extra request per
place, versus one per twenty for search. `reviews_per_score` and `popular_times`
are missing for the same reason.

Everything needed to *filter* leads — name, address, phone, site, category,
rating, hours, coordinates — is already in the cheap path.
