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

## Review count: at [4][8], and gated on a session cookie

**A correction.** This section previously concluded that Google serves a degraded
payload to *headless* Chrome, on the strength of a headful-vs-headless comparison
where headful got review counts and headless didn't. That was wrong. The real
lever is the **`NID` session cookie** — the browsers differed in cookie warmth,
not in headlessness, and the conclusion was drawn from the confounded variable.

Measured on the `pb` endpoint, holding everything else constant:

| Cookies sent | `[4]` length | places with review count |
| --- | --- | --- |
| none | 8 | 0/20 |
| `CONSENT` + `SOCS` only | 8 | 0/20 |
| **warmed `NID`** | **9** | **20/20** |

`NID` is the anonymous cookie Google issues to any first-time visitor of
`google.com/maps`. No account, no browser, no stealth runtime, no `xvfb`.
One warm-up request per session buys the full payload on the fast HTTP path —
which means the browser path is unnecessary and has been dropped.

Review count lives at **`[4][8]`**, exactly where gosom documents it. It read as
absent because every request was cookieless.

### The degradation is silent, and partly non-deterministic

Google does not error or block when it withholds fields. It returns a
structurally valid response with real places in it, just smaller — `[4]` stops
at length 8 so `[4][8]` cannot exist. Nothing about the response says so.

Warming the cookie is necessary but not sufficient: on a fresh session the first
request or two may still come back trimmed, and it varies run to run (one fresh
session returned full data three times; another returned trimmed, then full,
then full). It reads like a propagation race on Google's side.

So the parser **detects** the reduced payload structurally, on the length of
`[4]`, and the scraper retries it. The check is deliberately structural rather
than "did any place have a review count", because a genuinely review-free area
would be indistinguishable under that test and would retry forever. After the
last attempt the stripped data is kept rather than dropping the cell: a missing
review count beats twenty missing places.

Result: 20/40 places with review counts before the retry, 40/40 after.

### Verify new fields against the DOM, always

`[4][8]` was confirmed by diffing against the number Google renders on screen,
7/7 exact. That step is not optional, because this payload is full of decoys:

| Path | Looks like | Actually |
| --- | --- | --- |
| `[75][0][0][4]` | 21631, a review count | a constant — identical for every place |
| `[37][1]` | varies per place, right magnitude | wrong values (22,853 vs a true 26,089) |
| `[88][4][*]` | plausible integers | rendering metadata |

Each is a believable integer at a believable path, and `[37][1]` was nearly
shipped. Plausibility is not evidence; the rendered DOM is.

## One extraction path

There is no browser in this project. A warmed `NID` cookie gets the full payload
over plain HTTP at ~200 ms per 20 places — roughly 10× faster than driving a
browser, with the same fields. The browser path existed only to work around a
problem that turned out to be a missing cookie.

## Rate limits, measured

53 requests across 8 US/CA cities at up to concurrency 8, from one residential IP
with no proxy: **53/53 succeeded, 5.4 req/s, zero blocks**. Vendor blogs claim
datacenter IPs die at 5–15 req/*minute*; we sustained ~324/minute. A later
Brooklyn sweep ran ~1,700 requests from the same IP, also clean.

That is a burst, not an eight-hour run, and it says nothing about datacenter IPs
— which remain untested. But the working point is far higher than the vendor
literature implies, and blocking is not the main threat. **Silent degradation
is**: Google's response to an unwelcome client is to quietly give it less, not
to say no.

## Proxy economics

Responses are ~136 KB decompressed (~12 KB on the wire — a 9× gzip ratio, so
measure wire bytes when pricing). The duplicate rate dominates the bill: the
Brooklyn run fetched ~1,700 requests to yield 726 unique places, since
overlapping cells re-fetch the same businesses.

| Proxy | $/GB | per 1k unique places |
| --- | --- | --- |
| Webshare | $1.00 | ~$0.32 |
| IPRoyal | ~$4.90 | ~$1.50 |
| Decodo | $3.50 | ~$1.11 |
| Bright Data | $8.40 | ~$2.67 |
| **Outscraper** | — | **$1–3** |

With cheap proxies we are ~3–5× cheaper than buying; with premium proxies we are
at parity. **Reducing duplicate fetches is therefore a cost optimisation, not a
performance nicety.**
