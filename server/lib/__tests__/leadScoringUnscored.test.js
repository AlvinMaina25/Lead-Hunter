const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  resolveOnlyUnscored,
  countUnscoredBusinesses,
  scoreBusinessBatch,
} = require('../leadScoringService');

// ---------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------

/**
 * Fake pool for the queries scoreBusinessBatch / countUnscoredBusinesses
 * issue. It evaluates the "unscored" queries the way Postgres would
 * (a business is unscored iff no leads row exists for it) so a test can
 * check WHICH businesses get picked, and every SQL string is recorded.
 *
 * `failPersistFor` makes the leads INSERT throw for one business, to
 * model a per-business scoring failure.
 */
function makeFakePool({ businesses = [], scoredIds = [], failPersistFor = null } = {}) {
  const rows = new Map(businesses.map((b) => [b.id, { ...b }]));
  const leads = new Map(scoredIds.map((id) => [id, { business_id: id }]));
  const calls = [];
  const byAge = () => [...rows.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push(s);

    // Default (legacy) selection: the oldest N businesses, scored or not.
    if (s === 'SELECT id FROM businesses ORDER BY created_at ASC LIMIT $1') {
      return { rows: byAge().slice(0, params[0]).map((b) => ({ id: b.id })) };
    }

    // only_unscored selection.
    if (
      s ===
      'SELECT b.id FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.business_id = b.id) ORDER BY b.created_at ASC LIMIT $1'
    ) {
      return {
        rows: byAge()
          .filter((b) => !leads.has(b.id))
          .slice(0, params[0])
          .map((b) => ({ id: b.id })),
      };
    }

    // Unscored count.
    if (
      s ===
      'SELECT COUNT(*)::int AS unscored_count FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.business_id = b.id)'
    ) {
      return { rows: [{ unscored_count: byAge().filter((b) => !leads.has(b.id)).length }] };
    }

    // Per-business scoring (scoreBusiness).
    if (s.startsWith('SELECT id, name, website_status, google_review_count FROM businesses')) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (s.startsWith('SELECT performance_score') || s.startsWith('SELECT recommended_service')) {
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO leads')) {
      const [businessId, leadScore, priority, factors] = params;
      if (businessId === failPersistFor) throw new Error('simulated write failure');
      const lead = {
        id: `lead-${businessId}`,
        business_id: businessId,
        lead_score: leadScore,
        priority,
        scoring_factors: JSON.parse(factors),
        scored_at: new Date().toISOString(),
      };
      leads.set(businessId, lead);
      return { rows: [lead] };
    }

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls, leads };
}

function biz(n, overrides = {}) {
  const id = `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  return {
    id,
    name: `Business ${n}`,
    website_status: 'no_website',
    google_review_count: null,
    created_at: `2026-01-0${n}T00:00:00.000Z`,
    ...overrides,
  };
}

const [B1, B2, B3, B4, B5] = [1, 2, 3, 4, 5].map((n) => biz(n));
const ids = (result) => result.results.map((r) => r.business_id).sort();

// ---------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------

test('only_unscored picks only businesses with no leads row, oldest first, even when older ones are scored', async () => {
  // B1 and B2 (the oldest) are already scored; B3..B5 are not.
  const pool = makeFakePool({ businesses: [B1, B2, B3, B4, B5], scoredIds: [B1.id, B2.id] });

  const result = await scoreBusinessBatch(pool, { only_unscored: true, limit: 2 });

  assert.deepEqual(ids(result), [B3.id, B4.id].sort());
  assert.equal(result.businesses_found, 2);
  assert.equal(result.requested_limit, 2);
  assert.ok(result.results.every((r) => r.ok));
});

test('only_unscored: a business that was scored in one run is not picked again in the next', async () => {
  const pool = makeFakePool({ businesses: [B1, B2, B3, B4, B5] });

  const first = await scoreBusinessBatch(pool, { only_unscored: true, limit: 2 });
  const second = await scoreBusinessBatch(pool, { only_unscored: true, limit: 2 });
  const third = await scoreBusinessBatch(pool, { only_unscored: true, limit: 2 });
  const fourth = await scoreBusinessBatch(pool, { only_unscored: true, limit: 2 });

  assert.deepEqual(ids(first), [B1.id, B2.id].sort());
  assert.deepEqual(ids(second), [B3.id, B4.id].sort());
  assert.deepEqual(ids(third), [B5.id]);
  assert.equal(fourth.businesses_found, 0);
  assert.deepEqual(fourth.results, []);
});

test('only_unscored with nothing unscored finds nothing and scores nothing', async () => {
  const pool = makeFakePool({ businesses: [B1, B2], scoredIds: [B1.id, B2.id] });
  const result = await scoreBusinessBatch(pool, { only_unscored: true });
  assert.equal(result.businesses_found, 0);
  assert.equal(pool.calls.filter((c) => c.startsWith('INSERT INTO leads')).length, 0);
});

test('a business whose scoring fails stays unscored (so the next run retries it) and does not stop the rest', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = makeFakePool({ businesses: [B1, B2, B3], failPersistFor: B2.id });

  const result = await scoreBusinessBatch(pool, { only_unscored: true });

  const failed = result.results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.business_id), [B2.id]);
  assert.equal(result.results.filter((r) => r.ok).length, 2);

  assert.equal(await countUnscoredBusinesses(pool), 1);
  const retry = await scoreBusinessBatch(pool, { only_unscored: true });
  assert.deepEqual(ids(retry), [B2.id]);
});

// ---------------------------------------------------------------------
// Default behaviour is unchanged
// ---------------------------------------------------------------------

test('default batch (no flag) still takes the oldest N regardless of scored state, via the original query', async () => {
  const pool = makeFakePool({ businesses: [B1, B2, B3], scoredIds: [B1.id, B2.id] });

  const result = await scoreBusinessBatch(pool, { limit: 2 });

  // The already-scored oldest two are picked again -- that is the existing
  // behaviour only_unscored exists to avoid.
  assert.deepEqual(ids(result), [B1.id, B2.id].sort());
  assert.ok(pool.calls.includes('SELECT id FROM businesses ORDER BY created_at ASC LIMIT $1'));
  assert.ok(!pool.calls.some((c) => c.includes('NOT EXISTS')));
});

test('only_unscored: false and null behave exactly like omitting it', async () => {
  for (const body of [{ only_unscored: false }, { only_unscored: null }, {}]) {
    const pool = makeFakePool({ businesses: [B1, B2], scoredIds: [B1.id] });
    const result = await scoreBusinessBatch(pool, body);
    assert.deepEqual(ids(result), [B1.id, B2.id].sort(), JSON.stringify(body));
    assert.ok(!pool.calls.some((c) => c.includes('NOT EXISTS')));
  }
});

test('an omitted limit still defaults (20) with only_unscored', async () => {
  const pool = makeFakePool({ businesses: [B1] });
  const result = await scoreBusinessBatch(pool, { only_unscored: true });
  assert.equal(result.requested_limit, 20);
});

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

test('only_unscored must be a strict boolean: anything else is a ValidationError before any query runs', async () => {
  for (const bad of ['true', 'false', 1, 0, {}, []]) {
    const pool = makeFakePool({ businesses: [B1] });
    await assert.rejects(
      () => scoreBusinessBatch(pool, { only_unscored: bad }),
      (err) => err instanceof ValidationError && /only_unscored/.test(err.message),
      `expected ${JSON.stringify(bad)} to be rejected`
    );
    assert.equal(pool.calls.length, 0, `no query should run for ${JSON.stringify(bad)}`);
  }
});

test('resolveBatchLimit validation still applies with only_unscored', async () => {
  for (const limit of [0, 51, -1, 2.5, 'abc']) {
    const pool = makeFakePool({ businesses: [B1] });
    await assert.rejects(
      () => scoreBusinessBatch(pool, { only_unscored: true, limit }),
      ValidationError,
      `limit ${JSON.stringify(limit)}`
    );
    assert.equal(pool.calls.length, 0);
  }
  // The boundaries are accepted.
  for (const limit of [1, 50]) {
    const pool = makeFakePool({ businesses: [B1] });
    const result = await scoreBusinessBatch(pool, { only_unscored: true, limit });
    assert.equal(result.requested_limit, limit);
  }
});

test('resolveOnlyUnscored: booleans pass through, undefined/null mean false', () => {
  assert.equal(resolveOnlyUnscored(true), true);
  assert.equal(resolveOnlyUnscored(false), false);
  assert.equal(resolveOnlyUnscored(undefined), false);
  assert.equal(resolveOnlyUnscored(null), false);
  assert.throws(() => resolveOnlyUnscored('yes'), ValidationError);
});

// ---------------------------------------------------------------------
// Unscored count
// ---------------------------------------------------------------------

test('countUnscoredBusinesses counts exactly the businesses with no leads row', async () => {
  const pool = makeFakePool({ businesses: [B1, B2, B3, B4], scoredIds: [B1.id, B3.id] });
  assert.equal(await countUnscoredBusinesses(pool), 2);
});

test('countUnscoredBusinesses is 0 for an empty table, and a real number (not a string)', async () => {
  const pool = makeFakePool({});
  const count = await countUnscoredBusinesses(pool);
  assert.equal(count, 0);
  assert.equal(typeof count, 'number');
});

test('the count agrees with what only_unscored then scores, and drops to 0 afterwards', async () => {
  const pool = makeFakePool({ businesses: [B1, B2, B3], scoredIds: [B2.id] });

  const before = await countUnscoredBusinesses(pool);
  const result = await scoreBusinessBatch(pool, { only_unscored: true, limit: 50 });

  assert.equal(before, 2);
  assert.equal(result.businesses_found, before);
  assert.equal(await countUnscoredBusinesses(pool), 0);
});
