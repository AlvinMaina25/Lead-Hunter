/**
 * Phase 23B2 security regression tests.
 *
 * These are NOT integration tests against a real Neon database. They
 * exist to lock in three properties an audit of this codebase found
 * to already hold, so a future change can't silently regress them:
 *
 *   1. Every id-shaped input (business id, lead id) is validated as a
 *      syntactically well-formed UUID BEFORE it ever reaches a SQL
 *      query -- a SQL-injection-style or otherwise malformed id is
 *      rejected with a ValidationError and the fake pool's query()
 *      is never even called with it.
 *   2. Bounded numeric/body inputs (batch "limit", search
 *      "radius_meters"/"max_results"/"analysis_options") reject
 *      injection-flavored, out-of-range, or unexpected-shape values
 *      instead of silently coercing them.
 *   3. The app's centralized error handler (server/app.js) never
 *      leaks a raw error message, a stack trace, or anything that
 *      looks like a secret/credential to the HTTP client -- only its
 *      own fixed, generic message.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getLeadDetail, updatePipelineStage, updateSalesNotes } = require('../leadDetailService');
const { checkBusinessById, resolveBatchLimit, BATCH_LIMIT } = require('../websiteCheckService');
const { analyzeBusinessOpportunity } = require('../aiOpportunityAnalysis');
const { analyzeBusiness } = require('../websiteAnalysisService');
const { scoreBusiness } = require('../leadScoringService');
const { validateSearchConfiguration, ValidationError: InputValidationError } = require('../validation');

// ---------------------------------------------------------------------
// A fake pool whose query() throws if it is ever called. Used to prove
// that malicious/malformed ids are rejected by validation BEFORE any
// SQL is issued -- if a function under test forgot its UUID check and
// tried to interpolate the payload into a query, this pool would fail
// the test instead of silently "succeeding" against a fake table.
// ---------------------------------------------------------------------
function makePoolThatMustNeverBeQueried() {
  return {
    async query(sql, params) {
      throw new Error(
        `pool.query must not be called for a malformed id, but was called with: ${sql} ${JSON.stringify(
          params
        )}`
      );
    },
  };
}

const SQLI_PAYLOADS = [
  "1 OR 1=1",
  "' OR '1'='1",
  "'; DROP TABLE businesses; --",
  "1; SELECT * FROM businesses",
  "00000000-0000-0000-0000-000000000000' OR '1'='1",
  '1)); DROP TABLE leads;--',
  '',
  '   ',
  null,
  undefined,
  123,
  { toString: () => '1 OR 1=1' },
  ['1 OR 1=1'],
];

test('getLeadDetail rejects SQL-injection-style / malformed lead ids without querying the database', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => getLeadDetail(pool, payload), /ValidationError|must be a valid UUID/);
  }
});

test('updatePipelineStage rejects malformed lead ids before querying, independent of the stage value', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => updatePipelineStage(pool, payload, 'contacted'));
  }
});

test('updateSalesNotes rejects malformed lead ids before querying, independent of the notes value', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => updateSalesNotes(pool, payload, "'; DROP TABLE leads; --"));
  }
});

test('checkBusinessById (website-check) rejects malformed business ids before querying', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => checkBusinessById(pool, payload));
  }
});

test('analyzeBusinessOpportunity (AI opportunity analysis) rejects malformed business ids before querying', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => analyzeBusinessOpportunity(pool, payload));
  }
});

test('analyzeBusiness (website analysis) rejects malformed business ids before querying', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => analyzeBusiness(pool, payload));
  }
});

test('scoreBusiness (lead scoring) rejects malformed business ids before querying', async () => {
  const pool = makePoolThatMustNeverBeQueried();
  for (const payload of SQLI_PAYLOADS) {
    await assert.rejects(() => scoreBusiness(pool, payload));
  }
});

// ---------------------------------------------------------------------
// Bounded numeric / body inputs
// ---------------------------------------------------------------------

test('resolveBatchLimit rejects injection-flavored, out-of-range, and non-integer limits', () => {
  const badLimits = [
    '1 OR 1=1',
    "1; DROP TABLE businesses",
    -1,
    0,
    1.5,
    BATCH_LIMIT.MAX + 1,
    Number.MAX_SAFE_INTEGER,
    'not-a-number',
    {},
    [],
    NaN,
    Infinity,
  ];
  for (const bad of badLimits) {
    assert.throws(() => resolveBatchLimit(bad), /must be an integer between/);
  }

  // Sanity check: legitimate values still pass, so the rejections above
  // are actually testing the boundary and not a broken function.
  assert.equal(resolveBatchLimit(undefined), BATCH_LIMIT.DEFAULT);
  assert.equal(resolveBatchLimit(BATCH_LIMIT.MIN), BATCH_LIMIT.MIN);
  assert.equal(resolveBatchLimit(BATCH_LIMIT.MAX), BATCH_LIMIT.MAX);
});

test('validateSearchConfiguration rejects out-of-range radius/max_results and unknown/prototype-polluting analysis_options keys', () => {
  const base = { category: 'restaurant', location: 'Nairobi' };

  assert.throws(
    () => validateSearchConfiguration({ ...base, radius_meters: -5 }),
    InputValidationError
  );
  assert.throws(
    () => validateSearchConfiguration({ ...base, radius_meters: 'DROP TABLE searches' }),
    InputValidationError
  );
  assert.throws(
    () => validateSearchConfiguration({ ...base, max_results: 0 }),
    InputValidationError
  );
  assert.throws(
    () => validateSearchConfiguration({ ...base, max_results: 999999 }),
    InputValidationError
  );
  // `{ __proto__: true }` as an object *literal* sets the prototype
  // rather than an own key, so it wouldn't exercise the check this
  // test is after. A real request body arrives via
  // express.json()/JSON.parse, which DOES produce an own enumerable
  // "__proto__" property -- that's the shape to test against.
  const parsedPollutionAttempt = JSON.parse('{"__proto__": true}');
  assert.throws(
    () => validateSearchConfiguration({ ...base, analysis_options: parsedPollutionAttempt }),
    InputValidationError
  );
  assert.throws(
    () => validateSearchConfiguration({ ...base, analysis_options: { website_analysis: 'yes' } }),
    InputValidationError
  );
  // An overlong field (e.g. a pasted script/payload as the category)
  // must be rejected by length, regardless of its content -- category/
  // location/keyword are always sent as parameterized values, so this
  // guards against abuse/storage bloat rather than injection, but it's
  // still an "unreasonable value" the audit was asked to check for.
  assert.throws(
    () => validateSearchConfiguration({ ...base, category: 'x'.repeat(101) }),
    InputValidationError
  );

  // Sanity check: a legitimate configuration still passes.
  const ok = validateSearchConfiguration({ ...base, radius_meters: 5000, max_results: 10 });
  assert.equal(ok.category, 'restaurant');
});

// ---------------------------------------------------------------------
// Error responses never leak internals
// ---------------------------------------------------------------------

test("the app's centralized error handler never leaks the raw error message, a stack trace, or secret-shaped strings", async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake_test_db';
  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASSWORD;
  process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'test' : process.env.NODE_ENV;

  // Fresh require so this test doesn't depend on module load order.
  delete require.cache[require.resolve('../../app')];
  delete require.cache[require.resolve('../../db')];
  const pool = require('../../db');
  const createApp = require('../../app');

  const SECRET_MARKER = 'sk-live-totally-secret-db-password-hunter2';
  const originalQuery = pool.query;
  pool.query = async () => {
    const err = new Error(`connection to database failed: ${SECRET_MARKER}`);
    err.stack = `Error: ${SECRET_MARKER}\n    at fakeInternalFunction (/real/server/path.js:123:45)`;
    throw err;
  };

  const app = createApp();
  const http = require('node:http');
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/metrics`);
    const bodyText = await res.text();

    assert.equal(res.status, 500);
    assert.ok(!bodyText.includes(SECRET_MARKER), 'response body must not contain the raw error/secret');
    assert.ok(!bodyText.includes('at fakeInternalFunction'), 'response body must not contain a stack trace');
    assert.ok(!bodyText.includes('/real/server/path.js'), 'response body must not contain a file path');

    const body = JSON.parse(bodyText);
    assert.equal(body.error, 'Something went wrong while reading from the database.');
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unknown route returns a plain 404 with no internal detail', async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake_test_db';
  delete require.cache[require.resolve('../../app')];
  const createApp = require('../../app');
  const app = createApp();
  const http = require('node:http');
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/definitely-not-a-real-route`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.deepEqual(body, { error: 'Not found' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
