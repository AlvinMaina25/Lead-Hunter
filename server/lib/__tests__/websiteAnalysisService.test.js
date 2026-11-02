const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRECHECK_OUTCOME,
  NotFoundError,
  ValidationError,
  checkEligibility,
  analyzeBusiness,
  classifyAnalyzedResult,
  analyzeBusinessBatch,
} = require('../websiteAnalysisService');

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const BUSINESS_ID_2 = '22222222-2222-4222-8222-222222222222';

// -----------------------------------------------------------------------
// Fake pool -- mirrors the one in websiteAnalysis.test.js so both test
// files exercise the exact same INSERT shape the real engine uses.
// -----------------------------------------------------------------------

function makeFakePool(initialBusinesses, { failInsert = false } = {}) {
  const businesses = new Map(initialBusinesses.map((b) => [b.id, { ...b }]));
  const analyses = [];

  async function query(sql, params = []) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (normalizedSql.startsWith('SELECT id, website_url, website_status FROM businesses WHERE id = $1')) {
      const row = businesses.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalizedSql.startsWith('SELECT id FROM businesses WHERE website_status')) {
      const limit = params[0];
      const rows = [...businesses.values()]
        .filter((b) => b.website_status === 'reachable')
        .slice(0, limit)
        .map((b) => ({ id: b.id }));
      return { rows };
    }

    if (normalizedSql.startsWith('INSERT INTO website_analysis')) {
      if (failInsert) {
        throw new Error('simulated database failure');
      }
      const row = {
        id: `analysis-${analyses.length + 1}`,
        business_id: params[0],
        analyzed_url: params[1],
        performance_score: params[2],
        accessibility_score: params[3],
        seo_score: params[4],
        best_practices_score: params[5],
        mobile_indicator: params[6],
        https_enabled: params[7],
        page_title: params[8],
        meta_description: params[9],
        viewport_present: params[10],
        html_size_bytes: params[11],
        response_time_ms: params[12],
        http_status: params[13],
        raw_analysis_response: params[14] ? JSON.parse(params[14]) : null,
        analysis_status: params[15],
        error_code: params[16],
        error_message: params[17],
      };
      analyses.push(row);
      return { rows: [row] };
    }

    throw new Error(`FakePool: unrecognized query: ${normalizedSql}`);
  }

  return { query, _analyses: analyses };
}

/** A homepage fetch stub that never touches the network. */
function completedHomepage(overrides = {}) {
  return async () => ({
    status: 'completed',
    finalUrl: 'https://example.com/',
    httpStatus: 200,
    httpsEnabled: true,
    responseTimeMs: 150,
    htmlSizeBytes: 2048,
    truncated: false,
    pageTitle: 'Example',
    metaDescription: 'An example business',
    viewportPresent: true,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  });
}

// -----------------------------------------------------------------------
// 1 & 6 & 7. valid business, reachable -> stored URL used, no client
// override possible (analyzeBusiness takes no URL parameter at all)
// -----------------------------------------------------------------------

test('analyzeBusiness: reachable business is analyzed using ONLY its stored website_url', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://good.example.com', website_status: 'reachable' },
  ]);

  let urlPassedToFetch = null;
  const result = await analyzeBusiness(pool, BUSINESS_ID, {
    fetchHomepage: async (url) => {
      urlPassedToFetch = url;
      return completedHomepage()();
    },
  });

  assert.equal(urlPassedToFetch, 'https://good.example.com');
  assert.equal(result.outcome, 'analyzed');
  assert.equal(result.row.analysis_status, 'completed');
});

// -----------------------------------------------------------------------
// 2. business not found
// -----------------------------------------------------------------------

test('analyzeBusiness: throws NotFoundError for an unknown business id', async () => {
  const pool = makeFakePool([]);
  await assert.rejects(() => analyzeBusiness(pool, BUSINESS_ID), NotFoundError);
});

// -----------------------------------------------------------------------
// 3. no website -- precheck short-circuits, engine never called, no row stored
// -----------------------------------------------------------------------

test('analyzeBusiness: business with no website_url -> "no_website" outcome without calling the engine', async () => {
  const pool = makeFakePool([{ id: BUSINESS_ID, website_url: null, website_status: 'no_website' }]);

  let fetchCalled = false;
  const result = await analyzeBusiness(pool, BUSINESS_ID, {
    fetchHomepage: async () => {
      fetchCalled = true;
      return completedHomepage()();
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.outcome, PRECHECK_OUTCOME.NO_WEBSITE);
  assert.equal(pool._analyses.length, 0, 'no row should be written when there is nothing to analyze');
});

// -----------------------------------------------------------------------
// 4. not reachable -- precheck short-circuits, engine never called
// -----------------------------------------------------------------------

test('analyzeBusiness: website not currently reachable -> "not_reachable" outcome without calling the engine', async () => {
  for (const status of ['unreachable', 'unknown']) {
    const pool = makeFakePool([{ id: BUSINESS_ID, website_url: 'https://example.com', website_status: status }]);

    let fetchCalled = false;
    // eslint-disable-next-line no-await-in-loop
    const result = await analyzeBusiness(pool, BUSINESS_ID, {
      fetchHomepage: async () => {
        fetchCalled = true;
        return completedHomepage()();
      },
    });

    assert.equal(fetchCalled, false, `status=${status}`);
    assert.equal(result.outcome, PRECHECK_OUTCOME.NOT_REACHABLE, `status=${status}`);
    assert.equal(pool._analyses.length, 0, `status=${status}`);
  }
});

// -----------------------------------------------------------------------
// 5. invalid UUID -- rejected before any query is made
// -----------------------------------------------------------------------

test('analyzeBusiness: rejects a malformed business id without querying the database', async () => {
  const pool = {
    query: async () => {
      throw new Error('pool.query should never be called for an invalid id');
    },
  };
  await assert.rejects(() => analyzeBusiness(pool, 'not-a-uuid'), ValidationError);
});

// -----------------------------------------------------------------------
// 8 & 9. successful analysis stored; previous analyses preserved (new row each time)
// -----------------------------------------------------------------------

test('analyzeBusiness: each call writes a NEW row, never overwriting a previous analysis', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' },
  ]);
  const opts = { fetchHomepage: completedHomepage() };

  const first = await analyzeBusiness(pool, BUSINESS_ID, opts);
  const second = await analyzeBusiness(pool, BUSINESS_ID, opts);

  assert.equal(pool._analyses.length, 2);
  assert.notEqual(first.row.id, second.row.id);
});

// -----------------------------------------------------------------------
// classifyAnalyzedResult: HTTP status mapping for stored outcomes
// -----------------------------------------------------------------------

function rowWith({ analysisStatus = 'completed', pagespeed = null }) {
  return {
    analysis_status: analysisStatus,
    raw_analysis_response: { homepage: {}, pagespeed },
  };
}

test('classifyAnalyzedResult: a normal completed analysis -> 200', () => {
  assert.equal(classifyAnalyzedResult(rowWith({})).httpStatus, 200);
});

test('classifyAnalyzedResult: homepage-level "unavailable" -> 503', () => {
  assert.equal(classifyAnalyzedResult(rowWith({ analysisStatus: 'unavailable' })).httpStatus, 503);
});

// 10. PageSpeed rate limit -> 429
test('classifyAnalyzedResult: PageSpeed rate_limited -> 429', () => {
  const row = rowWith({ pagespeed: { status: 'rate_limited', errorCode: 'RESOURCE_EXHAUSTED' } });
  assert.equal(classifyAnalyzedResult(row).httpStatus, 429);
});

// 11. PageSpeed timeout -> still a recorded outcome, 200
test('classifyAnalyzedResult: PageSpeed timeout -> 200 (still a recorded, stored outcome)', () => {
  const row = rowWith({ pagespeed: { status: 'timeout', errorCode: 'TIMEOUT' } });
  assert.equal(classifyAnalyzedResult(row).httpStatus, 200);
});

// 12. PageSpeed unavailable -> 503
test('classifyAnalyzedResult: PageSpeed unavailable -> 503', () => {
  const row = rowWith({ pagespeed: { status: 'unavailable', errorCode: 'NETWORK_ERROR' } });
  assert.equal(classifyAnalyzedResult(row).httpStatus, 503);
});

// 13. malformed PageSpeed response -> engine records this as 'failed' -> 200
test('classifyAnalyzedResult: malformed PageSpeed response ("failed") -> 200', () => {
  const row = rowWith({ pagespeed: { status: 'failed', errorCode: 'MALFORMED_RESPONSE' } });
  assert.equal(classifyAnalyzedResult(row).httpStatus, 200);
});

// 14. missing PAGESPEED_API_KEY -> engine records this as PageSpeed 'unavailable' -> 503
test('classifyAnalyzedResult: missing PAGESPEED_API_KEY ("unavailable") -> 503', () => {
  const row = rowWith({ pagespeed: { status: 'unavailable', errorCode: 'MISSING_API_KEY' } });
  assert.equal(classifyAnalyzedResult(row).httpStatus, 503);
});

// -----------------------------------------------------------------------
// 15. SSRF rejection -- surfaces through analyzeBusiness as a normal
// stored 'blocked' row (the engine's own SSRF guard already does the
// actual blocking; this just confirms this module doesn't intercept or
// hide that outcome).
// -----------------------------------------------------------------------

test('analyzeBusiness: an SSRF-blocked homepage fetch is still stored and returned as "analyzed"', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' },
  ]);

  const result = await analyzeBusiness(pool, BUSINESS_ID, {
    fetchHomepage: async () => ({
      status: 'blocked',
      finalUrl: 'https://example.com',
      httpStatus: null,
      httpsEnabled: null,
      responseTimeMs: null,
      htmlSizeBytes: null,
      truncated: false,
      pageTitle: null,
      metaDescription: null,
      viewportPresent: null,
      errorCode: 'SSRF_BLOCKED',
      errorMessage: 'The target address is not permitted for analysis.',
    }),
  });

  assert.equal(result.outcome, 'analyzed');
  assert.equal(result.row.analysis_status, 'blocked');
  assert.equal(result.row.error_code, 'SSRF_BLOCKED');
  assert.equal(classifyAnalyzedResult(result.row).httpStatus, 200);
});

// -----------------------------------------------------------------------
// 16. database failure -- propagates out of analyzeBusiness (the route
// layer maps this to a 500 via its centralized error handler).
// -----------------------------------------------------------------------

test('analyzeBusiness: a database failure while persisting the row propagates to the caller', async () => {
  const pool = makeFakePool(
    [{ id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' }],
    { failInsert: true }
  );

  await assert.rejects(
    () => analyzeBusiness(pool, BUSINESS_ID, { fetchHomepage: completedHomepage() }),
    /simulated database failure/
  );
});

// -----------------------------------------------------------------------
// checkEligibility -- exercised directly for completeness
// -----------------------------------------------------------------------

test('checkEligibility: reachable business -> eligible: true', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' },
  ]);
  const result = await checkEligibility(pool, BUSINESS_ID);
  assert.equal(result.eligible, true);
});

// -----------------------------------------------------------------------
// Batch endpoint
// -----------------------------------------------------------------------

test('analyzeBusinessBatch: only analyzes businesses whose website_status is reachable', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://a.example.com', website_status: 'reachable' },
    { id: BUSINESS_ID_2, website_url: 'https://b.example.com', website_status: 'unreachable' },
  ]);

  const result = await analyzeBusinessBatch(pool, {}, { fetchHomepage: completedHomepage() });

  assert.equal(result.businesses_found, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].business_id, BUSINESS_ID);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].analysis_status, 'completed');
});

test('analyzeBusinessBatch: default limit is 20, rejects an out-of-range limit', async () => {
  const pool = makeFakePool([]);
  const result = await analyzeBusinessBatch(pool, {}, { fetchHomepage: completedHomepage() });
  assert.equal(result.requested_limit, 20);

  await assert.rejects(() => analyzeBusinessBatch(pool, { limit: 51 }, {}), ValidationError);
});

test('analyzeBusinessBatch: one business failing to persist does not abort the rest of the batch', async () => {
  const pool = makeFakePool(
    [
      { id: BUSINESS_ID, website_url: 'https://a.example.com', website_status: 'reachable' },
      { id: BUSINESS_ID_2, website_url: 'https://b.example.com', website_status: 'reachable' },
    ],
    { failInsert: true }
  );

  const result = await analyzeBusinessBatch(pool, {}, { fetchHomepage: completedHomepage() });

  assert.equal(result.businesses_found, 2);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.ok === false && r.error_code === 'ANALYSIS_ERROR'));
});

test('analyzeBusinessBatch: each business gets its own historical row (never overwritten)', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://a.example.com', website_status: 'reachable' },
    { id: BUSINESS_ID_2, website_url: 'https://b.example.com', website_status: 'reachable' },
  ]);

  await analyzeBusinessBatch(pool, {}, { fetchHomepage: completedHomepage() });
  assert.equal(pool._analyses.length, 2);

  await analyzeBusinessBatch(pool, {}, { fetchHomepage: completedHomepage() });
  assert.equal(pool._analyses.length, 4, 'a second batch run should add new rows, not replace the first set');
});
