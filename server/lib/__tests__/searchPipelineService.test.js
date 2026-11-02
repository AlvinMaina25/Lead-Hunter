const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PIPELINE_STATUS,
  DEFAULT_DEPS,
  safeCode,
  runSearchPipeline,
  startSearchPipeline,
  markInterruptedPipelines,
} = require('../searchPipelineService');
const { checkBusinessById, runWithConcurrency, BATCH_CONCURRENCY } = require('../websiteCheckService');
const { analyzeBusiness } = require('../websiteAnalysisService');
const { runOpportunityAnalysis } = require('../aiOpportunityAnalysisService');
const { scoreBusiness } = require('../leadScoringService');

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

/**
 * Fake pool that understands only the three `searches` pipeline writes
 * searchPipelineService.js issues. Stage functions are injected fakes
 * (see makeDeps), so this pool is never asked for anything else -- an
 * unexpected query throws, which would surface as a test failure.
 *
 * `onFinal` lets a test wait for the background run to finish.
 */
function makePool({ failWrites = false, rowCount = 0 } = {}) {
  const writes = [];
  let resolveFinal;
  const finalWritten = new Promise((resolve) => {
    resolveFinal = resolve;
  });

  return {
    writes,
    finalWritten,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (failWrites) throw new Error('connection terminated');

      if (s.startsWith("UPDATE searches SET pipeline_status = 'running'")) {
        writes.push({ kind: 'running', params });
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('UPDATE searches SET pipeline_status = $2')) {
        const [searchId, status, summary, failures] = params;
        const final = { kind: 'final', searchId, status, summary: JSON.parse(summary), failures: JSON.parse(failures) };
        writes.push(final);
        resolveFinal(final);
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith("UPDATE searches SET pipeline_status = 'interrupted'")) {
        writes.push({ kind: 'interrupted' });
        return { rows: [], rowCount };
      }
      throw new Error(`Unexpected SQL in fake pool: ${s}`);
    },
  };
}

const ANALYZED_OK = { outcome: 'analyzed', row: { analysis_status: 'completed', error_code: null, raw_analysis_response: { pagespeed: { status: 'completed' } } } };

/**
 * Stage fakes that record every call as `${stage}:${businessId}` in
 * `calls`, in order, and succeed by default. `overrides` replaces any
 * stage per test.
 */
function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    concurrency: 3,
    checkBusiness: async (_pool, id) => {
      calls.push(`check:${id}`);
      return { business: { id } };
    },
    analyzeWebsite: async (_pool, id) => {
      calls.push(`analyze:${id}`);
      return ANALYZED_OK;
    },
    analyzeOpportunity: async (_pool, id) => {
      calls.push(`ai:${id}`);
      return { status: 'completed', error_code: null };
    },
    scoreLead: async (_pool, id) => {
      calls.push(`score:${id}`);
      return { lead_score: 50 };
    },
    ...overrides,
  };
  return { deps, calls };
}

/** Wraps a stage so it records the call, then behaves as `behaviour(id)` (throw or return). */
function stage(name, calls, behaviour) {
  return async (_pool, id) => {
    calls.push(`${name}:${id}`);
    return behaviour(id);
  };
}

const A = 'a1111111-1111-4111-8111-111111111111';
const B = 'b2222222-2222-4222-8222-222222222222';
const C = 'c3333333-3333-4333-8333-333333333333';
const SEARCH_ID = 'search-1';

/** Silences the pipeline's server-side error logging for a test. */
function quiet(t) {
  t.mock.method(console, 'error', () => {});
}

// ---------------------------------------------------------------------
// Reuse: the pipeline is built from the existing services
// ---------------------------------------------------------------------

test('DEFAULT_DEPS are the existing services themselves, not copies', () => {
  assert.equal(DEFAULT_DEPS.checkBusiness, checkBusinessById);
  assert.equal(DEFAULT_DEPS.analyzeWebsite, analyzeBusiness);
  assert.equal(DEFAULT_DEPS.analyzeOpportunity, runOpportunityAnalysis);
  assert.equal(DEFAULT_DEPS.scoreLead, scoreBusiness);
  assert.equal(DEFAULT_DEPS.concurrency, BATCH_CONCURRENCY);
  assert.equal(typeof runWithConcurrency, 'function');
});

// ---------------------------------------------------------------------
// Stage selection and order
// ---------------------------------------------------------------------

test('no analysis options: only lead scoring runs, for exactly the given businesses', async () => {
  const { deps, calls } = makeDeps();
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: [A, B], options: {} }, deps);

  assert.deepEqual([...calls].sort(), [`score:${A}`, `score:${B}`]);
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED);
  assert.equal(result.summary.scored, 2);
  assert.equal(result.summary.businesses_total, 2);
});

test('website_analysis only: check -> analysis -> scoring per business, and no AI call', async () => {
  const { deps, calls } = makeDeps();
  await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A], options: { website_analysis: true, ai_analysis: false } },
    deps
  );
  assert.deepEqual(calls, [`check:${A}`, `analyze:${A}`, `score:${A}`]);
});

test('ai_analysis only: no website check or website analysis; AI runs before scoring', async () => {
  const { deps, calls } = makeDeps();
  await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A], options: { website_analysis: false, ai_analysis: true } },
    deps
  );
  assert.deepEqual(calls, [`ai:${A}`, `score:${A}`]);
});

test('both options: check -> website analysis -> AI -> scoring, in that order, for each business', async () => {
  const { deps, calls } = makeDeps();
  await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { website_analysis: true, ai_analysis: true } },
    { ...deps, concurrency: 1 }
  );
  assert.deepEqual(calls, [
    `check:${A}`, `analyze:${A}`, `ai:${A}`, `score:${A}`,
    `check:${B}`, `analyze:${B}`, `ai:${B}`, `score:${B}`,
  ]);
});

test('options must be strict booleans: truthy non-booleans do not trigger external stages', async () => {
  const { deps, calls } = makeDeps();
  await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A], options: { website_analysis: 'true', ai_analysis: 1 } },
    deps
  );
  assert.deepEqual(calls, [`score:${A}`]);
});

test('a search with no businesses completes cleanly and calls nothing', async () => {
  const { deps, calls } = makeDeps();
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: [], options: { ai_analysis: true } }, deps);
  assert.deepEqual(calls, []);
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED);
  assert.equal(result.summary.businesses_total, 0);
});

// ---------------------------------------------------------------------
// Partial failures
// ---------------------------------------------------------------------

test('partial failures: every business is still scored, failures are recorded as codes, status is completed_with_errors', async (t) => {
  quiet(t);
  const calls = [];
  const { deps } = makeDeps({
    // B's website check throws; C's AI analysis throws; A is clean.
    checkBusiness: stage('check', calls, (id) => {
      if (id === B) throw new Error('getaddrinfo ENOTFOUND secret-internal-host');
      return { business: { id } };
    }),
    analyzeWebsite: stage('analyze', calls, () => ANALYZED_OK),
    analyzeOpportunity: stage('ai', calls, (id) => {
      if (id === C) throw new Error('GEMINI_API_KEY=abc123 rejected');
      return { status: 'completed', error_code: null };
    }),
    scoreLead: stage('score', calls, () => ({ lead_score: 10 })),
  });
  const pool = makePool();

  const result = await runSearchPipeline(
    pool,
    { searchId: SEARCH_ID, businessIds: [A, B, C], options: { website_analysis: true, ai_analysis: true } },
    deps
  );

  // All three businesses reached scoring despite the failures.
  for (const id of [A, B, C]) assert.ok(calls.includes(`score:${id}`), `${id} was not scored`);
  assert.equal(result.summary.scored, 3);

  // B's failed check means its website is not analyzed on stale status...
  assert.ok(!calls.includes(`analyze:${B}`));
  // ...but the AI stage still ran for it (it does not depend on the check).
  assert.ok(calls.includes(`ai:${B}`));

  assert.equal(result.status, PIPELINE_STATUS.COMPLETED_WITH_ERRORS);
  assert.deepEqual(result.failures, [
    { business_id: B, stage: 'website_check', code: 'CHECK_ERROR' },
    { business_id: C, stage: 'ai_analysis', code: 'AI_ERROR' },
  ]);
  assert.equal(result.summary.businesses_with_failures, 2);

  // Raw error text (hostnames, keys) is never stored.
  const stored = JSON.stringify(pool.writes);
  assert.ok(!stored.includes('secret-internal-host'));
  assert.ok(!stored.includes('abc123'));
});

test('a scoring failure for one business does not stop the others', async (t) => {
  quiet(t);
  const { deps, calls } = makeDeps({
    scoreLead: async (_pool, id) => {
      if (id === A) throw new Error('db down for this row');
      return { lead_score: 1 };
    },
  });
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: [A, B, C], options: {} }, { ...deps, concurrency: 1 });

  assert.equal(result.summary.scored, 2);
  assert.deepEqual(result.failures, [{ business_id: A, stage: 'lead_scoring', code: 'SCORING_ERROR' }]);
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED_WITH_ERRORS);
  assert.deepEqual(calls, []); // none of the external stages were requested
});

test('every business failing every stage still finishes (completed_with_errors) without throwing', async (t) => {
  quiet(t);
  const boom = async () => {
    throw new Error('boom');
  };
  const result = await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { website_analysis: true, ai_analysis: true } },
    { ...makeDeps().deps, checkBusiness: boom, analyzeWebsite: boom, analyzeOpportunity: boom, scoreLead: boom }
  );
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED_WITH_ERRORS);
  assert.equal(result.summary.scored, 0);
  // check + ai + scoring per business (analysis is skipped after a failed check)
  assert.equal(result.failures.length, 6);
});

test('analysis outcomes no_website / not_reachable are skipped, not failures', async () => {
  const { deps } = makeDeps({
    analyzeWebsite: async (_pool, id) => ({ outcome: id === A ? 'no_website' : 'not_reachable', business: { id } }),
  });
  const result = await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { website_analysis: true } },
    deps
  );
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED);
  assert.equal(result.summary.website_analysis_skipped, 2);
  assert.equal(result.summary.website_analyzed, 0);
  assert.deepEqual(result.failures, []);
});

test('a stored website analysis that did not complete is a failure carrying the engine error_code', async () => {
  const { deps } = makeDeps({
    analyzeWebsite: async () => ({
      outcome: 'analyzed',
      row: { analysis_status: 'timeout', error_code: 'FETCH_TIMEOUT', raw_analysis_response: null },
    }),
  });
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: [A], options: { website_analysis: true } }, deps);
  assert.deepEqual(result.failures, [{ business_id: A, stage: 'website_analysis', code: 'FETCH_TIMEOUT' }]);
  assert.equal(result.summary.website_analyzed, 0);
  assert.equal(result.summary.scored, 1);
});

test('PageSpeed rate limiting is recorded as a failure, while the stored homepage analysis still counts as analyzed', async () => {
  const { deps } = makeDeps({
    analyzeWebsite: async () => ({
      outcome: 'analyzed',
      row: { analysis_status: 'completed', error_code: null, raw_analysis_response: { pagespeed: { status: 'rate_limited' } } },
    }),
  });
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: [A], options: { website_analysis: true } }, deps);
  assert.deepEqual(result.failures, [{ business_id: A, stage: 'website_analysis', code: 'RATE_LIMITED' }]);
  assert.equal(result.summary.website_analyzed, 1);
});

test('an AI analysis row that is not completed is a failure with its error_code, falling back to its status', async () => {
  const { deps } = makeDeps({
    analyzeOpportunity: async (_pool, id) =>
      id === A ? { status: 'failed', error_code: 'SCHEMA_VALIDATION_FAILED' } : { status: 'rate_limited', error_code: null },
  });
  const result = await runSearchPipeline(
    makePool(),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { ai_analysis: true } },
    { ...deps, concurrency: 1 }
  );
  assert.deepEqual(result.failures, [
    { business_id: A, stage: 'ai_analysis', code: 'SCHEMA_VALIDATION_FAILED' },
    { business_id: B, stage: 'ai_analysis', code: 'RATE_LIMITED' },
  ]);
  assert.equal(result.summary.ai_analyzed, 0);
  assert.equal(result.summary.scored, 2);
});

test('safeCode only ever lets short UPPER_SNAKE tokens through', () => {
  assert.equal(safeCode('fetch_timeout', 'X'), 'FETCH_TIMEOUT');
  assert.equal(safeCode('connect ECONNREFUSED 10.0.0.5:5432', 'X'), 'X');
  assert.equal(safeCode(null, 'X'), 'X');
  assert.equal(safeCode('A'.repeat(65), 'X'), 'X');
});

// ---------------------------------------------------------------------
// Persistence and concurrency
// ---------------------------------------------------------------------

test('records running first, then one final write with the summary and failures as JSON', async (t) => {
  quiet(t);
  const { deps } = makeDeps({
    scoreLead: async (_pool, id) => {
      if (id === B) throw new Error('x');
      return {};
    },
  });
  const pool = makePool();
  await runSearchPipeline(pool, { searchId: SEARCH_ID, businessIds: [A, B], options: {} }, deps);

  assert.equal(pool.writes.length, 2);
  assert.deepEqual(pool.writes[0], { kind: 'running', params: [SEARCH_ID] });
  assert.equal(pool.writes[1].kind, 'final');
  assert.equal(pool.writes[1].searchId, SEARCH_ID);
  assert.equal(pool.writes[1].status, 'completed_with_errors');
  assert.equal(pool.writes[1].summary.scored, 1);
  assert.deepEqual(pool.writes[1].failures, [{ business_id: B, stage: 'lead_scoring', code: 'SCORING_ERROR' }]);
});

test('if the status cannot be persisted, the stages still run and nothing throws', async (t) => {
  quiet(t);
  const { deps, calls } = makeDeps();
  const result = await runSearchPipeline(
    makePool({ failWrites: true }),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { website_analysis: true } },
    deps
  );
  assert.equal(result.summary.scored, 2);
  assert.equal(calls.filter((c) => c.startsWith('score:')).length, 2);
});

test('never runs more than the configured number of businesses at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { deps } = makeDeps({
    scoreLead: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return {};
    },
    concurrency: 2,
  });
  const ids = Array.from({ length: 9 }, (_, i) => `id-${i}`);
  const result = await runSearchPipeline(makePool(), { searchId: SEARCH_ID, businessIds: ids, options: {} }, deps);

  assert.equal(result.summary.scored, 9);
  assert.equal(maxInFlight, 2);
});

// ---------------------------------------------------------------------
// Background start
// ---------------------------------------------------------------------

test('startSearchPipeline returns the running state immediately, while the stages are still in flight', async () => {
  let releaseScoring;
  const scoringGate = new Promise((resolve) => {
    releaseScoring = resolve;
  });
  const { deps } = makeDeps({
    scoreLead: async () => {
      await scoringGate;
      return {};
    },
  });
  const pool = makePool();

  const initial = await startSearchPipeline(pool, { searchId: SEARCH_ID, businessIds: [A], options: {} }, deps);

  // We got an answer even though scoring has not finished (it is blocked).
  assert.equal(initial.status, 'running');
  assert.equal(initial.completed_at, null);
  assert.deepEqual(initial.failures, []);
  assert.deepEqual(pool.writes.map((w) => w.kind), ['running']);

  releaseScoring();
  const final = await pool.finalWritten;
  assert.equal(final.status, 'completed');
  assert.equal(final.summary.scored, 1);
});

test('startSearchPipeline never rejects, even when every stage and every write fails', async (t) => {
  quiet(t);
  const boom = async () => {
    throw new Error('boom');
  };
  const initial = await startSearchPipeline(
    makePool({ failWrites: true }),
    { searchId: SEARCH_ID, businessIds: [A, B], options: { website_analysis: true, ai_analysis: true } },
    { ...makeDeps().deps, checkBusiness: boom, analyzeWebsite: boom, analyzeOpportunity: boom, scoreLead: boom }
  );
  assert.equal(initial.status, 'running');
  // Let the un-awaited background run settle; an unhandled rejection would fail the test run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

// ---------------------------------------------------------------------
// Startup housekeeping
// ---------------------------------------------------------------------

test('markInterruptedPipelines flips running pipelines to interrupted and reports how many', async () => {
  const pool = makePool({ rowCount: 2 });
  assert.equal(await markInterruptedPipelines(pool), 2);
  assert.deepEqual(pool.writes, [{ kind: 'interrupted' }]);
});

test('markInterruptedPipelines never throws (e.g. migration 008 not applied yet)', async (t) => {
  quiet(t);
  assert.equal(await markInterruptedPipelines(makePool({ failWrites: true })), 0);
});

// ---------------------------------------------------------------------
// Known businesses: skip what has already been done
// ---------------------------------------------------------------------

/** makePool() that also answers the known-business state lookup from `states[businessId]`. */
function makePoolWithState(states, { failLookup = false } = {}) {
  const pool = makePool();
  const base = pool.query.bind(pool);
  pool.lookups = [];
  pool.query = async (sql, params = []) => {
    if (sql.includes('AS website_done')) {
      pool.lookups.push(params[0]);
      if (failLookup) throw new Error('lookup failed');
      const s = states[params[0]];
      return { rows: s ? [{ website_done: s.websiteDone, ai_done: s.aiDone, scored: s.scored }] : [] };
    }
    return base(sql, params);
  };
  return pool;
}

const BOTH = { website_analysis: true, ai_analysis: true };
const DONE = { websiteDone: true, aiDone: true, scored: true };

test('a known business that already has everything requested and a score is skipped; a new one gets every stage', async () => {
  const { deps, calls } = makeDeps();
  const pool = makePoolWithState({ [A]: DONE });
  const result = await runSearchPipeline(
    pool,
    { searchId: SEARCH_ID, businessIds: [A, B], knownBusinessIds: [A], options: BOTH },
    deps
  );

  assert.deepEqual([...calls].sort(), [`ai:${B}`, `analyze:${B}`, `check:${B}`, `score:${B}`]);
  assert.deepEqual(pool.lookups, [A]); // new businesses are never looked up
  assert.equal(result.summary.businesses_total, 2);
  assert.equal(result.summary.businesses_already_known, 1);
  assert.equal(result.summary.businesses_skipped, 1);
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED);
});

test('a known business only gets the stages it has never had, then is re-scored', async () => {
  const { deps, calls } = makeDeps();
  const pool = makePoolWithState({
    [A]: { websiteDone: true, aiDone: false, scored: true }, // needs AI only
    [B]: { websiteDone: false, aiDone: true, scored: true }, // needs website only
  });
  const result = await runSearchPipeline(
    pool,
    { searchId: SEARCH_ID, businessIds: [A, B], knownBusinessIds: [A, B], options: BOTH },
    deps
  );

  assert.deepEqual(
    [...calls].sort(),
    [`ai:${A}`, `analyze:${B}`, `check:${B}`, `score:${A}`, `score:${B}`].sort()
  );
  assert.equal(result.summary.businesses_skipped, 0);
  assert.equal(result.summary.businesses_already_known, 2);
});

test('a known business that was never scored is scored even when there is nothing else to run', async () => {
  const { deps, calls } = makeDeps();
  const pool = makePoolWithState({ [A]: { websiteDone: true, aiDone: true, scored: false } });
  const result = await runSearchPipeline(
    pool,
    { searchId: SEARCH_ID, businessIds: [A], knownBusinessIds: [A], options: BOTH },
    deps
  );

  assert.deepEqual(calls, [`score:${A}`]);
  assert.equal(result.summary.businesses_skipped, 0);
});

test('stages that were not requested are never run for a known business', async () => {
  const { deps, calls } = makeDeps();
  const pool = makePoolWithState({ [A]: { websiteDone: false, aiDone: false, scored: true } });
  await runSearchPipeline(pool, { searchId: SEARCH_ID, businessIds: [A], knownBusinessIds: [A], options: {} }, deps);

  // Nothing requested + already scored -> skipped entirely.
  assert.deepEqual(calls, []);
});

test('if the known-business lookup fails, the business gets every requested stage', async (t) => {
  quiet(t);
  const { deps, calls } = makeDeps();
  const pool = makePoolWithState({}, { failLookup: true });
  const result = await runSearchPipeline(
    pool,
    { searchId: SEARCH_ID, businessIds: [A], knownBusinessIds: [A], options: BOTH },
    deps
  );

  assert.deepEqual([...calls].sort(), [`ai:${A}`, `analyze:${A}`, `check:${A}`, `score:${A}`]);
  assert.equal(result.summary.businesses_skipped, 0);
  assert.equal(result.status, PIPELINE_STATUS.COMPLETED);
});
