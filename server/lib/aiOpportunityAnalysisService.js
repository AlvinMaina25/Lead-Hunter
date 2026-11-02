/**
 * Orchestrates POST /api/businesses/:id/opportunity-analysis (Phase 11B).
 *
 * Deliberately decoupled from Express, mirroring
 * websiteAnalysisService.js: server/routes/businesses.js is a thin HTTP
 * wrapper around what's exported here.
 *
 * This module does not re-implement analysis -- all of that (building
 * the verified snapshot, calling Gemini, structural validation,
 * anti-hallucination filtering, persistence) lives in
 * server/lib/aiOpportunityAnalysis.js and is reused as-is. This
 * module's only job is turning a persisted ai_analysis row into an
 * HTTP-appropriate status code, the same way classifyAnalyzedResult
 * does for website_analysis.
 */

'use strict';

const {
  ANALYSIS_STATUS,
  NotFoundError,
  ValidationError,
  analyzeBusinessOpportunity,
} = require('./aiOpportunityAnalysis');

/**
 * Maps a persisted ai_analysis row's `status` to an HTTP status code.
 * The row itself is always the response body -- this never hides a
 * stored result, it only chooses which status line best describes the
 * outcome:
 *
 *   - 'rate_limited' -> 429 (Gemini itself reported rate limiting)
 *   - 'timeout' / 'unavailable' -> 503 (Gemini, or its configuration,
 *     wasn't reachable/usable right now)
 *   - everything else ('completed', or a 'failed' analysis that was
 *     nonetheless safely recorded -- malformed model output or an
 *     anti-hallucination rejection) -> 200: the request was handled
 *     and an analysis attempt was genuinely recorded, even when that
 *     record says the analysis itself didn't produce usable output.
 *
 * @param {{status: string}} row
 * @returns {{ httpStatus: number }}
 */
function classifyAnalysisResult(row) {
  if (row.status === ANALYSIS_STATUS.RATE_LIMITED) {
    return { httpStatus: 429 };
  }
  if (row.status === ANALYSIS_STATUS.TIMEOUT || row.status === ANALYSIS_STATUS.UNAVAILABLE) {
    return { httpStatus: 503 };
  }
  return { httpStatus: 200 };
}

/**
 * @param {{query: Function}} pool
 * @param {string} id
 * @param {object} [options] - forwarded to analyzeBusinessOpportunity (tests only)
 * @returns {Promise<object>} the persisted ai_analysis row
 * @throws {ValidationError} if id isn't a syntactically valid UUID
 * @throws {NotFoundError} if no business has that id
 */
async function runOpportunityAnalysis(pool, id, options = {}) {
  return analyzeBusinessOpportunity(pool, id, options);
}

module.exports = {
  NotFoundError,
  ValidationError,
  classifyAnalysisResult,
  runOpportunityAnalysis,
};
