# Deterministic Lead Scoring (Phase 12)

## Purpose

Every business is assigned a **lead score** from 0–100 and a **priority**
(`low` / `medium` / `high` / `very_high`) that a salesperson can use to
decide who to contact first. The score is calculated by a deterministic
rules engine (`server/lib/leadScoring.js`) from data already verified
and stored in Neon — never by an AI model, never randomly, and never
from anything supplied in a request body.

**The score is deterministic and reproducible.** Given the same
database input, `calculateLeadScore()` always returns the same output.
There is no randomness, no clock/date dependence, and no network or AI
call anywhere in the scoring path.

**AI does not determine the score.** Phase 11B's AI opportunity
analysis (`recommended_service`, `opportunities`, `reasoning`,
`confidence`, `sales_angle`) is loaded and returned *alongside* a lead
score as additional sales intelligence (see `ai_analysis` in the API
response below), but none of it is ever read by the scoring engine.
`server/lib/leadScoring.js` has no dependency on
`server/lib/aiOpportunityAnalysis.js` at all.

## Architecture

```
Google Places
      ↓
Businesses in Neon
      ↓
Website Detection            (Phase 9)
      ↓
Website Analysis              (Phase 10)
      ↓
AI Opportunity Analysis       (Phase 11)
      ↓
DETERMINISTIC LEAD SCORING    (Phase 12) ← this document
      ↓
Lead Score 0–100 + Priority + Score Breakdown
      ↓
Sales Pipeline
```

- `server/lib/leadScoring.js` — pure scoring engine. No database, no
  network, no AI. Fully unit-testable with plain JS objects.
- `server/lib/leadScoringService.js` — loads verified data from Neon,
  builds the scoring input, calls the engine, persists the result.
- `server/routes/businesses.js` — `POST /api/businesses/:id/lead-score`
  and `POST /api/businesses/lead-score` (batch), thin HTTP wrappers
  around the service.
- `migrations/005_lead_scoring.sql` — additive migration adding
  `scoring_factors` / `scored_at` to the existing `leads` table.

## Scoring factors

Total possible score = **100 points**, split across 7 factors. Every
factor is calculated from a specific, named column already verified in
Neon — nothing is invented, and nothing is guessed from the absence of
data.

### A. Website presence — max 25

Source: `businesses.website_status` (`'no_website' | 'reachable' |
'unreachable' | 'unknown'`).

| website_status | Points | Code |
|---|---|---|
| `no_website` | +25 | `no_website` |
| `unreachable` | +20 | `unreachable_website` |
| `unknown` | +10 | `unknown_website_status` |
| `reachable` | +0 | `reachable_website` |

`no_website` and `unreachable` are mutually exclusive by construction
(`website_status` is a single column with one value at a time) — the
engine never awards both.

### B. Performance — max 20

Source: `performance_score` on the **latest `website_analysis` row
whose `analysis_status = 'completed'`**. A `null` score (PageSpeed
Insights didn't return one, even on an otherwise-completed row) is
never treated as if the site scored 0 — it is its own case, worth 0
points, exactly like "no data available".

| performance_score | Points | Code |
|---|---|---|
| 0–49 | +20 | `poor_performance` |
| 50–69 | +15 | `below_average_performance` |
| 70–84 | +8 | `moderate_performance` |
| 85–100 | +0 | `strong_performance` |
| no completed score | +0 | `performance_unknown` |

### C. Mobile experience — max 15

Source: `viewport_present` on the same latest-completed
`website_analysis` row.

**Why this factor does not also use a "mobile performance score"
threshold table:** `server/lib/pagespeedInsights.js` requests the
PageSpeed **`mobile`** strategy by default, and `mobile_indicator`
merely records which strategy string was used for the request/response
— it is not a distinct "this site has a mobile problem" flag. In other
words, `performance_score` **is already** the mobile Lighthouse
performance score, and it is already fully credited under factor B
above. Re-scoring it here under a second label would double-count the
exact same measurement, which this phase explicitly forbids. This
factor therefore only looks at `viewport_present` — a genuinely
distinct, HTML-structural signal (whether a homepage `<meta
name="viewport">` tag was found) that carries no overlap with the
Performance factor.

| viewport_present | Points | Code |
|---|---|---|
| `false` (verified: tag is missing) | +15 | `missing_viewport` |
| `true` (verified: tag is present) | +0 | `viewport_present` |
| unknown (no completed analysis, or value not recorded) | +0 | `mobile_experience_unknown` |

A `null`/missing value is never treated as "a mobile problem exists" —
absence of data never manufactures a weakness.

### D. SEO — max 15

Source: `seo_score` on the same latest-completed `website_analysis`
row. Same tier shape as Performance, different point values.

| seo_score | Points | Code |
|---|---|---|
| 0–49 | +15 | `poor_seo` |
| 50–69 | +10 | `below_average_seo` |
| 70–84 | +5 | `moderate_seo` |
| 85–100 | +0 | `strong_seo` |
| no completed score | +0 | `seo_unknown` |

### E. Accessibility — max 10

Source: `accessibility_score` on the same latest-completed
`website_analysis` row.

| accessibility_score | Points | Code |
|---|---|---|
| 0–49 | +10 | `poor_accessibility` |
| 50–69 | +7 | `below_average_accessibility` |
| 70–84 | +4 | `moderate_accessibility` |
| 85–100 | +0 | `strong_accessibility` |
| no completed score | +0 | `accessibility_unknown` |

### F. Clear fit for Alvin Solutions — max 10

Fully deterministic — never asks AI, never uses subjective judgment
("looks like a good business", "probably needs a website", etc. are
never evaluated). Awards +10 (`clear_fit`) if **any** of factors A–E
above already identified a confirmed, objectively-measured weakness:

- `website_status` is `no_website`, or
- `website_status` is `unreachable`, or
- the Performance factor awarded > 0 points (score < 85), or
- the SEO factor awarded > 0 points (score < 85), or
- the Accessibility factor awarded > 0 points (score < 85), or
- the Mobile factor awarded > 0 points (missing viewport tag)

Otherwise: +0 (`no_clear_fit`).

Note that `website_status = 'unknown'` alone does **not** trigger this
factor — "we haven't checked yet" is not itself a confirmed weakness
the way "no website" or "unreachable" are, so Fit is derived from the
same booleans, not a blanket "any factor A–E awarded > 0 points" check
(which would also catch the unrelated `unknown_website_status` case).

### G. Business presence / reviews — max 5

Source: `businesses.google_review_count`. A business-presence signal
**only** — never interpreted as proof of revenue, quality, or
willingness to buy.

| google_review_count | Points | Code |
|---|---|---|
| 0 (or not on file) | +0 | `no_reviews` |
| 1–20 | +1 | `established_reviews` |
| 21–50 | +2 | `established_reviews` |
| 51–100 | +3 | `established_reviews` |
| 101–250 | +4 | `established_reviews` |
| 251+ | +5 | `established_reviews` |

## Score normalization

```
score = sum(factor.points for factor in A..G)
score = clamp(score, 0, 100)   // Math.max(0, Math.min(100, score))
```

The theoretical max (25+20+15+15+10+10+5 = 100) and min (0) already
fall inside the clamp, so the clamp is a defensive backstop, not a
normal code path. The score is always an integer — every tier's point
value is itself an integer, so no floating-point rounding is ever
involved.

## Priority thresholds

| Score range | Priority |
|---|---|
| 0–24 | `low` |
| 25–49 | `medium` |
| 50–74 | `high` |
| 75–100 | `very_high` |

Priority is derived from `score` alone — never set directly or
influenced by AI output.

**Naming note:** the codebase's existing enum columns
(`website_status`, `lead_status`, `recommended_service`) all use
lowercase `snake_case` values. `leads.priority` follows that same
convention (`low` / `medium` / `high` / `very_high`) rather than the
Title Case spelling used for illustration elsewhere; the frontend
formats it for display (e.g. "Very High") — see
`frontend/src/components/ui/Badge.tsx`.

## Handling of missing data

Every factor above treats a missing/`null` verified value as its own
explicit "unknown" case worth 0 points — never as if the underlying
metric were 0, and never as evidence that a problem exists. This
applies to: no completed `website_analysis` row at all, a `null`
`*_score` within an otherwise-completed row (PageSpeed can fail
independently of the homepage fetch), a `null` `viewport_present`, and
a `null` `google_review_count`.

## Anti-double-counting rules

- Factor A (Website presence) never awards both `no_website` and
  `unreachable` — `website_status` is a single column, so these are
  structurally mutually exclusive.
- Factor C (Mobile experience) never re-uses `performance_score` for a
  "mobile performance" threshold table, since that number is already
  the mobile Lighthouse score credited under factor B. See the
  rationale under "C. Mobile experience" above.
- Factor F (Fit) is derived from booleans computed by factors A–E, not
  recomputed independently from raw scores — so a business can never
  be credited for "poor performance" under both B and F using two
  different thresholds.

## Data sources (exact columns)

| Scoring input | Database source |
|---|---|
| `websiteStatus` | `businesses.website_status` |
| `performanceScore` | latest `website_analysis.performance_score` where `analysis_status = 'completed'` |
| `seoScore` | latest `website_analysis.seo_score` where `analysis_status = 'completed'` |
| `accessibilityScore` | latest `website_analysis.accessibility_score` where `analysis_status = 'completed'` |
| `viewportPresent` | latest `website_analysis.viewport_present` where `analysis_status = 'completed'` |
| `googleReviewCount` | `businesses.google_review_count` |

None of these ever come from a request body. See
`server/lib/leadScoringService.js`'s `loadBusinessForScoring` and
`loadLatestCompletedWebsiteAnalysis`.

## Storage

`leads` (extended by `migrations/005_lead_scoring.sql`):

- `lead_score` SMALLINT, `CHECK (lead_score BETWEEN 0 AND 100)` (from
  `001_init_schema.sql`, unchanged)
- `priority` TEXT, `CHECK (priority IN ('low','medium','high','very_high'))`
- `scoring_factors` JSONB — the exact ordered array `leadScoring.js`
  returned, e.g.:

  ```json
  [
    { "code": "unreachable_website", "label": "Website unreachable", "points": 20, "reason": "Verified website_status is \"unreachable\"." },
    { "code": "below_average_performance", "label": "Below-average website performance", "points": 15, "reason": "Verified performance score is 65/100." },
    { "code": "viewport_present", "label": "Mobile viewport tag present", "points": 0, "reason": "Verified homepage analysis found a viewport tag. (The site's mobile performance score is the same measurement already credited under \"Performance\" -- not double-counted here.)" },
    { "code": "strong_seo", "label": "Strong SEO score", "points": 0, "reason": "Verified SEO score is 92/100." },
    { "code": "moderate_accessibility", "label": "Moderate accessibility score", "points": 4, "reason": "Verified accessibility score is 78/100." },
    { "code": "clear_fit", "label": "Clear fit for Alvin Solutions", "points": 10, "reason": "At least one verified technical weakness supports a service opportunity: website is unreachable; sub-par verified performance score." },
    { "code": "established_reviews", "label": "Established Google presence", "points": 4, "reason": "Business has 129 Google reviews." }
  ]
  ```
- `scored_at` TIMESTAMPTZ — when this row was last (re)computed. `NULL`
  = never scored.

**One row per business.** `leads.business_id` has a `UNIQUE` constraint
(added in `005_lead_scoring.sql`); scoring upserts via
`INSERT ... ON CONFLICT (business_id) DO UPDATE`, so `lead_score` /
`priority` / `scoring_factors` / `scored_at` always reflect the most
recent scoring run, while `lead_status` / `sales_notes` /
`estimated_opportunity` (mutable sales-pipeline state, not scoring
inputs) are left untouched on an existing row. See the migration file
for the full rationale, including why this was safe to do (`leads` had
never been written to by any prior phase).

## API

### `POST /api/businesses/:id/lead-score`

Loads the business, its latest completed website analysis, and its
latest AI opportunity analysis (display only) from Neon; calculates a
score; persists it; returns:

```json
{
  "business_id": "069af85d-c1dd-4c04-a653-b6876f356526",
  "lead_score": 58,
  "priority": "high",
  "scoring_factors": [ /* ... */ ],
  "scored_at": "2026-09-22T12:00:00.000Z",
  "ai_analysis": {
    "recommended_service": "website_redesign",
    "reasoning": "...",
    "sales_angle": "...",
    "confidence": 82,
    "status": "completed",
    "created_at": "2026-09-20T09:00:00.000Z"
  }
}
```

`ai_analysis` is `null` if no AI opportunity analysis has ever been run
for this business. Nothing in this object was used to compute
`lead_score`/`priority`.

- 404 if the business doesn't exist.
- 400 if `:id` isn't a syntactically valid UUID.

### `POST /api/businesses/lead-score` (batch)

Body: `{ "limit"?: number }` — default 20, max 50 (same bounds as the
website-check/website-analysis batch endpoints). Scores the oldest
`limit` businesses with bounded concurrency (5 at a time, matching
`BATCH_CONCURRENCY` elsewhere in the codebase). Calls no AI, no Google,
no external API of any kind — scores only from data already in Neon.
One business failing to score never aborts the rest of the batch.

```json
{
  "requested_limit": 20,
  "businesses_found": 20,
  "results": [
    { "business_id": "...", "ok": true, "lead_score": 58, "priority": "high" }
  ]
}
```

## Security / data integrity

- Neither endpoint reads `score`, `priority`, `performance_score`,
  `seo_score`, `website_status`, `google_review_count`, or any other
  scoring-relevant field from the request body. Every value used comes
  from a parameterized `SELECT` against Neon
  (`server/lib/leadScoringService.js`).
- All SQL is parameterized (`$1`, `$2`, ...); nothing is
  string-interpolated into a query.
- No Gemini/Google/PageSpeed API key or credential is read, logged, or
  exposed anywhere in this module.

## Tests

See `server/lib/__tests__/leadScoring.test.js` (pure engine — every
boundary value, missing-data case, and the fixed 30-case list from the
Phase 12 spec) and
`server/lib/__tests__/leadScoringService.test.js` (persistence,
request-body isolation, batch behavior) for the full automated test
suite.
