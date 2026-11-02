const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotFoundError,
  ValidationError,
  BATCH_LIMIT,
  isValidUuid,
  checkBusinessById,
  checkBusinessBatch,
  resolveBatchLimit,
  runWithConcurrency,
} = require('../websiteCheckService');

/**
 * A minimal fake Postgres pool that stores businesses in memory and
 * understands only the exact queries websiteCheckService.js issues.
 * Deliberately does NOT touch a real database or the network — this
 * is a unit test double, not an integration test against Neon.
 */
function makeFakePool(initialBusinesses) {
  const rows = new Map(initialBusinesses.map((b) => [b.id, { ...b }]));
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (normalizedSql.startsWith('SELECT id, name, website_url, website_status, website_checked_at FROM businesses WHERE id = $1')) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalizedSql.startsWith('UPDATE businesses')) {
      const [id, websiteStatus] = params;
      const existing = rows.get(id);
      if (!existing) return { rows: [] };
      existing.website_status = websiteStatus;
      existing.website_checked_at = new Date().toISOString();
      rows.set(id, existing);
      return { rows: [{ ...existing }] };
    }

    if (normalizedSql.startsWith('SELECT id, name, website_url, website_status, website_checked_at FROM businesses WHERE website_checked_at IS NULL')) {
      const limit = params[0];
      const matches = [...rows.values()]
        .filter((b) => b.website_checked_at === null)
        .slice(0, limit)
        .map((b) => ({ ...b }));
      return { rows: matches };
    }

    throw new Error(`FakePool: unrecognized query: ${normalizedSql}`);
  }

  return { query, calls, _rows: rows };
}

function business(overrides) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Business',
    website_url: null,
    website_status: 'unknown',
    website_checked_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// isValidUuid
// ---------------------------------------------------------------------

test('isValidUuid: accepts a well-formed UUID', () => {
  assert.equal(isValidUuid('11111111-1111-4111-8111-111111111111'), true);
});

test('isValidUuid: rejects non-UUID strings', () => {
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid('123'), false);
  assert.equal(isValidUuid(''), false);
});

test('isValidUuid: rejects non-strings', () => {
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(42), false);
});

// ---------------------------------------------------------------------
// checkBusinessById: valid id, reachable site
// ---------------------------------------------------------------------

test('checkBusinessById: reachable website updates status and returns http_status', async () => {
  const b = business({ website_url: 'https://example.com' });
  const pool = makeFakePool([b]);
  const checker = async (url) => {
    assert.equal(url, 'https://example.com'); // only the stored URL is ever passed in
    return { status: 'reachable', httpStatus: 200, finalUrl: url };
  };

  const { business: updated, httpStatus } = await checkBusinessById(pool, b.id, { checker });

  assert.equal(updated.website_status, 'reachable');
  assert.equal(httpStatus, 200);
  assert.ok(updated.website_checked_at, 'website_checked_at should be set');
});

// ---------------------------------------------------------------------
// checkBusinessById: unreachable site
// ---------------------------------------------------------------------

test('checkBusinessById: unreachable website updates status with no http_status', async () => {
  const b = business({ website_url: 'https://down.example.com' });
  const pool = makeFakePool([b]);
  const checker = async () => ({ status: 'unreachable', httpStatus: null, finalUrl: null });

  const { business: updated, httpStatus } = await checkBusinessById(pool, b.id, { checker });

  assert.equal(updated.website_status, 'unreachable');
  assert.equal(httpStatus, null);
});

// ---------------------------------------------------------------------
// checkBusinessById: business with no website
// ---------------------------------------------------------------------

test('checkBusinessById: missing website_url sets no_website without calling the checker', async () => {
  const b = business({ website_url: null });
  const pool = makeFakePool([b]);
  let checkerCalled = false;
  const checker = async () => {
    checkerCalled = true;
    return { status: 'reachable', httpStatus: 200, finalUrl: null };
  };

  const { business: updated, httpStatus } = await checkBusinessById(pool, b.id, { checker });

  assert.equal(updated.website_status, 'no_website');
  assert.equal(httpStatus, null);
  assert.equal(checkerCalled, false, 'the network checker must never run for a business with no URL');
});

// ---------------------------------------------------------------------
// checkBusinessById: nonexistent business
// ---------------------------------------------------------------------

test('checkBusinessById: nonexistent id throws NotFoundError', async () => {
  const pool = makeFakePool([]);

  await assert.rejects(
    () => checkBusinessById(pool, '99999999-9999-4999-8999-999999999999'),
    (err) => {
      assert.ok(err instanceof NotFoundError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------
// checkBusinessById: database update actually persists
// ---------------------------------------------------------------------

test('checkBusinessById: persists the new status/timestamp back into the pool', async () => {
  const b = business({ website_url: 'https://example.com', website_status: 'unknown', website_checked_at: null });
  const pool = makeFakePool([b]);
  const checker = async () => ({ status: 'reachable', httpStatus: 200, finalUrl: null });

  await checkBusinessById(pool, b.id, { checker });

  const stored = pool._rows.get(b.id);
  assert.equal(stored.website_status, 'reachable');
  assert.notEqual(stored.website_checked_at, null);
});

test('checkBusinessById: never uses a URL other than the one stored on the row', async () => {
  const b = business({ website_url: 'https://real-stored-url.example.com' });
  const pool = makeFakePool([b]);
  let receivedUrl = null;
  const checker = async (url) => {
    receivedUrl = url;
    return { status: 'reachable', httpStatus: 200, finalUrl: url };
  };

  // Even if a caller tried to sneak an arbitrary URL in via unrelated
  // fields, checkBusinessById only ever takes (pool, id, opts) -- there
  // is no parameter through which a URL could be injected.
  await checkBusinessById(pool, b.id, { checker });

  assert.equal(receivedUrl, 'https://real-stored-url.example.com');
});

// ---------------------------------------------------------------------
// resolveBatchLimit
// ---------------------------------------------------------------------

test('resolveBatchLimit: defaults when omitted', () => {
  assert.equal(resolveBatchLimit(undefined), BATCH_LIMIT.DEFAULT);
  assert.equal(resolveBatchLimit(null), BATCH_LIMIT.DEFAULT);
});

test('resolveBatchLimit: accepts an in-range integer', () => {
  assert.equal(resolveBatchLimit(5), 5);
  assert.equal(resolveBatchLimit(BATCH_LIMIT.MAX), BATCH_LIMIT.MAX);
});

test('resolveBatchLimit: rejects non-integers, zero, negatives, and over-the-cap values', () => {
  for (const bad of [0, -1, 1.5, 'twenty', BATCH_LIMIT.MAX + 1, {}]) {
    assert.throws(() => resolveBatchLimit(bad), ValidationError);
  }
});

// ---------------------------------------------------------------------
// checkBusinessBatch
// ---------------------------------------------------------------------

test('checkBusinessBatch: checks only never-checked businesses and tallies counts correctly', async () => {
  const businesses = [
    business({ id: 'a1111111-1111-4111-8111-111111111111', website_url: 'https://reachable.example.com', website_checked_at: null }),
    business({ id: 'a2222222-2222-4222-8222-222222222222', website_url: 'https://unreachable.example.com', website_checked_at: null }),
    business({ id: 'a3333333-3333-4333-8333-333333333333', website_url: null, website_checked_at: null }),
    business({ id: 'a4444444-4444-4444-8444-444444444444', website_url: 'https://already-checked.example.com', website_checked_at: '2026-01-01T00:00:00.000Z' }),
  ];
  const pool = makeFakePool(businesses);

  const checker = async (url) => {
    if (url === 'https://reachable.example.com') return { status: 'reachable', httpStatus: 200, finalUrl: url };
    if (url === 'https://unreachable.example.com') return { status: 'unreachable', httpStatus: null, finalUrl: null };
    throw new Error(`unexpected url in test: ${url}`);
  };

  const counts = await checkBusinessBatch(pool, { limit: 10 }, { checker });

  // Only the 3 rows with website_checked_at === null are eligible;
  // the already-checked row must be left untouched.
  assert.equal(counts.checked, 3);
  assert.equal(counts.reachable, 1);
  assert.equal(counts.unreachable, 1);
  assert.equal(counts.no_website, 1);
  assert.equal(counts.unknown, 0);

  const untouched = pool._rows.get('a4444444-4444-4444-8444-444444444444');
  assert.equal(untouched.website_checked_at, '2026-01-01T00:00:00.000Z');
});

test('checkBusinessBatch: rejects an out-of-range limit before querying', async () => {
  const pool = makeFakePool([]);
  await assert.rejects(() => checkBusinessBatch(pool, { limit: 999 }), ValidationError);
});

test('checkBusinessBatch: an empty queue returns all-zero counts', async () => {
  const pool = makeFakePool([]);
  const counts = await checkBusinessBatch(pool, {});
  assert.deepEqual(counts, { checked: 0, reachable: 0, unreachable: 0, no_website: 0, unknown: 0 });
});

// ---------------------------------------------------------------------
// runWithConcurrency
// ---------------------------------------------------------------------

test('runWithConcurrency: never runs more than `concurrency` workers at once', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;

  await runWithConcurrency(
    items,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
    3
  );

  assert.ok(maxActive <= 3, `expected at most 3 concurrent workers, saw ${maxActive}`);
});

test('runWithConcurrency: processes every item exactly once', async () => {
  const items = Array.from({ length: 9 }, (_, i) => i);
  const seen = [];
  await runWithConcurrency(items, async (item) => { seen.push(item); }, 4);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), items);
});
