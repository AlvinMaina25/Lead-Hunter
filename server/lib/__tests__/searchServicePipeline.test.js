const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchHandler, toSearchRecord } = require('../searchService');
const { startSearchPipeline } = require('../searchPipelineService');
const { GooglePlacesError } = require('../googlePlaces');

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

/**
 * In-memory pool for the statements the search handler AND the pipeline's
 * status writes issue. `events` records the order of the handler's
 * important steps so a test can assert the pipeline is started only
 * after the search has been marked completed.
 */
function makeFakePool({ existingBusinesses = [] } = {}) {
  const searches = new Map();
  const businesses = new Map(existingBusinesses.map((b) => [b.external_place_id, { ...b }]));
  const events = [];
  const pipelineWrites = [];
  let resolveFinal;
  const finalWritten = new Promise((resolve) => {
    resolveFinal = resolve;
  });
  let searchSeq = 0;
  let businessSeq = 0;

  return {
    searches,
    events,
    pipelineWrites,
    finalWritten,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('INSERT INTO searches')) {
        const [search_query, category, location, keyword, radius_meters, max_results, web, ai] = params;
        const row = {
          id: `search-${++searchSeq}`,
          search_query, category, location, keyword,
          results_count: 0,
          started_at: '2026-10-13T00:00:00.000Z',
          completed_at: null,
          status: 'running',
          radius_meters, max_results,
          website_analysis_requested: web,
          ai_analysis_requested: ai,
          // Column defaults from migration 008.
          pipeline_status: 'not_run',
          pipeline_started_at: null,
          pipeline_completed_at: null,
          pipeline_summary: null,
          pipeline_failures: [],
        };
        searches.set(row.id, row);
        return { rows: [{ ...row }] };
      }

      if (s.startsWith('UPDATE searches SET results_count')) {
        const [id, count] = params;
        const row = searches.get(id);
        Object.assign(row, { results_count: count, completed_at: '2026-10-13T00:00:05.000Z', status: 'completed' });
        events.push('search-completed');
        return { rows: [{ ...row }] };
      }

      if (s.startsWith("UPDATE searches SET status = 'failed'")) {
        searches.get(params[0]).status = 'failed';
        events.push('search-failed');
        return { rows: [] };
      }

      if (s.startsWith("UPDATE searches SET pipeline_status = 'running'")) {
        pipelineWrites.push('running');
        return { rows: [], rowCount: 1 };
      }

      if (s.startsWith('UPDATE searches SET pipeline_status = $2')) {
        const final = { status: params[1], summary: JSON.parse(params[2]), failures: JSON.parse(params[3]) };
        pipelineWrites.push(final);
        resolveFinal(final);
        return { rows: [], rowCount: 1 };
      }

      if (s.startsWith('INSERT INTO businesses')) {
        if (businesses.has(params[0])) return { rows: [] };
        const [external_place_id, name] = params;
        const row = { id: `biz-new-${++businessSeq}`, external_place_id, name, website_url: null, website_status: 'no_website' };
        businesses.set(external_place_id, row);
        return { rows: [{ ...row }] };
      }

      if (s.includes('FROM businesses WHERE external_place_id')) {
        const row = businesses.get(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }

      if (s.startsWith('INSERT INTO search_results')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL in fake pool: ${s}`);
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function place(id, name) {
  return { id, displayName: { text: name }, location: { latitude: -1.29, longitude: 36.82 } };
}

function makeTextSearch(places) {
  return async () => places;
}

async function post(body, deps) {
  const handler = createSearchHandler(deps);
  const res = makeRes();
  let nextErr;
  await handler({ body }, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

const BASE = { category: 'barbers', location: 'Nairobi' };

let originalKey;
test.beforeEach(() => {
  originalKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
});
test.afterEach(() => {
  if (originalKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = originalKey;
});

const INITIAL_PIPELINE = { status: 'running', started_at: '2026-10-13T00:00:06.000Z', completed_at: null, summary: null, failures: [] };

// ---------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------

test('without a startPipeline dependency the response is exactly what it was: { search, businesses, summary }', async () => {
  const pool = makeFakePool();
  const { res } = await post(BASE, { pool, textSearch: makeTextSearch([place('p1', 'Alpha')]) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['businesses', 'search', 'summary']);
  assert.equal(res.body.search.status, 'completed');
});

test('with a pipeline: same { search, businesses, summary } keys, and only the additive search.pipeline field', async () => {
  const pool = makeFakePool();
  const withoutPipeline = await post(BASE, { pool: makeFakePool(), textSearch: makeTextSearch([place('p1', 'Alpha')]) });
  const { res } = await post(BASE, {
    pool,
    textSearch: makeTextSearch([place('p1', 'Alpha')]),
    startPipeline: async () => INITIAL_PIPELINE,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['businesses', 'search', 'summary']);
  assert.deepEqual(res.body.search.pipeline, INITIAL_PIPELINE);
  assert.deepEqual(res.body.summary, withoutPipeline.res.body.summary);
  assert.deepEqual(res.body.businesses, withoutPipeline.res.body.businesses);

  // Every other field of `search` is identical to the pipeline-less response.
  const { pipeline: _ignored, ...searchWithoutPipeline } = res.body.search;
  const { pipeline: _alsoIgnored, ...baselineSearch } = withoutPipeline.res.body.search;
  assert.deepEqual(searchWithoutPipeline, baselineSearch);
});

// ---------------------------------------------------------------------
// What the pipeline is given
// ---------------------------------------------------------------------

test("the pipeline gets exactly this search's businesses (new and re-found), its search id, and its analysis options", async () => {
  // 'p2' already exists from an earlier search; 'p3' is not part of this search at all.
  const pool = makeFakePool({
    existingBusinesses: [
      { id: 'biz-old-2', external_place_id: 'p2', name: 'Beta', website_url: null, website_status: 'no_website' },
      { id: 'biz-old-3', external_place_id: 'p3', name: 'Unrelated', website_url: null, website_status: 'no_website' },
    ],
  });
  const received = [];

  const { res } = await post(
    { ...BASE, analysis_options: { website_analysis: true, ai_analysis: false } },
    {
      pool,
      textSearch: makeTextSearch([place('p1', 'Alpha'), place('p2', 'Beta')]),
      startPipeline: async (args) => {
        received.push(args);
        return INITIAL_PIPELINE;
      },
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].searchId, 'search-1');
  assert.deepEqual(received[0].businessIds, res.body.businesses.map((b) => b.id));
  assert.equal(received[0].businessIds.length, 2);
  assert.ok(received[0].businessIds.includes('biz-old-2'));
  assert.ok(!received[0].businessIds.includes('biz-old-3'));
  // Only the business that was already in the database is flagged as known.
  assert.deepEqual(received[0].knownBusinessIds, ['biz-old-2']);
  assert.deepEqual(received[0].options, { website_analysis: true, ai_analysis: false });
});

test('with no analysis options requested, the pipeline is still started (scoring always runs), with both options false', async () => {
  const received = [];
  await post(BASE, {
    pool: makeFakePool(),
    textSearch: makeTextSearch([place('p1', 'Alpha')]),
    startPipeline: async (args) => {
      received.push(args);
      return INITIAL_PIPELINE;
    },
  });
  assert.deepEqual(received[0].options, { website_analysis: false, ai_analysis: false });
});

test('the pipeline starts only after the search has been marked completed', async () => {
  const pool = makeFakePool();
  let eventsWhenStarted;
  await post(BASE, {
    pool,
    textSearch: makeTextSearch([place('p1', 'Alpha')]),
    startPipeline: async () => {
      eventsWhenStarted = [...pool.events];
      return INITIAL_PIPELINE;
    },
  });
  assert.deepEqual(eventsWhenStarted, ['search-completed']);
});

// ---------------------------------------------------------------------
// The search never fails because of the pipeline
// ---------------------------------------------------------------------

test('if starting the pipeline throws, the search still succeeds, is not marked failed, and the shape is unchanged', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = makeFakePool();

  const { res, nextErr } = await post(BASE, {
    pool,
    textSearch: makeTextSearch([place('p1', 'Alpha')]),
    startPipeline: async () => {
      throw new Error('pipeline exploded');
    },
  });

  assert.equal(nextErr, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['businesses', 'search', 'summary']);
  assert.equal(res.body.search.status, 'completed');
  assert.equal(res.body.businesses.length, 1);
  assert.ok(!pool.events.includes('search-failed'));
  assert.equal(pool.searches.get('search-1').status, 'completed');
});

test('a failed Google search never starts a pipeline', async () => {
  const received = [];
  const { res } = await post(BASE, {
    pool: makeFakePool(),
    textSearch: async () => {
      throw new GooglePlacesError('Google is down', { statusCode: 502, reason: 'UPSTREAM' });
    },
    startPipeline: async (args) => {
      received.push(args);
      return INITIAL_PIPELINE;
    },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(received.length, 0);
});

test('an invalid configuration (400) never starts a pipeline', async () => {
  const received = [];
  const { res } = await post(
    { ...BASE, max_results: 99 },
    {
      pool: makeFakePool(),
      textSearch: makeTextSearch([]),
      startPipeline: async (args) => {
        received.push(args);
        return INITIAL_PIPELINE;
      },
    }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(received.length, 0);
});

// ---------------------------------------------------------------------
// End to end with the real background starter: the response does not wait
// ---------------------------------------------------------------------

test('the response returns while the pipeline is still working; the outcome lands on the searches row afterwards', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = makeFakePool();

  let releaseScoring;
  const gate = new Promise((resolve) => {
    releaseScoring = resolve;
  });
  const scored = [];
  const deps = {
    concurrency: 2,
    checkBusiness: async () => ({}),
    analyzeWebsite: async () => ({ outcome: 'no_website' }),
    analyzeOpportunity: async () => ({ status: 'completed' }),
    scoreLead: async (_pool, id) => {
      await gate; // blocked: the pipeline cannot finish until we say so
      scored.push(id);
      return {};
    },
  };

  const { res } = await post(
    { ...BASE, analysis_options: { website_analysis: true, ai_analysis: true } },
    {
      pool,
      textSearch: makeTextSearch([place('p1', 'Alpha'), place('p2', 'Beta')]),
      startPipeline: (args) => startSearchPipeline(pool, args, deps),
    }
  );

  // The HTTP response is already here although scoring has not finished.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.search.pipeline.status, 'running');
  assert.equal(res.body.businesses.length, 2);
  assert.deepEqual(scored, []);
  assert.deepEqual(pool.pipelineWrites, ['running']);

  releaseScoring();
  const final = await pool.finalWritten;

  assert.equal(final.status, 'completed');
  assert.equal(final.summary.businesses_total, 2);
  assert.equal(final.summary.scored, 2);
  assert.deepEqual(scored.sort(), res.body.businesses.map((b) => b.id).sort());
});

// ---------------------------------------------------------------------
// toSearchRecord
// ---------------------------------------------------------------------

const BASE_ROW = {
  id: 's1', search_query: 'q', category: 'c', location: 'l', keyword: null, results_count: 1,
  started_at: 't0', completed_at: 't1', status: 'completed', radius_meters: null, max_results: 20,
  website_analysis_requested: true, ai_analysis_requested: false,
};

test('toSearchRecord nests the pipeline_* columns into one `pipeline` object', () => {
  const record = toSearchRecord({
    ...BASE_ROW,
    pipeline_status: 'completed_with_errors',
    pipeline_started_at: 'p0',
    pipeline_completed_at: 'p1',
    pipeline_summary: { scored: 3 },
    pipeline_failures: [{ business_id: 'b', stage: 'ai_analysis', code: 'AI_ERROR' }],
  });

  assert.deepEqual(record.pipeline, {
    status: 'completed_with_errors',
    started_at: 'p0',
    completed_at: 'p1',
    summary: { scored: 3 },
    failures: [{ business_id: 'b', stage: 'ai_analysis', code: 'AI_ERROR' }],
  });
  assert.ok(!('pipeline_status' in record));
  assert.ok(!('pipeline_failures' in record));
  assert.deepEqual(record.analysis_options, { website_analysis: true, ai_analysis: false });
});

test('toSearchRecord: a never-run search reads status not_run with empty failures, never null/undefined failures', () => {
  const record = toSearchRecord({
    ...BASE_ROW,
    pipeline_status: 'not_run',
    pipeline_started_at: null,
    pipeline_completed_at: null,
    pipeline_summary: null,
    pipeline_failures: null,
  });
  assert.deepEqual(record.pipeline, { status: 'not_run', started_at: null, completed_at: null, summary: null, failures: [] });
});

test('toSearchRecord: a row without the pipeline columns maps exactly as before (no `pipeline` key)', () => {
  const record = toSearchRecord(BASE_ROW);
  assert.ok(!('pipeline' in record));
  assert.deepEqual(Object.keys(record).sort(), [
    'analysis_options', 'category', 'completed_at', 'id', 'keyword', 'location', 'max_results',
    'radius_meters', 'results_count', 'search_query', 'started_at', 'status',
  ]);
});
