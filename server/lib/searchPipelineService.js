/**
 * Post-search pipeline.
 *
 * After POST /api/searches has stored a search's businesses, this module
 * takes ONLY those businesses (never the whole table) through, in order:
 *
 *   1. website check        } only when analysis_options.website_analysis
 *   2. website analysis     }
 *   3. AI opportunity analysis   only when analysis_options.ai_analysis
 *   4. deterministic lead scoring   ALWAYS (no external calls, so it is
 *                                   always safe and cheap to run)
 *
 * The order matters, not just the spec: analysis only runs for a website
 * the check has marked 'reachable', and the AI analysis reads the latest
 * website analysis, so each stage feeds the next.
 *
 * NOTHING HERE RE-IMPLEMENTS A STAGE. Every stage is the existing
 * service function the single-business endpoints already use
 * (checkBusinessById, analyzeBusiness, runOpportunityAnalysis,
 * scoreBusiness) and the fan-out is the existing runWithConcurrency at
 * the existing BATCH_CONCURRENCY. They are injectable (`deps`) only so
 * tests can drive the orchestration without a network or a database.
 *
 * FAILURE ISOLATION. Each stage of each business is its own try/catch.
 * A failing stage is recorded as {business_id, stage, code} and the
 * business continues to the next stage (scoring still runs); a failing
 * business never stops the others; and nothing in this module ever
 * throws to its caller. `code` is a short error code, never raw error
 * text (that is logged server-side only, like the batch endpoints do).
 *
 * KNOWN BUSINESSES. A search often returns businesses already in the
 * database. Those are given to the pipeline as `knownBusinessIds`, and
 * for each of them only the stages that have never been done are run
 * (see getKnownBusinessState): a business with a completed website
 * analysis isn't re-checked/re-analyzed (another PageSpeed call), one
 * with a completed AI analysis isn't sent to the AI again, and one
 * that already has everything requested and a score is skipped
 * outright. A new business always gets every requested stage. If the
 * state lookup fails the business is treated as needing everything.
 *
 * RUNNING IT. startSearchPipeline() is what the HTTP layer calls: it
 * records the 'running' status, kicks the work off WITHOUT awaiting it,
 * and returns the initial state, so POST /api/searches keeps returning
 * promptly. The outcome is written to the `searches` row
 * (migrations/008_search_pipeline.sql) for the UI to read later.
 * runSearchPipeline() is the awaitable form (used by tests).
 */

'use strict';

const { runWithConcurrency, BATCH_CONCURRENCY, checkBusinessById } = require('./websiteCheckService');
const { analyzeBusiness, classifyAnalyzedResult } = require('./websiteAnalysisService');
const { runOpportunityAnalysis } = require('./aiOpportunityAnalysisService');
const { scoreBusiness } = require('./leadScoringService');

const PIPELINE_STATUS = Object.freeze({
  NOT_RUN: 'not_run',
  RUNNING: 'running',
  COMPLETED: 'completed',
  COMPLETED_WITH_ERRORS: 'completed_with_errors',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

const STAGE = Object.freeze({
  WEBSITE_CHECK: 'website_check',
  WEBSITE_ANALYSIS: 'website_analysis',
  AI_ANALYSIS: 'ai_analysis',
  LEAD_SCORING: 'lead_scoring',
});

/** The real stage implementations. Tests override individual entries. */
const DEFAULT_DEPS = Object.freeze({
  checkBusiness: checkBusinessById,
  analyzeWebsite: analyzeBusiness,
  analyzeOpportunity: runOpportunityAnalysis,
  scoreLead: scoreBusiness,
  concurrency: BATCH_CONCURRENCY,
});

/**
 * Keeps stored failure codes to a short, fixed-looking token so a
 * stray free-text value can never be persisted as a "code".
 *
 * @param {unknown} value
 * @param {string} fallback
 */
function safeCode(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

function emptyTally(total) {
  return {
    businesses_total: total,
    businesses_already_known: 0,
    businesses_skipped: 0,
    website_checked: 0,
    website_analyzed: 0,
    website_analysis_skipped: 0,
    ai_analyzed: 0,
    scored: 0,
    businesses_with_failures: 0,
    failures: [],
  };
}

/**
 * Runs the requested stages for ONE business. Never throws.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @param {{website_analysis: boolean, ai_analysis: boolean}} options
 * @param {typeof DEFAULT_DEPS} deps
 * @param {ReturnType<typeof emptyTally>} tally - mutated in place
 */
async function processBusiness(pool, businessId, options, deps, tally) {
  let hadFailure = false;
  const fail = (stage, code) => {
    tally.failures.push({ business_id: businessId, stage, code });
    hadFailure = true;
  };

  if (options.website_analysis) {
    let checked = false;
    try {
      await deps.checkBusiness(pool, businessId);
      tally.website_checked += 1;
      checked = true;
    } catch (err) {
      console.error('[search pipeline] website check', businessId, err.message);
      fail(STAGE.WEBSITE_CHECK, 'CHECK_ERROR');
    }

    // If the check itself blew up, the stored website_status can't be
    // trusted, so don't analyze on top of it. Scoring still runs below.
    if (checked) {
      try {
        const result = await deps.analyzeWebsite(pool, businessId);
        if (result.outcome === 'analyzed') {
          const { row } = result;
          if (row.analysis_status === 'completed') tally.website_analyzed += 1;

          // A stored row is not necessarily a clean result: a failed/
          // timed-out homepage fetch, or PageSpeed being rate limited
          // or down, still gets a row. Surface those as failures.
          const { httpStatus } = classifyAnalyzedResult(row);
          if (row.analysis_status !== 'completed') {
            fail(STAGE.WEBSITE_ANALYSIS, safeCode(row.error_code || row.analysis_status, 'ANALYSIS_FAILED'));
          } else if (httpStatus === 429) {
            fail(STAGE.WEBSITE_ANALYSIS, 'RATE_LIMITED');
          } else if (httpStatus === 503) {
            fail(STAGE.WEBSITE_ANALYSIS, 'UNAVAILABLE');
          }
        } else {
          // 'no_website' / 'not_reachable': nothing to analyze. That is
          // an expected outcome, not a failure.
          tally.website_analysis_skipped += 1;
        }
      } catch (err) {
        console.error('[search pipeline] website analysis', businessId, err.message);
        fail(STAGE.WEBSITE_ANALYSIS, 'ANALYSIS_ERROR');
      }
    }
  }

  if (options.ai_analysis) {
    try {
      const row = await deps.analyzeOpportunity(pool, businessId);
      if (row.status === 'completed') {
        tally.ai_analyzed += 1;
      } else {
        fail(STAGE.AI_ANALYSIS, safeCode(row.error_code || row.status, 'AI_FAILED'));
      }
    } catch (err) {
      console.error('[search pipeline] ai analysis', businessId, err.message);
      fail(STAGE.AI_ANALYSIS, 'AI_ERROR');
    }
  }

  try {
    await deps.scoreLead(pool, businessId);
    tally.scored += 1;
  } catch (err) {
    console.error('[search pipeline] lead scoring', businessId, err.message);
    fail(STAGE.LEAD_SCORING, 'SCORING_ERROR');
  }

  if (hadFailure) tally.businesses_with_failures += 1;
}

/**
 * What a business that was already in the database has had done to it.
 * A website is "done" once it was checked and, if it is reachable, has a
 * completed analysis (a missing/unreachable site has nothing to analyze).
 *
 * @returns {Promise<{ websiteDone: boolean, aiDone: boolean, scored: boolean }>}
 */
async function getKnownBusinessState(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT
        (b.website_checked_at IS NOT NULL
          AND (b.website_status IS DISTINCT FROM 'reachable'
               OR EXISTS (SELECT 1 FROM website_analysis w
                          WHERE w.business_id = b.id AND w.analysis_status = 'completed'))) AS website_done,
        EXISTS (SELECT 1 FROM ai_analysis a
                WHERE a.business_id = b.id AND a.status = 'completed') AS ai_done,
        EXISTS (SELECT 1 FROM leads l
                WHERE l.business_id = b.id AND l.scored_at IS NOT NULL) AS scored
      FROM businesses b
      WHERE b.id = $1
    `,
    [businessId]
  );
  const row = rows[0];
  return {
    websiteDone: Boolean(row && row.website_done),
    aiDone: Boolean(row && row.ai_done),
    scored: Boolean(row && row.scored),
  };
}

/**
 * Runs the pipeline for one business, skipping stages a known business
 * has already had. Never throws.
 */
async function processBusinessOrSkip(pool, businessId, options, known, deps, tally) {
  if (!known.has(businessId)) {
    return processBusiness(pool, businessId, options, deps, tally);
  }

  tally.businesses_already_known += 1;

  let effective = options;
  let alreadyScored = false;
  try {
    const state = await getKnownBusinessState(pool, businessId);
    effective = {
      website_analysis: options.website_analysis && !state.websiteDone,
      ai_analysis: options.ai_analysis && !state.aiDone,
    };
    alreadyScored = state.scored;
  } catch (err) {
    console.error('[search pipeline] could not read known business state', businessId, err.message);
  }

  // Nothing new to learn about this business and it already has a score.
  if (!effective.website_analysis && !effective.ai_analysis && alreadyScored) {
    tally.businesses_skipped += 1;
    return undefined;
  }

  return processBusiness(pool, businessId, effective, deps, tally);
}

/**
 * Best-effort write to the `searches` row. Persisting status must never
 * be the reason the pipeline (or the search) fails -- e.g. migration 008
 * not applied yet just means the status isn't recorded.
 */
async function safeQuery(pool, label, sql, params) {
  try {
    await pool.query(sql, params);
    return true;
  } catch (err) {
    console.error(`[search pipeline] could not persist ${label}:`, err.message);
    return false;
  }
}

/** Marks the search's pipeline 'running' and clears any previous run's results. */
async function markPipelineRunning(pool, searchId) {
  const startedAt = new Date().toISOString();
  await safeQuery(
    pool,
    'running status',
    `
      UPDATE searches
      SET pipeline_status = 'running',
          pipeline_started_at = now(),
          pipeline_completed_at = NULL,
          pipeline_summary = NULL,
          pipeline_failures = '[]'::jsonb
      WHERE id = $1
    `,
    [searchId]
  );
  return { status: PIPELINE_STATUS.RUNNING, started_at: startedAt, completed_at: null, summary: null, failures: [] };
}

/**
 * The stage work + final status write. Never throws.
 *
 * @returns {Promise<{ status: string, summary: object|null, failures: object[] }>}
 */
async function executePipeline(pool, { searchId, businessIds, options, knownBusinessIds = [] }, deps) {
  const tally = emptyTally(businessIds.length);
  const known = new Set(knownBusinessIds);
  let status;

  try {
    await runWithConcurrency(
      businessIds,
      // processBusiness never throws; the try/catch here is the last
      // line of defence so one unexpected bug can't skip the rest.
      async (businessId) => {
        try {
          await processBusinessOrSkip(pool, businessId, options, known, deps, tally);
        } catch (err) {
          console.error('[search pipeline] unexpected error', businessId, err.message);
          tally.failures.push({ business_id: businessId, stage: 'pipeline', code: 'PIPELINE_ERROR' });
          tally.businesses_with_failures += 1;
        }
      },
      deps.concurrency
    );
    status = tally.failures.length === 0 ? PIPELINE_STATUS.COMPLETED : PIPELINE_STATUS.COMPLETED_WITH_ERRORS;
  } catch (err) {
    console.error('[search pipeline] crashed', searchId, err.message);
    status = PIPELINE_STATUS.FAILED;
  }

  const { failures, ...summary } = tally;

  await safeQuery(
    pool,
    'final status',
    `
      UPDATE searches
      SET pipeline_status = $2,
          pipeline_completed_at = now(),
          pipeline_summary = $3,
          pipeline_failures = $4
      WHERE id = $1
    `,
    [searchId, status, JSON.stringify(summary), JSON.stringify(failures)]
  );

  return { status, summary, failures };
}

function resolveOptions(options = {}) {
  return {
    website_analysis: options.website_analysis === true,
    ai_analysis: options.ai_analysis === true,
  };
}

/**
 * Awaitable form: marks running, runs every stage, records the outcome.
 * Never throws. Used by tests; the HTTP layer uses startSearchPipeline.
 *
 * @param {{query: Function}} pool
 * @param {{ searchId: string, businessIds: string[], options?: {website_analysis?: boolean, ai_analysis?: boolean} }} args
 * @param {Partial<typeof DEFAULT_DEPS>} [deps]
 */
async function runSearchPipeline(pool, args, deps = {}) {
  await markPipelineRunning(pool, args.searchId);
  return executePipeline(
    pool,
    {
      searchId: args.searchId,
      businessIds: args.businessIds,
      options: resolveOptions(args.options),
      knownBusinessIds: args.knownBusinessIds,
    },
    { ...DEFAULT_DEPS, ...deps }
  );
}

/**
 * What POST /api/searches calls. Records 'running' (one quick UPDATE),
 * starts the pipeline in the background WITHOUT awaiting it, and returns
 * the initial pipeline state for the response. Never throws, and the
 * background promise can never reject (so it can never crash the
 * process as an unhandled rejection).
 *
 * @returns {Promise<{ status: string, started_at: string, completed_at: null, summary: null, failures: [] }>}
 */
async function startSearchPipeline(pool, args, deps = {}) {
  const initial = await markPipelineRunning(pool, args.searchId);
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const resolvedArgs = {
    searchId: args.searchId,
    businessIds: args.businessIds,
    options: resolveOptions(args.options),
    knownBusinessIds: args.knownBusinessIds,
  };

  // Deliberately not awaited -- see the module header.
  executePipeline(pool, resolvedArgs, resolvedDeps).catch((err) => {
    console.error('[search pipeline] background run failed', args.searchId, err.message);
  });

  return initial;
}

/**
 * Startup housekeeping: a pipeline runs inside the server process, so a
 * restart (deploy, crash) while one is 'running' would otherwise leave
 * its search showing 'running' forever. Never throws.
 *
 * @param {{query: Function}} pool
 */
async function markInterruptedPipelines(pool) {
  try {
    const result = await pool.query(
      `
        UPDATE searches
        SET pipeline_status = 'interrupted', pipeline_completed_at = now()
        WHERE pipeline_status = 'running'
      `
    );
    return result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  } catch (err) {
    console.error('[search pipeline] could not mark interrupted pipelines:', err.message);
    return 0;
  }
}

module.exports = {
  PIPELINE_STATUS,
  STAGE,
  DEFAULT_DEPS,
  safeCode,
  processBusiness,
  getKnownBusinessState,
  markPipelineRunning,
  executePipeline,
  runSearchPipeline,
  startSearchPipeline,
  markInterruptedPipelines,
};
