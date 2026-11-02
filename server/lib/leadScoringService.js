/**
 * Orchestrates POST /api/businesses/:id/lead-score and the batch
 * variant (Phase 12).
 *
 * Deliberately decoupled from Express, mirroring
 * websiteAnalysisService.js / aiOpportunityAnalysisService.js:
 * server/routes/businesses.js is a thin HTTP wrapper around what's
 * exported here.
 *
 * This module owns ALL database access for scoring. It never accepts
 * scoring inputs (performance_score, seo_score, website_status, review
 * counts, ...) from a request body or any caller-supplied argument --
 * every fact used to compute a score is read directly from Neon inside
 * this module. The actual scoring RULES live in the pure,
 * database-free server/lib/leadScoring.js and are reused as-is.
 */

'use strict';

const { calculateLeadScore } = require('./leadScoring');
const { isValidUuid, BATCH_LIMIT, BATCH_CONCURRENCY, resolveBatchLimit, runWithConcurrency } = require('./websiteCheckService');

/** Thrown when a business id doesn't match any row. */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown for a malformed request (bad UUID, out-of-range batch limit). */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------
// 1. Load verified data from Neon
// ---------------------------------------------------------------------

/**
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>}
 */
async function loadBusinessForScoring(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT id, name, website_status, google_review_count
      FROM businesses
      WHERE id = $1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * Only the LATEST website_analysis row whose analysis_status is
 * 'completed' is ever used -- a 'failed'/'blocked'/'timeout'/
 * 'rate_limited'/'unavailable' attempt is never treated as if it were
 * a real (possibly zero) score. Individual *_score columns can still
 * be NULL within a 'completed' row (PageSpeed Insights itself can fail
 * independently of the homepage fetch) -- leadScoring.js already
 * treats a null score as "unknown", never as 0.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>}
 */
async function loadLatestCompletedWebsiteAnalysis(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT performance_score, seo_score, accessibility_score, viewport_present, analyzed_at
      FROM website_analysis
      WHERE business_id = $1 AND analysis_status = 'completed'
      ORDER BY analyzed_at DESC
      LIMIT 1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * Latest AI opportunity analysis, if any -- for DISPLAY alongside the
 * score only (Section 10 of the spec). Never read by leadScoring.js and
 * never passed into calculateLeadScore.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>}
 */
async function loadLatestAiAnalysis(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT recommended_service, reasoning, sales_angle, confidence, status, created_at
      FROM ai_analysis
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * Flattens verified rows into exactly the shape leadScoring.js expects.
 * Deliberately never invents a value: anything not actually known
 * (business missing, no completed analysis, a null column within a
 * completed analysis) comes through as `null`.
 *
 * @param {object} business - from loadBusinessForScoring
 * @param {object|null} analysis - from loadLatestCompletedWebsiteAnalysis
 * @returns {import('./leadScoring').LeadScoringInput}
 */
function buildScoringInput(business, analysis) {
  return {
    websiteStatus: business.website_status ?? null,
    performanceScore: analysis && analysis.performance_score !== null && analysis.performance_score !== undefined
      ? Number(analysis.performance_score)
      : null,
    seoScore: analysis && analysis.seo_score !== null && analysis.seo_score !== undefined
      ? Number(analysis.seo_score)
      : null,
    accessibilityScore: analysis && analysis.accessibility_score !== null && analysis.accessibility_score !== undefined
      ? Number(analysis.accessibility_score)
      : null,
    viewportPresent: analysis ? analysis.viewport_present ?? null : null,
    googleReviewCount: business.google_review_count === null || business.google_review_count === undefined
      ? null
      : Number(business.google_review_count),
  };
}

// ---------------------------------------------------------------------
// 2. Persist the result -- one row per business (see migrations/005)
// ---------------------------------------------------------------------

/**
 * Upserts lead_score/priority/scoring_factors/scored_at for a
 * business's single `leads` row, creating it if none exists yet.
 * lead_status/sales_notes/estimated_opportunity are left untouched on
 * an existing row (they are not scoring concerns) and take their
 * table defaults on a freshly-created row.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @param {import('./leadScoring').LeadScoringResult} result
 * @returns {Promise<object>} the persisted leads row
 */
async function persistLeadScore(pool, businessId, result) {
  const { rows } = await pool.query(
    `
      INSERT INTO leads (business_id, lead_score, priority, scoring_factors, scored_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (business_id) DO UPDATE
        SET lead_score      = EXCLUDED.lead_score,
            priority        = EXCLUDED.priority,
            scoring_factors = EXCLUDED.scoring_factors,
            scored_at       = EXCLUDED.scored_at
      RETURNING *
    `,
    [businessId, result.score, result.priority, JSON.stringify(result.factors)]
  );
  return rows[0];
}

// ---------------------------------------------------------------------
// 3. Single-business orchestration
// ---------------------------------------------------------------------

/**
 * Full Phase 12 orchestration for one business:
 *   1. load the business (verified website_status/google_review_count)
 *   2. load its latest COMPLETED website analysis, if any
 *   3. load its latest AI opportunity analysis, if any (display only)
 *   4. build the verified scoring input (never from the request body)
 *   5. run the deterministic engine
 *   6. persist lead_score/priority/scoring_factors/scored_at
 *   7. return { business_id, lead_score, priority, scoring_factors, scored_at, ai_analysis }
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<{
 *   business_id: string,
 *   lead_score: number,
 *   priority: string,
 *   scoring_factors: Array<object>,
 *   scored_at: string,
 *   ai_analysis: object|null,
 * }>}
 * @throws {ValidationError} if businessId isn't a syntactically valid UUID
 * @throws {NotFoundError} if no business has that id
 */
async function scoreBusiness(pool, businessId) {
  if (!isValidUuid(businessId)) {
    throw new ValidationError('businessId must be a valid UUID.');
  }

  const business = await loadBusinessForScoring(pool, businessId);
  if (!business) {
    throw new NotFoundError(`No business found with id ${businessId}`);
  }

  const analysis = await loadLatestCompletedWebsiteAnalysis(pool, businessId);
  const aiAnalysis = await loadLatestAiAnalysis(pool, businessId);

  const input = buildScoringInput(business, analysis);
  const result = calculateLeadScore(input);

  const lead = await persistLeadScore(pool, businessId, result);

  return {
    business_id: businessId,
    lead_score: lead.lead_score,
    priority: lead.priority,
    scoring_factors: lead.scoring_factors,
    scored_at: lead.scored_at,
    ai_analysis: aiAnalysis,
  };
}

// ---------------------------------------------------------------------
// 4. Batch orchestration
// ---------------------------------------------------------------------

/**
 * SQL predicate for "this business has never been scored": it has no
 * `leads` row. persistLeadScore() is the only code that creates `leads`
 * rows, so no row means no score. `b` is the businesses alias; `leads`
 * has a UNIQUE index on business_id (migration 005), so this is cheap.
 */
const UNSCORED_BUSINESS_PREDICATE = 'NOT EXISTS (SELECT 1 FROM leads l WHERE l.business_id = b.id)';

/**
 * Validates the batch endpoint's optional `only_unscored` flag. A strict
 * boolean, never coerced ("false" or 0 would otherwise silently mean
 * true/false by accident); omitted or null means the default, false.
 *
 * @param {unknown} raw
 * @returns {boolean}
 * @throws {ValidationError}
 */
function resolveOnlyUnscored(raw) {
  if (raw === undefined || raw === null) {
    return false;
  }
  if (typeof raw !== 'boolean') {
    throw new ValidationError('"only_unscored" must be a boolean.');
  }
  return raw;
}

/**
 * How many businesses have never been scored (no `leads` row). Backs the
 * Leads page's "Score new businesses" button.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<number>}
 */
async function countUnscoredBusinesses(pool) {
  const { rows } = await pool.query(
    `
      SELECT COUNT(*)::int AS unscored_count
      FROM businesses b
      WHERE ${UNSCORED_BUSINESS_PREDICATE}
    `
  );
  return rows[0] ? Number(rows[0].unscored_count) : 0;
}

/**
 * Scores a bounded batch of businesses, oldest-created first, with
 * bounded concurrency (mirrors websiteAnalysisService.analyzeBusinessBatch).
 * One business's scoring throwing (e.g. a database error persisting its
 * row) is recorded as a per-item failure and never aborts the rest of
 * the batch. Never calls AI, never calls Google, never calls any
 * external API -- every value used is already sitting in Neon.
 *
 * By default the batch is the oldest `limit` businesses, whether or not
 * they already have a score -- so repeated runs re-score the same
 * oldest businesses. With `only_unscored: true` it is instead the
 * oldest `limit` businesses that have no `leads` row, so each run moves
 * on to businesses that were never scored.
 *
 * @param {{query: Function}} pool
 * @param {{limit?: unknown, only_unscored?: unknown}} [body]
 * @returns {Promise<{
 *   requested_limit: number,
 *   businesses_found: number,
 *   results: Array<{ business_id: string, ok: boolean, lead_score: number|null, priority: string|null }>,
 * }>}
 * @throws {ValidationError} if body.limit is out of bounds or body.only_unscored isn't a boolean
 */
async function scoreBusinessBatch(pool, body = {}) {
  // resolveBatchLimit throws websiteCheckService's own ValidationError
  // class (same name, different prototype than the one this module
  // exports above) -- normalize it here, exactly like
  // websiteAnalysisService.js's analyzeBusinessBatch does, so every
  // ValidationError a caller of THIS module can catch is one class.
  let limit;
  try {
    limit = resolveBatchLimit(body.limit);
  } catch (err) {
    throw new ValidationError(err.message);
  }

  const onlyUnscored = resolveOnlyUnscored(body.only_unscored);

  // The default query is deliberately left exactly as it was.
  const { rows: businesses } = onlyUnscored
    ? await pool.query(
        `
          SELECT b.id
          FROM businesses b
          WHERE ${UNSCORED_BUSINESS_PREDICATE}
          ORDER BY b.created_at ASC
          LIMIT $1
        `,
        [limit]
      )
    : await pool.query(
        `
          SELECT id
          FROM businesses
          ORDER BY created_at ASC
          LIMIT $1
        `,
        [limit]
      );

  const results = [];

  await runWithConcurrency(
    businesses,
    async (business) => {
      try {
        const scored = await scoreBusiness(pool, business.id);
        results.push({
          business_id: business.id,
          ok: true,
          lead_score: scored.lead_score,
          priority: scored.priority,
        });
      } catch (err) {
        console.error('[lead-score batch]', business.id, err.message);
        results.push({
          business_id: business.id,
          ok: false,
          lead_score: null,
          priority: null,
        });
      }
    },
    BATCH_CONCURRENCY
  );

  return {
    requested_limit: limit,
    businesses_found: businesses.length,
    results,
  };
}

module.exports = {
  NotFoundError,
  ValidationError,
  BATCH_LIMIT,
  BATCH_CONCURRENCY,
  loadBusinessForScoring,
  loadLatestCompletedWebsiteAnalysis,
  loadLatestAiAnalysis,
  buildScoringInput,
  persistLeadScore,
  resolveOnlyUnscored,
  countUnscoredBusinesses,
  scoreBusiness,
  scoreBusinessBatch,
};
