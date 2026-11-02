const express = require('express');
const pool = require('../db');
const {
  NotFoundError,
  ValidationError,
  isValidUuid,
  checkBusinessById,
  checkBusinessBatch,
} = require('../lib/websiteCheckService');
const {
  NotFoundError: AnalysisNotFoundError,
  ValidationError: AnalysisValidationError,
  analyzeBusiness,
  analyzeBusinessBatch,
  classifyAnalyzedResult,
} = require('../lib/websiteAnalysisService');
const {
  NotFoundError: OpportunityNotFoundError,
  ValidationError: OpportunityValidationError,
  runOpportunityAnalysis,
  classifyAnalysisResult,
} = require('../lib/aiOpportunityAnalysisService');
const {
  NotFoundError: LeadScoreNotFoundError,
  ValidationError: LeadScoreValidationError,
  scoreBusiness,
  scoreBusinessBatch,
  countUnscoredBusinesses,
} = require('../lib/leadScoringService');

const {
  BackfillValidationError,
  backfillInternationalPhones,
} = require('../lib/phoneBackfillService');
const { GooglePlacesError } = require('../lib/googlePlaces');

const router = express.Router();

/**
 * GET /api/businesses
 *
 * Full read-only set of businesses, columns limited to exactly what the
 * frontend's Business type (frontend/src/types/index.ts) uses. Filtering,
 * sorting, and pagination are handled client-side in BusinessesTable.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        external_place_id,
        name,
        category,
        phone,
        email,
        address,
        city,
        country,
        latitude,
        longitude,
        google_maps_url,
        google_rating,
        google_review_count,
        website_url,
        website_status,
        website_checked_at,
        created_at,
        updated_at
      FROM businesses
      ORDER BY created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/businesses/backfill-international-phone
 *
 * Body: { limit?: number } -- 1..200, default 25. Fills
 * businesses.international_phone (Google Place Details) for businesses
 * that have a phone but no international number, so existing data
 * doesn't need searches re-run. Each business is one billed Google
 * request, hence the limit; concurrency is bounded and a business is
 * never asked twice (see server/lib/phoneBackfillService.js).
 *
 * Returns: { requested_limit, businesses_found, updated, no_number,
 *            failed, stopped_early, remaining_estimate }
 */
router.post('/backfill-international-phone', async (req, res, next) => {
  try {
    const summary = await backfillInternationalPhones(pool, req.body || {});
    res.json(summary);
  } catch (err) {
    if (err instanceof BackfillValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof GooglePlacesError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/website-check
 *
 * Body: { limit?: number } -- bounded (see websiteCheckService.BATCH_LIMIT),
 * defaults to 20 when omitted. Checks a batch of businesses that have
 * never been checked before (oldest-created first), with bounded
 * concurrency so this never fires an unbounded number of simultaneous
 * outbound requests. Every URL used comes from each business's own
 * stored `website_url` -- the request body never supplies one.
 *
 * IMPORTANT: this route is registered before "/:id/website-check" only
 * for readability; the two never actually collide, since one matches a
 * single path segment ("website-check") and the other requires two
 * ("<id>/website-check").
 *
 * Returns: { checked, reachable, unreachable, no_website, unknown }
 */
router.post('/website-check', async (req, res, next) => {
  try {
    const counts = await checkBusinessBatch(pool, req.body || {});
    res.json(counts);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/:id/website-check
 *
 * Loads the business by id from Neon, runs the existing safe website
 * checker (server/lib/httpChecker.js) against ONLY that business's
 * stored `website_url`, updates website_status/website_checked_at, and
 * returns the result. The request body/query is never used as a
 * source of a URL to check -- there is no way for the caller to make
 * this endpoint check an arbitrary address.
 *
 * Returns: { id, name, website_url, website_status, website_checked_at, http_status }
 */
router.post('/:id/website-check', async (req, res, next) => {
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid business id.' });
  }

  try {
    const { business, httpStatus } = await checkBusinessById(pool, id);
    res.json({
      id: business.id,
      name: business.name,
      website_url: business.website_url,
      website_status: business.website_status,
      website_checked_at: business.website_checked_at,
      http_status: httpStatus,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: 'Business not found.' });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/website-analysis
 *
 * Body: { limit?: number } -- same bounds as the website-check batch
 * (default 20, max 50). Runs a Phase 10B homepage analysis for a
 * bounded batch of businesses whose website_status is currently
 * 'reachable', oldest-created first, with bounded concurrency (see
 * websiteAnalysisService.BATCH_CONCURRENCY). One business's analysis
 * failing never aborts the rest of the batch -- see per-business
 * `results`.
 *
 * IMPORTANT: registered before "/:id/website-analysis" only for
 * readability, exactly like the website-check pair above -- the two
 * routes never actually collide.
 *
 * Returns: { requested_limit, businesses_found, results: [{ business_id, ok, analysis_status, error_code }] }
 */
router.post('/website-analysis', async (req, res, next) => {
  try {
    const result = await analyzeBusinessBatch(pool, req.body || {});
    res.json(result);
  } catch (err) {
    if (err instanceof AnalysisValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/:id/website-analysis
 *
 * Runs a Phase 10B homepage-only analysis for ONE business, using
 * ONLY that business's already-stored `website_url` -- the request
 * body/query is never used as a source of a URL to analyze, and the
 * business must already be marked 'reachable' (by Phase 9's website
 * check) before any analysis is attempted. Every successful analysis
 * attempt is persisted as a new row in `website_analysis`; previous
 * analyses for the same business are never overwritten.
 *
 * Returns the stored website_analysis row (whatever its outcome), with
 * an HTTP status chosen by websiteAnalysisService.classifyAnalyzedResult:
 * 200 for a normal recorded outcome, 429 if PageSpeed Insights is being
 * rate limited, 503 if the target site or the PageSpeed service
 * couldn't be reached at all right now.
 *
 * A business with no website on file, or whose website isn't currently
 * marked reachable, gets a clear, distinct response instead (400 / 409)
 * -- no analysis is attempted and no row is written for those cases.
 */
router.post('/:id/website-analysis', async (req, res, next) => {
  const { id } = req.params;

  try {
    const result = await analyzeBusiness(pool, id);

    if (result.outcome === 'no_website') {
      return res.status(400).json({
        error: 'This business has no website on file.',
        business_id: result.business.id,
        website_status: result.business.website_status,
      });
    }

    if (result.outcome === 'not_reachable') {
      return res.status(409).json({
        error: "This business's website is not currently marked reachable.",
        business_id: result.business.id,
        website_status: result.business.website_status,
      });
    }

    const { httpStatus } = classifyAnalyzedResult(result.row);
    res.status(httpStatus).json(result.row);
  } catch (err) {
    if (err instanceof AnalysisNotFoundError) {
      return res.status(404).json({ error: 'Business not found.' });
    }
    if (err instanceof AnalysisValidationError) {
      return res.status(400).json({ error: 'Invalid business id.' });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/:id/opportunity-analysis
 *
 * Phase 11B. Runs an AI opportunity analysis for ONE business, using
 * ONLY that business's already-stored data (business fields + its
 * latest website_analysis row) -- the request body is never read as a
 * source of business facts or website metrics; the client supplies
 * nothing but the business id in the URL. Every call inserts a NEW
 * historical row into `ai_analysis`; a previous analysis for the same
 * business is never overwritten.
 *
 * Returns the persisted ai_analysis row, with an HTTP status chosen by
 * aiOpportunityAnalysisService.classifyAnalysisResult: 200 for a
 * normal recorded outcome (including a safely-rejected malformed/
 * hallucinated model response, which is still stored with
 * status: 'failed' for audit), 429 if Gemini is being rate limited,
 * 503 if Gemini (or GEMINI_API_KEY) isn't currently usable.
 */
router.post('/:id/opportunity-analysis', async (req, res, next) => {
  const { id } = req.params;

  try {
    const row = await runOpportunityAnalysis(pool, id);
    const { httpStatus } = classifyAnalysisResult(row);
    res.status(httpStatus).json(row);
  } catch (err) {
    if (err instanceof OpportunityNotFoundError) {
      return res.status(404).json({ error: 'Business not found.' });
    }
    if (err instanceof OpportunityValidationError) {
      return res.status(400).json({ error: 'Invalid business id.' });
    }
    next(err);
  }
});

/**
 * POST /api/businesses/lead-score
 *
 * Phase 12. Body: { limit?: number, only_unscored?: boolean } -- `limit`
 * has the same bounds as the other batch endpoints (default 20, max
 * 50). Deterministically (re)scores a bounded batch of businesses,
 * oldest-created first, with bounded concurrency. Never calls AI, never
 * calls Google, never calls any external API -- scores only from data
 * already stored in Neon.
 *
 * By default the batch is the oldest `limit` businesses whether or not
 * they already have a lead, so repeated calls re-score the same ones.
 * `only_unscored: true` restricts it to businesses with no `leads` row
 * (never scored) -- strict boolean, anything else is a 400.
 *
 * IMPORTANT: registered before "/:id/lead-score" only for readability,
 * exactly like the website-check/website-analysis pairs above -- the
 * two routes never actually collide.
 *
 * Returns: { requested_limit, businesses_found, results: [{ business_id, ok, lead_score, priority }] }
 */
router.post('/lead-score', async (req, res, next) => {
  try {
    const result = await scoreBusinessBatch(pool, req.body || {});
    res.json(result);
  } catch (err) {
    if (err instanceof LeadScoreValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * GET /api/businesses/unscored-count
 *
 * How many businesses have never been scored (no `leads` row) -- exactly
 * the set POST /api/businesses/lead-score selects with
 * `{ only_unscored: true }`.
 *
 * Returns: { unscored_count }
 */
router.get('/unscored-count', async (req, res, next) => {
  try {
    const unscoredCount = await countUnscoredBusinesses(pool);
    res.json({ unscored_count: unscoredCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/businesses/:id/lead-score
 *
 * Phase 12. Deterministically (re)calculates ONE business's lead score
 * from data already verified and stored in Neon (businesses,
 * website_analysis, ai_analysis) -- the request body is never read as a
 * source of scoring facts. AI opportunity analysis (if any) is included
 * in the response purely as accompanying sales intelligence; it never
 * influences lead_score/priority.
 *
 * Persists lead_score, priority, scoring_factors, and scored_at on the
 * business's single `leads` row (created if it doesn't exist yet; see
 * migrations/005_lead_scoring.sql).
 *
 * Returns: { business_id, lead_score, priority, scoring_factors, scored_at, ai_analysis }
 */
router.post('/:id/lead-score', async (req, res, next) => {
  const { id } = req.params;

  try {
    const result = await scoreBusiness(pool, id);
    res.json(result);
  } catch (err) {
    if (err instanceof LeadScoreNotFoundError) {
      return res.status(404).json({ error: 'Business not found.' });
    }
    if (err instanceof LeadScoreValidationError) {
      return res.status(400).json({ error: 'Invalid business id.' });
    }
    next(err);
  }
});

module.exports = router;
