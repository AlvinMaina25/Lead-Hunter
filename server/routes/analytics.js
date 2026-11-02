const express = require('express');
const pool = require('../db');
const { getAnalytics } = require('../lib/analyticsService');

const router = express.Router();

/**
 * GET /api/analytics
 *
 * Phase 21 Part 1: read-only backend foundation for the Analytics
 * dashboard (frontend is Phase 21 Part 2, not implemented here).
 *
 * Returns real, calculated metrics only -- every number is computed
 * from businesses/leads/sales_pipeline/website_analysis, never
 * fake/demo data. No parameters are accepted, so there is no user
 * input to parameterize/validate here.
 *
 * Response shape:
 * {
 *   "metrics": {
 *     "businesses_discovered": number,
 *     "no_website_businesses": number,
 *     "poor_website_businesses": number,
 *     "high_priority_leads": number,
 *     "contacted_leads": number,
 *     "responses": number,
 *     "meetings": number,
 *     "proposals": number,
 *     "won_deals": number
 *   },
 *   "lead_priority_breakdown": { "low": number, "medium": number, "high": number, "very_high": number },
 *   "pipeline_stage_breakdown": { "new": number, "researched": number, "contacted": number, "responded": number, "meeting": number, "proposal": number, "won": number, "lost": number },
 *   "website_status_breakdown": { "no_website": number, "reachable": number, "unreachable": number, "unknown": number }
 * }
 *
 * See server/lib/analytics.js for exact metric definitions and
 * server/lib/analyticsService.js for how each is loaded from Neon.
 */
router.get('/', async (req, res, next) => {
  try {
    const {
      metrics,
      lead_priority_breakdown: leadPriorityBreakdown,
      pipeline_stage_breakdown: pipelineStageBreakdown,
      website_status_breakdown: websiteStatusBreakdown,
    } = await getAnalytics(pool);

    res.json({
      metrics,
      lead_priority_breakdown: leadPriorityBreakdown,
      pipeline_stage_breakdown: pipelineStageBreakdown,
      website_status_breakdown: websiteStatusBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
