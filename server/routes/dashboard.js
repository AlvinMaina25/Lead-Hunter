const express = require('express');
const pool = require('../db');

const router = express.Router();

/**
 * GET /api/dashboard/metrics
 *
 * Read-only aggregate counts for the dashboard's metric cards, computed
 * directly from the businesses and leads tables. No parameters are
 * accepted, so there is no user input to parameterize here.
 *
 * Metric definitions (schema has no dedicated "needs improvement"
 * column, so that one maps to the closest existing enum value):
 *  - businessesWithNoWebsite   -> businesses.website_status = 'no_website'
 *  - websitesNeedingImprovement -> businesses.website_status = 'unreachable'
 *  - highPriorityLeads         -> leads.priority IN ('high','very_high')
 *    (Phase 12: leads.priority's vocabulary changed from
 *    'low'/'medium'/'high'/'urgent' to 'low'/'medium'/'high'/'very_high'
 *    -- see migrations/005_lead_scoring.sql. Updated here to match,
 *    since this is the only other reader of leads.priority.)
 *  - leadsContacted / leadsWon -> sales_pipeline.stage, NOT
 *    leads.lead_status.
 *
 * Phase 13A (migrations/006_pipeline_stage_realignment.sql) moved
 * pipeline-stage tracking to its own `sales_pipeline` table, and
 * PATCH /api/leads/:id/pipeline (server/lib/leadDetailService.js
 * #updatePipelineStage) writes ONLY to sales_pipeline.stage -- it has
 * never written to leads.lead_status, which is a separate, older
 * column (migrations/001_init_schema.sql) that nothing in the app
 * updates after a lead is created. Querying leads.lead_status here
 * was therefore reading a field that never changes as a user moves a
 * lead through the pipeline, which is why these two cards looked
 * "stuck" on the Dashboard after a stage change on the lead detail
 * page (which correctly reads/writes sales_pipeline -- see
 * getLeadDetail/updatePipelineStage).
 *
 * Fix: LEFT JOIN sales_pipeline and treat a lead with no pipeline row
 * yet as stage 'new' via COALESCE(sp.stage, 'new'), mirroring the
 * exact "no row yet == new" contract that
 * leadDetailService.js#virtualDefaultPipeline already uses for the
 * lead detail page and that the `stage` column's own DB default
 * ('new') encodes -- so a lead that has never been touched counts the
 * same way here as it displays there.
 */
router.get('/metrics', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM businesses) AS total_businesses,
        (SELECT COUNT(*)::int FROM leads) AS total_leads,
        (SELECT COUNT(*)::int FROM businesses WHERE website_status = 'no_website') AS businesses_with_no_website,
        (SELECT COUNT(*)::int FROM businesses WHERE website_status = 'unreachable') AS websites_needing_improvement,
        (SELECT COUNT(*)::int FROM leads WHERE priority IN ('high', 'very_high')) AS high_priority_leads,
        (SELECT COUNT(*)::int
           FROM leads l
           LEFT JOIN sales_pipeline sp ON sp.lead_id = l.id
           WHERE COALESCE(sp.stage, 'new') = 'contacted') AS leads_contacted,
        (SELECT COUNT(*)::int
           FROM leads l
           LEFT JOIN sales_pipeline sp ON sp.lead_id = l.id
           WHERE COALESCE(sp.stage, 'new') = 'won') AS leads_won
    `);

    const row = rows[0];

    res.json({
      totalBusinesses: row.total_businesses,
      totalLeads: row.total_leads,
      businessesWithNoWebsite: row.businesses_with_no_website,
      websitesNeedingImprovement: row.websites_needing_improvement,
      highPriorityLeads: row.high_priority_leads,
      leadsContacted: row.leads_contacted,
      leadsWon: row.leads_won,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
