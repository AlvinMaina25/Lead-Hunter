/**
 * Pure, database-free Phase 21 analytics calculations (Part 1: backend
 * foundation).
 *
 * Mirrors the leadScoring.js / leadScoringService.js split already
 * used in this codebase: this module never touches Neon, never does
 * I/O of any kind, and always returns the same output for the same
 * input (no randomness, no clocks, no external state).
 * server/lib/analyticsService.js is the only thing that loads real
 * data (via a small, fixed number of aggregate SQL queries) and calls
 * into this module to turn it into the final analytics contract.
 *
 * This module invents NO data. Every metric here is either a direct
 * count already stored in Neon, or a deterministic classification of
 * data that is already stored in Neon (see isPoorWebsiteAnalysis).
 */

'use strict';

// ---------------------------------------------------------------------
// Deterministic metric definitions
// ---------------------------------------------------------------------

/**
 * leads.priority values counted as "high priority" for the
 * high_priority_leads metric. Matches
 * migrations/005_lead_scoring.sql's vocabulary
 * ('low','medium','high','very_high') -- the retired 'urgent' value
 * is never checked for, since the leads_priority_check CHECK
 * constraint no longer allows it and no row can contain it.
 */
const HIGH_PRIORITY_VALUES = Object.freeze(['high', 'very_high']);

/**
 * Website quality score threshold at or below which a Lighthouse-style
 * 0-100 category score counts as "poor" for the
 * poor_website_businesses metric.
 *
 * This is NOT a new, invented threshold. It reuses the EXACT boundary
 * server/lib/leadScoring.js already established for
 * "poor_performance" / "poor_seo" / "poor_accessibility"
 * (PERFORMANCE_TIERS / SEO_TIERS / ACCESSIBILITY_TIERS: the first,
 * worst tier in each ladder is score <= 49). Reusing that existing,
 * already-shipped definition -- rather than inventing a second
 * "poor" boundary for analytics -- keeps "poor" meaning the same
 * thing everywhere in the app.
 *
 * best_practices_score is not itself scored by leadScoring.js (Phase
 * 12 deliberately does not weight it into lead_score, to avoid
 * double-counting against the other three categories), but it is the
 * same 0-100 Lighthouse scale, so the same boundary is applied to it
 * here, for this metric only.
 */
const POOR_SCORE_MAX = 49;

/**
 * The four website_analysis score columns evaluated when deciding
 * whether a business's LATEST COMPLETED analysis counts as "poor".
 */
const POOR_WEBSITE_SCORE_FIELDS = Object.freeze([
  'performance_score',
  'seo_score',
  'accessibility_score',
  'best_practices_score',
]);

/**
 * A business counts as having a "poor website" when its latest
 * COMPLETED website_analysis row has at least one of the four
 * Lighthouse-style scores at or below POOR_SCORE_MAX.
 *
 * A business with NO completed analysis at all (null/undefined input)
 * is never counted as poor -- absence of evidence is not evidence of
 * a poor website, and is instead reflected only in the fact that it
 * contributes to neither poor_website_businesses nor any implied
 * "good website" count. A completed analysis where every score
 * column happens to be NULL (PageSpeed can fail independently of the
 * homepage fetch -- see migrations/003_website_analysis_results.sql)
 * is treated the same way: no measured score means no measured
 * "poor" evidence, never a silent 0.
 *
 * @param {{performance_score: number|null, seo_score: number|null, accessibility_score: number|null, best_practices_score: number|null}|null|undefined} latestCompletedAnalysis
 * @returns {boolean}
 */
function isPoorWebsiteAnalysis(latestCompletedAnalysis) {
  if (!latestCompletedAnalysis) return false;
  return POOR_WEBSITE_SCORE_FIELDS.some((field) => {
    const value = latestCompletedAnalysis[field];
    return value !== null && value !== undefined && Number(value) <= POOR_SCORE_MAX;
  });
}

/**
 * Maps a sales_pipeline.stage value (or the virtual 'new' default for
 * a lead with no pipeline row yet -- the same "no row yet == new"
 * contract server/routes/dashboard.js and
 * leadDetailService.js#virtualDefaultPipeline already use) to the
 * Phase 21 funnel metric it counts toward, if any.
 *
 * 'new', 'researched', and 'lost' intentionally map to nothing -- they
 * are not one of the nine requested metrics.
 *
 * IMPORTANT: each of these counts leads CURRENTLY SITTING AT that
 * stage right now, not a lifetime/cumulative funnel count.
 * sales_pipeline stores one CURRENT stage per lead (UNIQUE (lead_id),
 * migrations/006_pipeline_stage_realignment.sql), not a history of
 * stage transitions -- its contacted_at/response_at/meeting_at/
 * proposal_at/won_at/lost_at timestamp columns exist in the schema
 * but are not populated by any shipped code path (see migration 006's
 * own comment), so they cannot be used as a reliable "ever reached
 * this stage" signal today. This mirrors, and stays consistent with,
 * the exact convention server/routes/dashboard.js already established
 * for its leadsContacted/leadsWon cards
 * (`COALESCE(sp.stage, 'new') = 'contacted'` / `= 'won'`).
 */
const PIPELINE_STAGE_METRIC = Object.freeze({
  contacted: 'contacted_leads',
  responded: 'responses',
  meeting: 'meetings',
  proposal: 'proposals',
  won: 'won_deals',
});

/**
 * @typedef {Object} AnalyticsMetrics
 * @property {number} businesses_discovered
 * @property {number} no_website_businesses
 * @property {number} poor_website_businesses
 * @property {number} high_priority_leads
 * @property {number} contacted_leads
 * @property {number} responses
 * @property {number} meetings
 * @property {number} proposals
 * @property {number} won_deals
 */

/**
 * @param {Array<{priority: string, count: number}>} leadPriorityBreakdown
 * @returns {number}
 */
function countHighPriorityLeads(leadPriorityBreakdown) {
  return leadPriorityBreakdown
    .filter((row) => HIGH_PRIORITY_VALUES.includes(row.priority))
    .reduce((sum, row) => sum + row.count, 0);
}

/**
 * @param {Array<{stage: string, count: number}>} pipelineStageBreakdown
 * @returns {{contacted_leads: number, responses: number, meetings: number, proposals: number, won_deals: number}}
 */
function countPipelineFunnelMetrics(pipelineStageBreakdown) {
  const totals = { contacted_leads: 0, responses: 0, meetings: 0, proposals: 0, won_deals: 0 };
  for (const row of pipelineStageBreakdown) {
    const metric = PIPELINE_STAGE_METRIC[row.stage];
    // An unrecognized stage value (should be impossible given
    // sales_pipeline_stage_check, but never trusted blindly here) is
    // silently skipped -- it contributes to no metric rather than
    // throwing or being miscounted into an unrelated bucket.
    if (metric) totals[metric] += row.count;
  }
  return totals;
}

/**
 * @param {Array<{[key: string]: string, count: number}>} rows
 * @param {string} key
 * @returns {Record<string, number>}
 */
function toRecord(rows, key) {
  const record = {};
  for (const row of rows) record[row[key]] = row.count;
  return record;
}

/**
 * Assembles the full Phase 21 analytics contract from already-aggregated
 * data (small, fixed-size breakdown arrays -- never a raw per-business
 * or per-lead row set). See analyticsService.js#getAnalytics for how
 * each input is loaded from Neon.
 *
 * @param {{
 *   businessesDiscovered: number,
 *   noWebsiteBusinesses: number,
 *   poorWebsiteBusinesses: number,
 *   leadPriorityBreakdown: Array<{priority: string, count: number}>,
 *   pipelineStageBreakdown: Array<{stage: string, count: number}>,
 *   websiteStatusBreakdown: Array<{website_status: string, count: number}>,
 * }} raw
 * @returns {{
 *   metrics: AnalyticsMetrics,
 *   lead_priority_breakdown: Record<string, number>,
 *   pipeline_stage_breakdown: Record<string, number>,
 *   website_status_breakdown: Record<string, number>,
 * }}
 */
function buildAnalyticsResponse(raw) {
  const funnel = countPipelineFunnelMetrics(raw.pipelineStageBreakdown);

  const metrics = {
    businesses_discovered: raw.businessesDiscovered,
    no_website_businesses: raw.noWebsiteBusinesses,
    poor_website_businesses: raw.poorWebsiteBusinesses,
    high_priority_leads: countHighPriorityLeads(raw.leadPriorityBreakdown),
    contacted_leads: funnel.contacted_leads,
    responses: funnel.responses,
    meetings: funnel.meetings,
    proposals: funnel.proposals,
    won_deals: funnel.won_deals,
  };

  return {
    metrics,
    lead_priority_breakdown: toRecord(raw.leadPriorityBreakdown, 'priority'),
    pipeline_stage_breakdown: toRecord(raw.pipelineStageBreakdown, 'stage'),
    website_status_breakdown: toRecord(raw.websiteStatusBreakdown, 'website_status'),
  };
}

module.exports = {
  HIGH_PRIORITY_VALUES,
  POOR_SCORE_MAX,
  POOR_WEBSITE_SCORE_FIELDS,
  PIPELINE_STAGE_METRIC,
  isPoorWebsiteAnalysis,
  countHighPriorityLeads,
  countPipelineFunnelMetrics,
  buildAnalyticsResponse,
};
