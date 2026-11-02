/**
 * Orchestrates GET /api/analytics (Phase 21 Part 1).
 *
 * Deliberately decoupled from Express, mirroring
 * leadScoringService.js / leadDetailService.js /
 * salesIntelligenceService.js: server/routes/analytics.js is a thin
 * HTTP wrapper around what's exported here.
 *
 * This module owns ALL database access for analytics. It issues a
 * small, FIXED number of aggregate SQL queries (five, run
 * concurrently) regardless of how many businesses/leads exist --
 * never one query per business/lead (no N+1), and never loads the
 * full businesses/leads/sales_pipeline tables into JavaScript to
 * count them by hand. Every query either returns a single aggregate
 * row (COUNT/COUNT FILTER) or a small, bounded-cardinality breakdown
 * (GROUP BY a column with at most a handful of distinct values, e.g.
 * leads.priority or sales_pipeline.stage).
 *
 * The one exception is loadLatestCompletedAnalysisScores, which
 * returns one row per business that has ever had a COMPLETED
 * website_analysis attempt (via DISTINCT ON, computed by Postgres,
 * not by loading every analysis attempt into JS). This is still not
 * "every business" -- only businesses with a successful analysis are
 * returned -- and is needed because "poor website" is a per-business
 * classification (see analytics.js#isPoorWebsiteAnalysis) that SQL
 * alone cannot express as a single boolean column without
 * duplicating that classification logic in SQL and in JS. Keeping the
 * classification in one place (the pure, unit-tested
 * isPoorWebsiteAnalysis) mirrors this codebase's existing
 * leadScoring.js pattern: DB-loading and business-rule logic stay in
 * separate, independently testable modules.
 *
 * This module never mutates any data -- GET /api/analytics is
 * strictly read-only.
 */

'use strict';

const { isPoorWebsiteAnalysis, buildAnalyticsResponse } = require('./analytics');

// ---------------------------------------------------------------------
// 1. Load aggregate data from Neon
// ---------------------------------------------------------------------

/**
 * businesses_discovered and no_website_businesses in one query.
 *
 * businesses_discovered is COUNT(*) FROM businesses, not a count of
 * search_results rows or a sum of searches.results_count -- a
 * business found by multiple searches still has exactly one row in
 * `businesses` (external_place_id is UNIQUE, enforced by
 * migrations/001_init_schema.sql, and search_results is only a join
 * table between searches and businesses), so this can never
 * double-count a business that multiple searches happened to surface.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<{businesses_discovered: number, no_website_businesses: number}>}
 */
async function loadBusinessCounts(pool) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS businesses_discovered,
      COUNT(*) FILTER (WHERE website_status = 'no_website')::int AS no_website_businesses
    FROM businesses
  `);
  return rows[0];
}

/**
 * One row per business that has at least one COMPLETED
 * website_analysis row -- the LATEST such row only (DISTINCT ON ...
 * ORDER BY business_id, analyzed_at DESC), mirroring the exact
 * "latest completed analysis" contract already used by
 * leadScoringService.js#loadLatestCompletedWebsiteAnalysis and
 * leadDetailService.js. A 'failed'/'blocked'/'timeout'/'rate_limited'/
 * 'unavailable' attempt is never treated as if it were a real
 * (possibly poor) score.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<Array<{business_id: string, performance_score: number|null, seo_score: number|null, accessibility_score: number|null, best_practices_score: number|null}>>}
 */
async function loadLatestCompletedAnalysisScores(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (business_id)
      business_id, performance_score, seo_score, accessibility_score, best_practices_score
    FROM website_analysis
    WHERE analysis_status = 'completed'
    ORDER BY business_id, analyzed_at DESC
  `);
  return rows;
}

/**
 * @param {{query: Function}} pool
 * @returns {Promise<Array<{priority: string, count: number}>>}
 */
async function loadLeadPriorityBreakdown(pool) {
  const { rows } = await pool.query(`
    SELECT priority, COUNT(*)::int AS count
    FROM leads
    GROUP BY priority
  `);
  return rows;
}

/**
 * A lead with no sales_pipeline row yet is counted under 'new', the
 * same virtual-default contract server/routes/dashboard.js and
 * leadDetailService.js already use.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<Array<{stage: string, count: number}>>}
 */
async function loadPipelineStageBreakdown(pool) {
  const { rows } = await pool.query(`
    SELECT COALESCE(sp.stage, 'new') AS stage, COUNT(*)::int AS count
    FROM leads l
    LEFT JOIN sales_pipeline sp ON sp.lead_id = l.id
    GROUP BY COALESCE(sp.stage, 'new')
  `);
  return rows;
}

/**
 * @param {{query: Function}} pool
 * @returns {Promise<Array<{website_status: string, count: number}>>}
 */
async function loadWebsiteStatusBreakdown(pool) {
  const { rows } = await pool.query(`
    SELECT website_status, COUNT(*)::int AS count
    FROM businesses
    GROUP BY website_status
  `);
  return rows;
}

// ---------------------------------------------------------------------
// 2. Orchestration
// ---------------------------------------------------------------------

/**
 * Full Phase 21 Part 1 read. An empty database (no businesses, no
 * leads) returns valid zero values for every metric -- every query
 * above is an aggregate that returns 0/empty rather than erroring on
 * an empty table, and analytics.js's pure functions treat empty
 * breakdown arrays as "nothing to add", never as an error.
 *
 * A real database error (connection failure, malformed query) is
 * never swallowed here -- it propagates to the caller (see
 * server/routes/analytics.js), which forwards it to the centralized
 * error handler in server/app.js, exactly like every other route.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<{
 *   metrics: import('./analytics').AnalyticsMetrics,
 *   lead_priority_breakdown: Record<string, number>,
 *   pipeline_stage_breakdown: Record<string, number>,
 *   website_status_breakdown: Record<string, number>,
 * }>}
 */
async function getAnalytics(pool) {
  const [
    businessCounts,
    analysisScores,
    leadPriorityBreakdown,
    pipelineStageBreakdown,
    websiteStatusBreakdown,
  ] = await Promise.all([
    loadBusinessCounts(pool),
    loadLatestCompletedAnalysisScores(pool),
    loadLeadPriorityBreakdown(pool),
    loadPipelineStageBreakdown(pool),
    loadWebsiteStatusBreakdown(pool),
  ]);

  const poorWebsiteBusinesses = analysisScores.filter(isPoorWebsiteAnalysis).length;

  return buildAnalyticsResponse({
    businessesDiscovered: businessCounts.businesses_discovered,
    noWebsiteBusinesses: businessCounts.no_website_businesses,
    poorWebsiteBusinesses,
    leadPriorityBreakdown,
    pipelineStageBreakdown,
    websiteStatusBreakdown,
  });
}

module.exports = {
  loadBusinessCounts,
  loadLatestCompletedAnalysisScores,
  loadLeadPriorityBreakdown,
  loadPipelineStageBreakdown,
  loadWebsiteStatusBreakdown,
  getAnalytics,
};
