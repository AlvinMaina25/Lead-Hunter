const express = require('express');
const pool = require('../db');
const { SEARCH_COLUMNS, toSearchRecord, createSearchHandler } = require('../lib/searchService');
const { startSearchPipeline } = require('../lib/searchPipelineService');

const router = express.Router();

/**
 * GET /api/searches
 *
 * Full read-only set of search history records. Filtering, sorting, and
 * pagination are handled client-side in SearchesTable.
 *
 * Phase 20: each record additionally carries the search configuration it
 * was run with (keyword, radius_meters, max_results, analysis_options).
 * Every pre-existing field is unchanged.
 *
 * Each record also carries `pipeline` (migration 008): the status,
 * timestamps, summary counts and per-business failures of the
 * post-search pipeline described under POST below.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${SEARCH_COLUMNS}
      FROM searches
      ORDER BY started_at DESC
    `);

    res.json(rows.map(toSearchRecord));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/searches
 *
 * Body (Phase 7 fields, then the Phase 20 search configuration -- every
 * Phase 20 field is optional, so existing callers keep working):
 *
 *   {
 *     category: string,                 // required
 *     location: string,                 // required
 *     keyword?: string,
 *     radius_meters?: number | null,    // 0 < r <= 50000; omitted/null = no radius
 *     max_results?: number,             // integer 1..20; default 20
 *     analysis_options?: {              // acted on by the post-search pipeline
 *       website_analysis?: boolean,     // default false
 *       ai_analysis?: boolean,          // default false
 *     },
 *   }
 *
 * Runs a Google Places Text Search (New) for the configuration, stores
 * discovered businesses (deduplicated by Google Place ID) and links them
 * to a new `searches` record -- which also persists the configuration --
 * via `search_results`. Responds with
 * { search, businesses, summary }. See server/lib/searchService.js for
 * the flow, and server/lib/googlePlaces.js / server/lib/normalize.js for
 * the Google client and normalization rules.
 *
 * POST-SEARCH PIPELINE. Once the search is stored and completed, the
 * businesses of THAT search (and only those) are run through, in the
 * BACKGROUND: website check + website analysis (if
 * analysis_options.website_analysis), AI analysis (if
 * analysis_options.ai_analysis), then lead scoring (always). The
 * response does not wait for it: it returns as before, with the
 * pipeline's initial state in `search.pipeline` (status 'running').
 * Progress and outcome are stored on the `searches` row and returned by
 * GET /api/searches. See server/lib/searchPipelineService.js.
 */
router.post(
  '/',
  createSearchHandler({
    pool,
    startPipeline: (args) => startSearchPipeline(pool, args),
  })
);

module.exports = router;
