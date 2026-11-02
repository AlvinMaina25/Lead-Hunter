const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKFILL_LIMIT,
  backfillInternationalPhones,
  resolveBackfillLimit,
} = require('../phoneBackfillService');
const { GooglePlacesError } = require('../googlePlaces');

/**
 * Fake pool that understands only the backfill's three queries and
 * applies the same WHERE logic the SQL does, so the tests prove WHICH
 * businesses are selected, not just that a query was issued.
 */
function makeFakePool(businesses) {
  const rows = new Map(businesses.map((b) => [b.id, { international_phone: null, international_phone_checked_at: null, ...b }]));
  const calls = [];

  const eligible = () =>
    [...rows.values()].filter(
      (b) => b.phone && !b.international_phone && !b.international_phone_checked_at && b.external_place_id
    );

  return {
    calls,
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ s, params });

      if (s.startsWith('SELECT id, external_place_id FROM businesses WHERE phone IS NOT NULL')) {
        return { rows: eligible().slice(0, params[0]).map((b) => ({ id: b.id, external_place_id: b.external_place_id })) };
      }
      if (s.startsWith('UPDATE businesses SET international_phone = $2')) {
        const row = rows.get(params[0]);
        if (row && !row.international_phone) {
          row.international_phone = params[1];
          row.international_phone_checked_at = 'now';
        }
        return { rows: [] };
      }
      if (s.startsWith('SELECT count(*)::int AS n FROM businesses')) {
        return { rows: [{ n: eligible().length }] };
      }
      throw new Error(`FakePool: unrecognized query: ${s}`);
    },
  };
}

const biz = (n, extra = {}) => ({
  id: `b${n}`,
  external_place_id: `ChIJplace${String(n).padStart(6, '0')}`,
  phone: '020 123 4567',
  ...extra,
});

test('resolveBackfillLimit: defaults to 25 and rejects out-of-range values', () => {
  assert.equal(resolveBackfillLimit(undefined), BACKFILL_LIMIT.DEFAULT);
  assert.equal(resolveBackfillLimit('10'), 10);
  for (const bad of [0, -1, 201, 1.5, 'abc']) {
    assert.throws(() => resolveBackfillLimit(bad), /limit/);
  }
});

test('backfill: only businesses with a phone, no international number and a place id are fetched', async () => {
  const pool = makeFakePool([
    biz(1),
    biz(2, { phone: null }), // no phone -> skipped
    biz(3, { international_phone: '+254 20 111 2222' }), // already has one -> skipped
    biz(4, { external_place_id: null }), // no place id -> skipped
    biz(5, { international_phone_checked_at: 'earlier' }), // already asked -> skipped
    biz(6),
  ]);
  const asked = [];
  const summary = await backfillInternationalPhones(pool, {}, {
    fetchDetails: async (placeId) => {
      asked.push(placeId);
      return { internationalPhoneNumber: '+254 20 123 4567' };
    },
  });

  assert.deepEqual(asked.sort(), [biz(1).external_place_id, biz(6).external_place_id]);
  assert.equal(summary.businesses_found, 2);
  assert.equal(summary.updated, 2);
  assert.equal(pool.rows.get('b1').international_phone, '+254 20 123 4567', 'stored exactly as Google returned it');
  assert.equal(pool.rows.get('b3').international_phone, '+254 20 111 2222', 'an existing value is never overwritten');
});

test('backfill: honours the limit and reports what is left', async () => {
  const pool = makeFakePool([biz(1), biz(2), biz(3), biz(4), biz(5)]);
  const summary = await backfillInternationalPhones(pool, { limit: 2 }, {
    fetchDetails: async () => ({ internationalPhoneNumber: '+254 20 123 4567' }),
  });

  assert.equal(summary.requested_limit, 2);
  assert.equal(summary.businesses_found, 2);
  assert.equal(summary.updated, 2);
  assert.equal(summary.remaining_estimate, 3);
});

test('backfill: concurrency is bounded', async () => {
  const pool = makeFakePool(Array.from({ length: 12 }, (_, i) => biz(i + 1)));
  let inFlight = 0;
  let maxInFlight = 0;

  await backfillInternationalPhones(pool, { limit: 12 }, {
    concurrency: 3,
    fetchDetails: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { internationalPhoneNumber: '+254 20 123 4567' };
    },
  });

  assert.ok(maxInFlight <= 3, `expected <= 3 in flight, saw ${maxInFlight}`);
  assert.ok(maxInFlight > 1, 'should actually run concurrently');
});

test('backfill: a business Google has no number for is marked checked and never re-fetched', async () => {
  const pool = makeFakePool([biz(1), biz(2)]);
  let calls = 0;
  const deps = {
    fetchDetails: async (placeId) => {
      calls += 1;
      return placeId === biz(1).external_place_id ? { internationalPhoneNumber: null } : null; // no number / unknown place
    },
  };

  const first = await backfillInternationalPhones(pool, {}, deps);
  assert.equal(first.no_number, 2);
  assert.equal(first.updated, 0);
  assert.equal(pool.rows.get('b1').international_phone, null, 'nothing is invented');
  assert.ok(pool.rows.get('b1').international_phone_checked_at);

  const second = await backfillInternationalPhones(pool, {}, deps);
  assert.equal(second.businesses_found, 0);
  assert.equal(calls, 2, 'the second run made no Google requests');
});

test('backfill: one failing business does not stop the rest, and is retried later (not marked checked)', async () => {
  const pool = makeFakePool([biz(1), biz(2), biz(3)]);
  const summary = await backfillInternationalPhones(pool, {}, {
    fetchDetails: async (placeId) => {
      if (placeId === biz(2).external_place_id) {
        throw new GooglePlacesError('boom', { reason: 'NETWORK_ERROR' });
      }
      return { internationalPhoneNumber: '+254 20 123 4567' };
    },
  });

  assert.equal(summary.updated, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.stopped_early, null);
  assert.equal(pool.rows.get('b2').international_phone_checked_at, null, 'failed business stays eligible');
});

test('backfill: a run-level Google error (bad key / quota) stops the run instead of burning the batch', async () => {
  const pool = makeFakePool(Array.from({ length: 10 }, (_, i) => biz(i + 1)));
  let requests = 0;
  const summary = await backfillInternationalPhones(pool, { limit: 10 }, {
    concurrency: 1,
    fetchDetails: async () => {
      requests += 1;
      throw new GooglePlacesError('denied', { reason: 'PERMISSION_DENIED' });
    },
  });

  assert.equal(summary.stopped_early, 'PERMISSION_DENIED');
  assert.equal(requests, 1, 'no further Google requests after a run-level error');
  assert.equal(summary.updated, 0);
});

test('backfill: never throws the raw Google/DB error text to callers in the summary', async () => {
  const pool = makeFakePool([biz(1)]);
  const summary = await backfillInternationalPhones(pool, {}, {
    fetchDetails: async () => {
      throw new Error('secret-api-key-leak');
    },
  });
  assert.ok(!JSON.stringify(summary).includes('secret-api-key-leak'));
  assert.equal(summary.failed, 1);
});
