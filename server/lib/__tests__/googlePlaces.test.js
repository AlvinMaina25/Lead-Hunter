const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate module state (process.env.GOOGLE_PLACES_API_KEY, global.fetch)
// per test by re-requiring fresh each time via a helper.
function loadModule() {
  return require('../googlePlaces');
}

function mockFetchOnce(implementation) {
  const original = global.fetch;
  global.fetch = implementation;
  return () => {
    global.fetch = original;
  };
}

test('buildSearchQuery without a keyword', () => {
  const { buildSearchQuery } = loadModule();
  assert.equal(
    buildSearchQuery({ category: 'barbers', location: 'Nairobi', keyword: '' }),
    'barbers in Nairobi'
  );
});

test('buildSearchQuery with a keyword', () => {
  const { buildSearchQuery } = loadModule();
  assert.equal(
    buildSearchQuery({ category: 'barbers', location: 'Nairobi', keyword: 'premium' }),
    'premium barbers in Nairobi'
  );
});

test('textSearch throws MISSING_API_KEY when the env var is unset', async () => {
  const { textSearch, GooglePlacesError } = loadModule();
  const original = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'MISSING_API_KEY' && err.statusCode === 503
    );
  } finally {
    if (original !== undefined) process.env.GOOGLE_PLACES_API_KEY = original;
  }
});

test('textSearch returns places[] on success', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ places: [{ id: 'ChIJ1' }, { id: 'ChIJ2' }] }),
  }));

  try {
    const places = await textSearch('barbers in Nairobi');
    assert.equal(places.length, 2);
    assert.equal(places[0].id, 'ChIJ1');
  } finally {
    restore();
  }
});

test('textSearch returns an empty array when Google returns no places field', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));

  try {
    const places = await textSearch('nonexistent business type in Nairobi');
    assert.deepEqual(places, []);
  } finally {
    restore();
  }
});

test('textSearch maps a 429 response to a rate-limit GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
  }));

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) =>
        err instanceof GooglePlacesError &&
        err.reason === 'RATE_LIMITED' &&
        /rate limit/i.test(err.message)
    );
  } finally {
    restore();
  }
});

test('textSearch maps a 403 response to a permission GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Billing disabled' } }),
  }));

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'PERMISSION_DENIED'
    );
  } finally {
    restore();
  }
});

test('textSearch maps a 401 response to an invalid API key GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { status: 'UNAUTHENTICATED', message: 'Invalid key' } }),
  }));

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'INVALID_API_KEY'
    );
  } finally {
    restore();
  }
});

test('textSearch maps a 500 response to an upstream-unavailable GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'Internal error' } }),
  }));

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'UPSTREAM_UNAVAILABLE'
    );
  } finally {
    restore();
  }
});

test('textSearch maps a network error (fetch throws) to a NETWORK_ERROR GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => {
    throw new Error('getaddrinfo ENOTFOUND places.googleapis.com');
  });

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'NETWORK_ERROR'
    );
  } finally {
    restore();
  }
});

test('textSearch maps an AbortError (timeout) to a TIMEOUT GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'TIMEOUT' && err.statusCode === 504
    );
  } finally {
    restore();
  }
});

test('textSearch maps an unparseable response body to a MALFORMED_RESPONSE GooglePlacesError', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, GooglePlacesError } = loadModule();

  const restore = mockFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
  }));

  try {
    await assert.rejects(
      () => textSearch('barbers in Nairobi'),
      (err) => err instanceof GooglePlacesError && err.reason === 'MALFORMED_RESPONSE'
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// Phase 20: search-configuration options on textSearch
// ---------------------------------------------------------------------

function captureFetch(responseBody = { places: [] }) {
  const calls = [];
  const restore = mockFetchOnce(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => responseBody };
  });
  return { calls, restore };
}

test('textSearch with no options sends exactly the pre-Phase-20 request', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, FIELD_MASK, PAGE_SIZE } = loadModule();
  const { calls, restore } = captureFetch();

  try {
    await textSearch('barbers in Nairobi');
    assert.deepEqual(calls[0].body, { textQuery: 'barbers in Nairobi', pageSize: PAGE_SIZE });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['X-Goog-FieldMask'], FIELD_MASK);
  } finally {
    restore();
  }
});

test('textSearch passes maxResultCount and a locationBias circle to Google', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch } = loadModule();
  const { calls, restore } = captureFetch();

  try {
    await textSearch('barbers in Nairobi', {
      maxResultCount: 7,
      locationBias: { latitude: -1.2921, longitude: 36.8219, radius: 5000 },
    });
    assert.deepEqual(calls[0].body, {
      textQuery: 'barbers in Nairobi',
      pageSize: 7,
      locationBias: { circle: { center: { latitude: -1.2921, longitude: 36.8219 }, radius: 5000 } },
    });
  } finally {
    restore();
  }
});

test('textSearch rejects out-of-range options before calling Google', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch } = loadModule();
  const { calls, restore } = captureFetch();
  const bias = { latitude: 0, longitude: 0, radius: 1000 };

  try {
    await assert.rejects(() => textSearch('q', { maxResultCount: 0 }), RangeError);
    await assert.rejects(() => textSearch('q', { maxResultCount: 51 }), RangeError);
    await assert.rejects(() => textSearch('q', { maxResultCount: 2.5 }), RangeError);
    await assert.rejects(() => textSearch('q', { locationBias: { ...bias, radius: 0 } }), RangeError);
    await assert.rejects(() => textSearch('q', { locationBias: { ...bias, radius: 50001 } }), RangeError);
    await assert.rejects(() => textSearch('q', { locationBias: { ...bias, latitude: NaN } }), RangeError);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

function pagedFetch(totalAvailable, pageLimit = 20) {
  const calls = [];
  const restore = mockFetchOnce(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, mask: init.headers['X-Goog-FieldMask'] });
    const start = body.pageToken ? Number(body.pageToken) : 0;
    const n = Math.min(body.pageSize, pageLimit, totalAvailable - start);
    const places = Array.from({ length: n }, (_, i) => ({ id: `p${start + i}` }));
    const next = start + n < totalAvailable ? { nextPageToken: String(start + n) } : {};
    return { ok: true, status: 200, json: async () => ({ places, ...next }) };
  });
  return { calls, restore };
}

test('textSearch pages through Google with nextPageToken to reach 50 results', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch, FIELD_MASK, MAX_RESULT_COUNT } = loadModule();
  assert.equal(MAX_RESULT_COUNT, 50);
  const { calls, restore } = pagedFetch(60);

  try {
    const places = await textSearch('barbers in Nairobi', { maxResultCount: 50 });
    assert.equal(places.length, 50);
    assert.equal(new Set(places.map((p) => p.id)).size, 50);
    assert.deepEqual(calls.map((c) => c.body.pageSize), [20, 20, 10]);
    assert.deepEqual(calls.map((c) => c.body.pageToken), [undefined, '20', '40']);
    for (const c of calls) {
      assert.equal(c.body.textQuery, 'barbers in Nairobi');
      assert.equal(c.mask, `${FIELD_MASK},nextPageToken`);
    }
  } finally {
    restore();
  }
});

test('textSearch stops when Google has no further page, and does not page for 20 or fewer', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { textSearch } = loadModule();

  let fetchMock = pagedFetch(27);
  try {
    assert.equal((await textSearch('q', { maxResultCount: 50 })).length, 27);
    assert.equal(fetchMock.calls.length, 2);
  } finally {
    fetchMock.restore();
  }

  fetchMock = pagedFetch(100);
  try {
    assert.equal((await textSearch('q', { maxResultCount: 20 })).length, 20);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.pageToken, undefined);
  } finally {
    fetchMock.restore();
  }
});

test('resolveLocationCenter asks the same textSearch for one result with only the location field', async () => {
  const { resolveLocationCenter } = loadModule();
  const seen = [];
  const fake = async (query, options) => {
    seen.push({ query, options });
    return [{ location: { latitude: -1.29, longitude: 36.82 } }];
  };

  const center = await resolveLocationCenter('Nairobi', fake);

  assert.deepEqual(center, { latitude: -1.29, longitude: 36.82 });
  assert.deepEqual(seen, [{ query: 'Nairobi', options: { maxResultCount: 1, fieldMask: 'places.location' } }]);
});

test('resolveLocationCenter returns null when Google gives no usable coordinates', async () => {
  const { resolveLocationCenter } = loadModule();
  assert.equal(await resolveLocationCenter('Nowhere', async () => []), null);
  assert.equal(await resolveLocationCenter('Nowhere', async () => [{}]), null);
  assert.equal(await resolveLocationCenter('Nowhere', async () => [{ location: { latitude: 'x', longitude: 1 } }]), null);
});

test('distanceMeters: zero for the same point, ~1.1 km per 0.01 degree of latitude', () => {
  const { distanceMeters } = loadModule();
  const a = { latitude: -1.2921, longitude: 36.8219 };
  assert.equal(distanceMeters(a, a), 0);
  const d = distanceMeters(a, { latitude: -1.2821, longitude: 36.8219 });
  assert.ok(d > 1100 && d < 1120, `expected ~1112 m, got ${d}`);
});
