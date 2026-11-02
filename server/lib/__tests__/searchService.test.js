const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchHandler, toSearchRecord } = require('../searchService');
const { GooglePlacesError } = require('../googlePlaces');

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

/**
 * A minimal in-memory stand-in for the Postgres pool that understands
 * exactly the statements searchService.js issues against `searches`,
 * `businesses` and `search_results`. It applies the same column
 * defaults the migrations define (status/results_count, and 007's
 * max_results = 20 / *_requested = false), so a test can check what
 * would actually be persisted. Every SQL string is recorded in `calls`.
 */
function makeFakePool({ existingBusinesses = [] } = {}) {
  const searches = new Map();
  const businesses = new Map(existingBusinesses.map((b) => [b.external_place_id, { ...b }]));
  const searchResults = [];
  const calls = [];
  let searchSeq = 0;
  let businessSeq = 0;

  function insertBusiness(values) {
    const [external_place_id, name, category, phone, address, city, country, latitude, longitude, google_maps_url, google_rating, google_review_count, website_url, website_status] = values;
    const row = {
      id: `biz-${++businessSeq}`,
      external_place_id, name, category, phone, email: null, address, city, country,
      latitude, longitude, google_maps_url, google_rating, google_review_count,
      website_url, website_status,
      created_at: '2026-09-24T00:00:00.000Z',
      updated_at: '2026-09-24T00:00:00.000Z',
    };
    businesses.set(external_place_id, row);
    return row;
  }

  return {
    searches,
    businesses,
    searchResults,
    calls,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s);

      if (s.startsWith('INSERT INTO searches')) {
        const [search_query, category, location, keyword, radius_meters, max_results, web, ai] = params;
        const row = {
          id: `search-${++searchSeq}`,
          search_query, category, location, keyword,
          results_count: 0,
          started_at: '2026-09-24T00:00:00.000Z',
          completed_at: null,
          status: 'running',
          radius_meters,
          max_results,
          website_analysis_requested: web,
          ai_analysis_requested: ai,
        };
        searches.set(row.id, row);
        return { rows: [{ ...row }] };
      }

      if (s.startsWith('UPDATE searches SET results_count')) {
        const [id, count] = params;
        const row = searches.get(id);
        Object.assign(row, { results_count: count, completed_at: '2026-09-24T00:00:05.000Z', status: 'completed' });
        return { rows: [{ ...row }] };
      }

      if (s.startsWith("UPDATE searches SET status = 'failed'")) {
        const row = searches.get(params[0]);
        Object.assign(row, { status: 'failed', completed_at: '2026-09-24T00:00:05.000Z' });
        return { rows: [] };
      }

      if (s.startsWith('INSERT INTO businesses')) {
        if (businesses.has(params[0])) return { rows: [] }; // ON CONFLICT DO NOTHING
        return { rows: [insertBusiness(params)] };
      }

      if (s.includes('FROM businesses WHERE external_place_id')) {
        const row = businesses.get(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }

      if (s.startsWith('INSERT INTO search_results')) {
        const [search_id, business_id, rank_position] = params;
        searchResults.push({ search_id, business_id, rank_position });
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

const NAIROBI = { latitude: -1.2921, longitude: 36.8219 };

/** A raw Google place `metersNorth` metres north of Nairobi's centre (0.01 deg latitude ~ 1112 m). */
function place(id, name, degreesNorth = 0.005, extra = {}) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `${name}, Nairobi, Kenya`,
    location: { latitude: NAIROBI.latitude + degreesNorth, longitude: NAIROBI.longitude },
    primaryTypeDisplayName: { text: 'Barber shop' },
    ...extra,
  };
}

/**
 * Fake of googlePlaces.textSearch. Records every call. A call asking
 * only for `places.location` (the centre lookup) gets `center`;
 * everything else gets `places`.
 */
function makeFakeTextSearch({ places = [], center = NAIROBI, failWith = null } = {}) {
  const calls = [];
  async function textSearch(query, options = {}) {
    calls.push({ query, options });
    if (failWith) throw failWith;
    if (options.fieldMask === 'places.location') {
      return center ? [{ location: center }] : [];
    }
    return places;
  }
  textSearch.calls = calls;
  return textSearch;
}

async function post(body, { pool = makeFakePool(), textSearch = makeFakeTextSearch() } = {}) {
  const handler = createSearchHandler({ pool, textSearch });
  const res = makeRes();
  let nextErr;
  await handler({ body }, res, (err) => {
    nextErr = err;
  });
  return { res, pool, textSearch, nextErr };
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

// ---------------------------------------------------------------------
// Validation -> HTTP 400 (nothing is persisted, Google is never called)
// ---------------------------------------------------------------------

const BAD_REQUESTS = [
  ['missing category', { location: 'Nairobi' }, /"category" is required/],
  ['missing location', { category: 'barbers' }, /"location" is required/],
  ['invalid radius (zero)', { ...BASE, radius_meters: 0 }, /"radius_meters"/],
  ['invalid radius (too large)', { ...BASE, radius_meters: 50001 }, /"radius_meters"/],
  ['invalid radius (string)', { ...BASE, radius_meters: '5000' }, /"radius_meters"/],
  ['invalid max_results (zero)', { ...BASE, max_results: 0 }, /"max_results"/],
  ['invalid max_results (too many)', { ...BASE, max_results: 51 }, /"max_results"/],
  ['invalid max_results (fraction)', { ...BASE, max_results: 1.5 }, /"max_results"/],
  ['invalid analysis_options (not an object)', { ...BASE, analysis_options: 'yes' }, /"analysis_options"/],
  ['invalid analysis_options (non-boolean flag)', { ...BASE, analysis_options: { ai_analysis: 'true' } }, /"analysis_options.ai_analysis"/],
  ['invalid analysis_options (unknown key)', { ...BASE, analysis_options: { scoring: true } }, /"analysis_options.scoring"/],
  ['non-object body', 'barbers', /JSON object/],
];

for (const [name, body, pattern] of BAD_REQUESTS) {
  test(`POST /api/searches: ${name} -> 400 with a clear error, nothing stored, Google not called`, async () => {
    const { res, pool, textSearch, nextErr } = await post(body);
    assert.equal(nextErr, undefined);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, pattern);
    assert.equal(pool.calls.length, 0);
    assert.equal(textSearch.calls.length, 0);
  });
}

test('POST /api/searches: 503 when GOOGLE_PLACES_API_KEY is not configured (unchanged behavior)', async () => {
  delete process.env.GOOGLE_PLACES_API_KEY;
  const { res, pool } = await post(BASE);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /GOOGLE_PLACES_API_KEY/);
  assert.equal(pool.calls.length, 0);
});

// ---------------------------------------------------------------------
// Backward compatibility: a Phase 7 caller
// ---------------------------------------------------------------------

test('POST /api/searches: a Phase 7 body { category, location, keyword } still works and asks Google for exactly what it used to', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'Alpha Cuts'), place('p2', 'Beta Barbers')] });
  const { res, pool } = await post({ category: 'barbers', location: 'Nairobi', keyword: 'premium' }, { textSearch });

  assert.equal(res.statusCode, 200);

  // One Google call, same query text, same page size (20), no location bias.
  assert.deepEqual(textSearch.calls, [{ query: 'premium barbers in Nairobi', options: { maxResultCount: 20 } }]);

  // Every field the old response had is still there.
  const { search, businesses } = res.body;
  assert.equal(search.id, 'search-1');
  assert.equal(search.search_query, 'premium barbers in Nairobi');
  assert.equal(search.category, 'barbers');
  assert.equal(search.location, 'Nairobi');
  assert.equal(search.results_count, 2);
  assert.ok(search.started_at);
  assert.ok(search.completed_at);
  assert.equal(search.status, 'completed');
  assert.deepEqual(businesses.map((b) => [b.name, b.isNew]), [['Alpha Cuts', true], ['Beta Barbers', true]]);
  assert.equal(businesses[0].external_place_id, 'p1');

  // Defaults were persisted, no analysis was requested.
  const stored = pool.searches.get('search-1');
  assert.equal(stored.radius_meters, null);
  assert.equal(stored.max_results, 20);
  assert.equal(stored.website_analysis_requested, false);
  assert.equal(stored.ai_analysis_requested, false);
});

test('POST /api/searches: an already-known business is reused and reported isNew: false', async () => {
  const pool = makeFakePool({
    existingBusinesses: [{ id: 'biz-existing', external_place_id: 'p1', name: 'Alpha Cuts' }],
  });
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'Alpha Cuts')] });
  const { res } = await post(BASE, { pool, textSearch });

  assert.equal(res.body.businesses.length, 1);
  assert.equal(res.body.businesses[0].id, 'biz-existing');
  assert.equal(res.body.businesses[0].isNew, false);
  assert.deepEqual(pool.searchResults, [{ search_id: 'search-1', business_id: 'biz-existing', rank_position: 1 }]);
});

test('POST /api/searches: Google places without an id or name are skipped, not stored', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'Alpha Cuts'), { id: 'p2' }, { displayName: { text: 'No id' } }] });
  const { res, pool } = await post(BASE, { textSearch });
  assert.equal(res.body.businesses.length, 1);
  assert.equal(pool.searchResults.length, 1);
});

// ---------------------------------------------------------------------
// Successful manual search with a full configuration + persistence
// ---------------------------------------------------------------------

test('POST /api/searches: a full configuration is persisted on the searches row and echoed in the response', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'Alpha Cuts', 0.005), place('p2', 'Beta Barbers', 0.01)] });
  const { res, pool } = await post(
    {
      category: 'barbers',
      location: 'Nairobi',
      keyword: 'premium',
      radius_meters: 5000,
      max_results: 10,
      analysis_options: { website_analysis: true, ai_analysis: true },
    },
    { textSearch }
  );

  assert.equal(res.statusCode, 200);

  // Persisted (what a later pipeline stage / the history view reads).
  assert.deepEqual(pool.searches.get('search-1'), {
    id: 'search-1',
    search_query: 'premium barbers in Nairobi',
    category: 'barbers',
    location: 'Nairobi',
    keyword: 'premium',
    results_count: 2,
    started_at: '2026-09-24T00:00:00.000Z',
    completed_at: '2026-09-24T00:00:05.000Z',
    status: 'completed',
    radius_meters: 5000,
    max_results: 10,
    website_analysis_requested: true,
    ai_analysis_requested: true,
  });

  // Returned to the frontend with the two flags nested as analysis_options.
  assert.deepEqual(res.body.search, {
    id: 'search-1',
    search_query: 'premium barbers in Nairobi',
    category: 'barbers',
    location: 'Nairobi',
    keyword: 'premium',
    results_count: 2,
    started_at: '2026-09-24T00:00:00.000Z',
    completed_at: '2026-09-24T00:00:05.000Z',
    status: 'completed',
    radius_meters: 5000,
    max_results: 10,
    analysis_options: { website_analysis: true, ai_analysis: true },
  });
  assert.deepEqual(res.body.summary, { places_returned: 2, excluded_outside_radius: 0, results_count: 2 });
  assert.deepEqual(pool.searchResults.map((r) => r.rank_position), [1, 2]);
});

test('POST /api/searches: analysis options are stored only -- no website or AI analysis is run and no Google call is made for them', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'Alpha Cuts')] });
  const { res, pool } = await post(
    { ...BASE, analysis_options: { website_analysis: true, ai_analysis: true } },
    { textSearch }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(textSearch.calls.length, 1); // the search itself, nothing else
  assert.ok(!pool.calls.some((sql) => /website_analysis|ai_analysis/i.test(sql.replace(/website_analysis_requested|ai_analysis_requested/g, ''))));
});

// ---------------------------------------------------------------------
// max_results
// ---------------------------------------------------------------------

test('POST /api/searches: without a radius, max_results is what Google is asked for', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'A'), place('p2', 'B'), place('p3', 'C')] });
  await post({ ...BASE, max_results: 3 }, { textSearch });
  assert.deepEqual(textSearch.calls, [{ query: 'barbers in Nairobi', options: { maxResultCount: 3 } }]);
});

test('POST /api/searches: stores places concurrently but keeps Google order and ranks', async () => {
  const places = Array.from({ length: 12 }, (_, i) => place(`p${i}`, `Barber ${i}`));
  const textSearch = makeFakeTextSearch({ places });
  const { res, pool } = await post({ ...BASE, max_results: 12 }, { textSearch });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.businesses.map((b) => b.name), places.map((p) => p.displayName.text));
  assert.equal(res.body.search.results_count, 12);
});

test('POST /api/searches: max_results of 50 is accepted and passed through to Google', async () => {
  const places = Array.from({ length: 50 }, (_, i) => place(`p${i}`, `Barber ${i}`));
  const textSearch = makeFakeTextSearch({ places });
  const { res } = await post({ ...BASE, max_results: 50 }, { textSearch });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(textSearch.calls, [{ query: 'barbers in Nairobi', options: { maxResultCount: 50 } }]);
  assert.equal(res.body.businesses.length, 50);
});

test('POST /api/searches: results are capped at max_results even if Google returns more', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('p1', 'A'), place('p2', 'B'), place('p3', 'C'), place('p4', 'D')] });
  const { res, pool } = await post({ ...BASE, max_results: 2 }, { textSearch });

  assert.deepEqual(res.body.businesses.map((b) => b.name), ['A', 'B']);
  assert.equal(res.body.search.results_count, 2);
  assert.equal(pool.searchResults.length, 2);
});

// ---------------------------------------------------------------------
// radius
// ---------------------------------------------------------------------

test('POST /api/searches: a radius resolves the location centre once, biases the query to that circle, and keeps only places inside it', async () => {
  const textSearch = makeFakeTextSearch({
    places: [
      place('near', 'Near Barbers', 0.01), // ~1.1 km
      place('edge', 'Edge Barbers', 0.04), // ~4.4 km
      place('far', 'Far Barbers', 0.1), // ~11 km
      place('nocoords', 'No Coords', 0, { location: undefined }),
    ],
  });
  const { res, pool } = await post({ ...BASE, radius_meters: 5000 }, { textSearch });

  assert.equal(res.statusCode, 200);

  assert.deepEqual(textSearch.calls, [
    { query: 'Nairobi', options: { maxResultCount: 1, fieldMask: 'places.location' } },
    {
      query: 'barbers in Nairobi',
      options: { maxResultCount: 20, locationBias: { ...NAIROBI, radius: 5000 } },
    },
  ]);

  assert.deepEqual(res.body.businesses.map((b) => b.name), ['Near Barbers', 'Edge Barbers']);
  assert.deepEqual(res.body.summary, { places_returned: 4, excluded_outside_radius: 2, results_count: 2 });
  assert.equal(pool.searches.get('search-1').radius_meters, 5000);
});

test('POST /api/searches: only_without_website asks Google for 50, keeps only places with no websiteUri, and reports how many were excluded', async () => {
  const textSearch = makeFakeTextSearch({
    places: [
      place('a', 'Has Site', 0.001, { websiteUri: 'https://a.example.com' }),
      place('b', 'No Site One', 0.002),
      place('c', 'Has Site Too', 0.003, { websiteUri: 'https://c.example.com' }),
      place('d', 'No Site Two', 0.004),
    ],
  });
  const { res } = await post({ ...BASE, max_results: 5, only_without_website: true }, { textSearch });

  assert.equal(res.statusCode, 200);
  assert.equal(textSearch.calls[0].options.maxResultCount, 50);
  assert.deepEqual(res.body.businesses.map((b) => b.name), ['No Site One', 'No Site Two']);
  assert.deepEqual(res.body.summary, {
    places_returned: 4,
    excluded_outside_radius: 0,
    excluded_with_website: 2,
    results_count: 2,
  });
});

test('POST /api/searches: only_without_website combines with a radius and still honours max_results', async () => {
  const textSearch = makeFakeTextSearch({
    places: [
      place('a', 'Near No Site', 0.001),
      place('b', 'Near Has Site', 0.002, { websiteUri: 'https://b.example.com' }),
      place('c', 'Far No Site', 0.1),
      place('d', 'Near No Site Two', 0.003),
    ],
  });
  const { res } = await post({ ...BASE, radius_meters: 5000, max_results: 1, only_without_website: true }, { textSearch });

  assert.deepEqual(res.body.businesses.map((b) => b.name), ['Near No Site']);
  assert.equal(res.body.summary.excluded_outside_radius, 1);
  assert.equal(res.body.summary.excluded_with_website, 1);
});

test('POST /api/searches: with a radius, max_results still caps the kept list', async () => {
  const textSearch = makeFakeTextSearch({ places: [place('a', 'A', 0.001), place('b', 'B', 0.002), place('c', 'C', 0.003)] });
  const { res } = await post({ ...BASE, radius_meters: 5000, max_results: 2 }, { textSearch });
  assert.deepEqual(res.body.businesses.map((b) => b.name), ['A', 'B']);
});

test('POST /api/searches: a radius whose location cannot be located -> 422, search marked failed, no businesses searched', async () => {
  const textSearch = makeFakeTextSearch({ center: null, places: [place('p1', 'Alpha Cuts')] });
  const { res, pool } = await post({ ...BASE, location: 'Atlantis', radius_meters: 2000 }, { textSearch });

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /Could not find map coordinates for "Atlantis"/);
  assert.equal(res.body.searchId, 'search-1');
  assert.equal(pool.searches.get('search-1').status, 'failed');
  assert.equal(pool.searchResults.length, 0);
  assert.equal(textSearch.calls.length, 1); // only the centre lookup
});

// ---------------------------------------------------------------------
// Google failures (existing behavior)
// ---------------------------------------------------------------------

test('POST /api/searches: a Google failure marks the search failed and reports the Google status with the searchId', async () => {
  const failWith = new GooglePlacesError('Google Places API rate limit reached. Please try again later.', {
    statusCode: 429,
    reason: 'RATE_LIMITED',
  });
  const { res, pool } = await post(BASE, { textSearch: makeFakeTextSearch({ failWith }) });

  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: failWith.message, searchId: 'search-1' });
  const stored = pool.searches.get('search-1');
  assert.equal(stored.status, 'failed');
  // The configuration is still recorded on a failed search.
  assert.equal(stored.category, 'barbers');
  assert.equal(stored.max_results, 20);
});

test('POST /api/searches: an unexpected error goes to next() (generic 500) after the search is marked failed', async () => {
  const boom = new Error('kaboom');
  const { res, pool, nextErr } = await post(BASE, { textSearch: makeFakeTextSearch({ failWith: boom }) });

  assert.equal(nextErr, boom);
  assert.equal(res.body, undefined);
  assert.equal(pool.searches.get('search-1').status, 'failed');
});

// ---------------------------------------------------------------------
// toSearchRecord (also used by GET /api/searches)
// ---------------------------------------------------------------------

test('toSearchRecord: nests the two *_requested columns as analysis_options and keeps every other column', () => {
  const row = {
    id: 's1', search_query: 'q', category: 'c', location: 'l', keyword: null, results_count: 3,
    started_at: 'a', completed_at: null, status: 'running', radius_meters: null, max_results: 20,
    website_analysis_requested: true, ai_analysis_requested: false,
  };
  const record = toSearchRecord(row);

  assert.deepEqual(record.analysis_options, { website_analysis: true, ai_analysis: false });
  assert.ok(!('website_analysis_requested' in record));
  assert.ok(!('ai_analysis_requested' in record));
  for (const key of ['id', 'search_query', 'category', 'location', 'keyword', 'results_count', 'started_at', 'completed_at', 'status', 'radius_meters', 'max_results']) {
    assert.equal(record[key], row[key]);
  }
});
