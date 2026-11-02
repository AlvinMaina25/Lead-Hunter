/**
 * Orchestrates POST /api/businesses/:id/website-analysis and the
 * optional batch variant (Phase 10B).
 *
 * Deliberately decoupled from Express, mirroring websiteCheckService.js:
 * server/routes/businesses.js is a thin HTTP wrapper around the
 * functions exported here, and both `pool` and any engine overrides are
 * passed in as parameters rather than required at module load time, so
 * this module can be unit tested with a fake pool and fake network
 * layer -- no real Neon connection and no real outbound requests.
 *
 * This module does NOT re-implement analysis. All of that (SSRF
 * gating, the homepage fetch, PageSpeed Insights, and persisting a row
 * to `website_analysis`) already lives in server/lib/websiteAnalysis.js
 * (Phase 10A) and is reused as-is. This module's entire job is the
 * piece Phase 10A deliberately left undone: deciding, from a business's
 * *current* `website_url` / `website_status`, whether an analysis
 * attempt should even be made (steps 5-7 of the Phase 10B spec), and
 * turning a stored analysis row into an HTTP-appropriate outcome.
 *
 * SECURITY: exactly like websiteCheckService.js, a caller can never
 * pass in a URL here. Every function below either takes just a business
 * id (and re-reads website_url from Neon) or a batch `limit`; there is
 * no parameter anywhere in this module's public API through which a
 * client-supplied URL could reach the analysis engine.
 */

'use strict';

const {
  ANALYSIS_STATUS,
  NotFoundError,
  ValidationError,
  loadBusiness,
  analyzeBusinessWebsite,
} = require('./websiteAnalysis');
const { isValidUuid, BATCH_LIMIT, BATCH_CONCURRENCY, resolveBatchLimit, runWithConcurrency } = require('./websiteCheckService');

/** Outcomes this module can report WITHOUT ever calling the Phase 10A engine. */
const PRECHECK_OUTCOME = Object.freeze({
  NO_WEBSITE: 'no_website',
  NOT_REACHABLE: 'not_reachable',
});

/**
 * Loads a business and decides -- purely from its current, already-
 * stored `website_url` / `website_status` -- whether it's eligible for
 * analysis. Never makes a network request and never calls the Phase
 * 10A engine; this is intentionally cheap so an ineligible business
 * never even reaches analyzeBusinessWebsite (and therefore never has an
 * analysis row written for it).
 *
 * @param {{query: Function}} pool
 * @param {string} id - already validated as a syntactic UUID by the caller
 * @returns {Promise<
 *   | { eligible: true, business: object }
 *   | { eligible: false, outcome: string, business: object }
 * >}
 * @throws {NotFoundError} if no business has that id
 */
async function checkEligibility(pool, id) {
  const business = await loadBusiness(pool, id);
  if (!business) {
    throw new NotFoundError(`No business found with id ${id}`);
  }

  if (!business.website_url) {
    return { eligible: false, outcome: PRECHECK_OUTCOME.NO_WEBSITE, business };
  }

  if (business.website_status !== 'reachable') {
    return { eligible: false, outcome: PRECHECK_OUTCOME.NOT_REACHABLE, business };
  }

  return { eligible: true, business };
}

/**
 * Full Phase 10B orchestration for a single business:
 *
 *   1-2. validate the id, load the business
 *   3-4. (structurally guaranteed) only ever uses business.website_url --
 *        there is no parameter here through which a caller could supply
 *        their own URL
 *   5-7. gate eligibility: no website -> 'no_website'; website present
 *        but not currently reachable -> 'not_reachable'; neither case
 *        calls the engine or writes a row
 *   8-11. otherwise, call the Phase 10A engine, which performs the
 *        homepage-only analysis and persists exactly one new row
 *
 * @param {{query: Function}} pool
 * @param {string} id
 * @param {object} [engineOptions] - forwarded verbatim to
 *   analyzeBusinessWebsite (e.g. fetchHomepage/fetchPageSpeed overrides
 *   for tests). Never sourced from request input in production use --
 *   see server/routes/businesses.js, which always calls this with no
 *   third argument.
 * @returns {Promise<
 *   | { outcome: 'no_website', business: object }
 *   | { outcome: 'not_reachable', business: object }
 *   | { outcome: 'analyzed', row: object }
 * >}
 * @throws {ValidationError} if id isn't a syntactically valid UUID
 * @throws {NotFoundError} if no business has that id
 */
async function analyzeBusiness(pool, id, engineOptions = {}) {
  if (!isValidUuid(id)) {
    throw new ValidationError('businessId must be a valid UUID.');
  }

  const eligibility = await checkEligibility(pool, id);
  if (!eligibility.eligible) {
    return { outcome: eligibility.outcome, business: eligibility.business };
  }

  const row = await analyzeBusinessWebsite(pool, id, engineOptions);
  return { outcome: 'analyzed', row };
}

/**
 * Maps a persisted website_analysis row to an HTTP status code. The
 * row itself is always the response body (whatever code is chosen) --
 * this never rewrites or hides a stored result, it only decides which
 * status line best describes the outcome to an HTTP client:
 *
 *   - the homepage fetch itself couldn't reach the target at all
 *     (analysis_status 'unavailable' -- DNS failure, connection refused,
 *     too many redirects, an unusable stored URL, ...) -> 503
 *   - PageSpeed Insights specifically reported it's being rate limited
 *     -> 429 (the homepage half of the analysis still completed and is
 *     still in the row; only the PSI scores are missing)
 *   - PageSpeed Insights itself couldn't be reached at all (network
 *     failure, or PAGESPEED_API_KEY isn't configured) -> 503, same
 *     reasoning as the homepage case: the analysis *service* was
 *     unavailable, even though the target business's site itself may
 *     be fine
 *   - every other outcome -- completed, or a homepage-level 'failed' /
 *     'blocked' / 'timeout' that nonetheless produced a real, stored
 *     result -- is a normal 200: the request was handled and an
 *     analysis attempt was genuinely recorded, even when that record
 *     says the site itself didn't respond well
 *
 * @param {object} row - a website_analysis row, as returned by
 *   analyzeBusinessWebsite / saveWebsiteAnalysis
 * @returns {{ httpStatus: number }}
 */
function classifyAnalyzedResult(row) {
  if (row.analysis_status === ANALYSIS_STATUS.UNAVAILABLE) {
    return { httpStatus: 503 };
  }

  const pagespeed = row.raw_analysis_response && row.raw_analysis_response.pagespeed;
  if (pagespeed) {
    if (pagespeed.status === 'rate_limited') {
      return { httpStatus: 429 };
    }
    if (pagespeed.status === 'unavailable') {
      return { httpStatus: 503 };
    }
  }

  return { httpStatus: 200 };
}

/**
 * Analyzes a bounded batch of businesses whose website_status is
 * currently 'reachable', oldest-created first, with bounded concurrency
 * so this never fires many simultaneous outbound requests at once. Each
 * business is analyzed independently: one business's analysis throwing
 * (e.g. a database error persisting its row) is recorded as a per-item
 * failure and never aborts the rest of the batch.
 *
 * Every business still gets its own new historical row via
 * analyzeBusinessWebsite -- this function never overwrites a previous
 * analysis.
 *
 * @param {{query: Function}} pool
 * @param {{limit?: unknown}} [body]
 * @param {object} [engineOptions] - forwarded to analyzeBusinessWebsite
 *   for every business in the batch (tests only; see analyzeBusiness).
 * @returns {Promise<{
 *   requested_limit: number,
 *   businesses_found: number,
 *   results: Array<{
 *     business_id: string,
 *     ok: boolean,
 *     analysis_status: string|null,
 *     error_code: string|null,
 *   }>,
 * }>}
 * @throws {ValidationError} if body.limit is out of bounds
 */
async function analyzeBusinessBatch(pool, body = {}, engineOptions = {}) {
  // resolveBatchLimit throws websiteCheckService's own ValidationError
  // class (same name, different prototype than the one this module
  // re-exports from websiteAnalysis.js) -- normalize it here so every
  // ValidationError a caller of THIS module can catch is one class.
  let limit;
  try {
    limit = resolveBatchLimit(body.limit);
  } catch (err) {
    throw new ValidationError(err.message);
  }

  const { rows: businesses } = await pool.query(
    `
      SELECT id
      FROM businesses
      WHERE website_status = 'reachable'
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
        const row = await analyzeBusinessWebsite(pool, business.id, engineOptions);
        results.push({
          business_id: business.id,
          ok: true,
          analysis_status: row.analysis_status,
          error_code: row.error_code,
        });
      } catch (err) {
        // A single business failing to analyze/persist (e.g. a
        // database error on its INSERT) must never abort the batch --
        // record it and keep going.
        console.error('[website-analysis batch]', business.id, err.message);
        results.push({
          business_id: business.id,
          ok: false,
          analysis_status: null,
          error_code: 'ANALYSIS_ERROR',
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
  PRECHECK_OUTCOME,
  NotFoundError,
  ValidationError,
  BATCH_LIMIT,
  BATCH_CONCURRENCY,
  checkEligibility,
  analyzeBusiness,
  classifyAnalyzedResult,
  analyzeBusinessBatch,
};
