/**
 * Orchestrates a website reachability check for one or more businesses
 * and writes the outcome back to the `businesses` table (Phase 9C1).
 *
 * Deliberately decoupled from Express: server/routes/businesses.js is a
 * thin HTTP wrapper around the functions exported here. Both the `pool`
 * and the reachability checker are passed in as parameters rather than
 * required at module load time, so this module can be unit tested
 * against a fake in-memory pool and a fake checker — no real Neon
 * connection and no real network access needed. See
 * server/lib/__tests__/websiteCheckService.test.js.
 *
 * The one rule this module exists to enforce: a check NEVER uses a URL
 * supplied by the caller. It always re-reads `website_url` from the row
 * already stored in Neon (see loadBusiness/checkAndUpdateBusiness) —
 * the HTTP layer above this never gets a chance to pass in its own URL.
 */

'use strict';

const { checkWebsiteReachability } = require('./httpChecker');
const { normalizeWebsiteUrlForCheck, NORMALIZATION_FAILURE, WEBSITE_STATUS } = require('./websiteCheck');

/** Columns returned for a business by every query in this module. */
const BUSINESS_COLUMNS = `id, name, website_url, website_status, website_checked_at`;

/** Thrown by checkBusinessById when the id doesn't match any row. */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown for a malformed request (e.g. batch "limit" out of range). */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Bounds for POST /api/businesses/website-check's "limit" field. */
const BATCH_LIMIT = Object.freeze({ DEFAULT: 20, MIN: 1, MAX: 50 });

/**
 * Cap on simultaneous in-flight checks during a batch run, independent
 * of how large `limit` is. Keeps us from firing dozens of concurrent
 * outbound requests at once regardless of the requested batch size.
 */
const BATCH_CONCURRENCY = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} value
 * @returns {boolean} true if `value` is a syntactically valid UUID
 */
function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Loads exactly the columns this module needs for one business.
 *
 * @param {{query: Function}} pool
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function loadBusiness(pool, id) {
  const { rows } = await pool.query(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Runs (or short-circuits) a reachability check for one already-loaded
 * business row, using ONLY `business.website_url` exactly as stored,
 * and persists the resulting status + timestamp.
 *
 * @param {{query: Function}} pool
 * @param {{id: string, website_url: string|null}} business - a row already loaded from Neon
 * @param {{checker?: Function}} [opts] - `checker` is injectable for tests only
 * @returns {Promise<{business: object, httpStatus: number|null}>}
 */
async function checkAndUpdateBusiness(pool, business, opts = {}) {
  const checker = opts.checker || checkWebsiteReachability;
  const normalized = normalizeWebsiteUrlForCheck(business.website_url);

  let websiteStatus;
  let httpStatus = null;

  if (!normalized.ok && normalized.reason === NORMALIZATION_FAILURE.MISSING) {
    // No usable URL stored at all -- never attempt a network request.
    websiteStatus = WEBSITE_STATUS.NO_WEBSITE;
  } else {
    // Deliberately pass the RAW stored value, not a caller-supplied one:
    // `business` came from loadBusiness/loadBusiness-shaped rows only.
    const result = await checker(business.website_url);
    websiteStatus = result.status; // 'reachable' | 'unreachable' | 'unknown'
    httpStatus = result.httpStatus;
  }

  const { rows } = await pool.query(
    `
      UPDATE businesses
      SET website_status = $2, website_checked_at = now()
      WHERE id = $1
      RETURNING ${BUSINESS_COLUMNS}
    `,
    [business.id, websiteStatus]
  );

  return { business: rows[0], httpStatus };
}

/**
 * Loads a business by id and checks it. Never accepts a URL from the
 * caller -- the URL used is always whatever is currently stored on that
 * business's row.
 *
 * @param {{query: Function}} pool
 * @param {string} id
 * @param {{checker?: Function}} [opts]
 * @returns {Promise<{business: object, httpStatus: number|null}>}
 * @throws {NotFoundError} if no business has that id
 */
async function checkBusinessById(pool, id, opts = {}) {
  const business = await loadBusiness(pool, id);
  if (!business) {
    throw new NotFoundError(`No business found with id ${id}`);
  }
  return checkAndUpdateBusiness(pool, business, opts);
}

/**
 * Validates and bounds the batch endpoint's "limit" input.
 *
 * @param {unknown} rawLimit
 * @returns {number} a validated integer in [BATCH_LIMIT.MIN, BATCH_LIMIT.MAX]
 * @throws {ValidationError}
 */
function resolveBatchLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null) {
    return BATCH_LIMIT.DEFAULT;
  }
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < BATCH_LIMIT.MIN || n > BATCH_LIMIT.MAX) {
    throw new ValidationError(
      `"limit" must be an integer between ${BATCH_LIMIT.MIN} and ${BATCH_LIMIT.MAX}.`
    );
  }
  return n;
}

/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight
 * at once. A minimal, dependency-free stand-in for a "p-limit"-style
 * helper -- deliberately small since this is the only place in the
 * codebase that needs bounded concurrency.
 *
 * @param {Array<T>} items
 * @param {(item: T, index: number) => Promise<void>} worker
 * @param {number} concurrency
 */
async function runWithConcurrency(items, worker, concurrency) {
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      // eslint-disable-next-line no-await-in-loop
      await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
}

/**
 * Checks a bounded batch of businesses that have never been checked
 * before (website_checked_at IS NULL), oldest-created first, and
 * reports outcome counts. Bounded concurrency (BATCH_CONCURRENCY) keeps
 * this from firing many simultaneous outbound requests.
 *
 * @param {{query: Function}} pool
 * @param {{limit?: unknown}} [body]
 * @param {{checker?: Function}} [opts]
 * @returns {Promise<{checked: number, reachable: number, unreachable: number, no_website: number, unknown: number}>}
 * @throws {ValidationError}
 */
async function checkBusinessBatch(pool, body = {}, opts = {}) {
  const limit = resolveBatchLimit(body.limit);

  const { rows: businesses } = await pool.query(
    `
      SELECT ${BUSINESS_COLUMNS}
      FROM businesses
      WHERE website_checked_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [limit]
  );

  const counts = { checked: 0, reachable: 0, unreachable: 0, no_website: 0, unknown: 0 };

  await runWithConcurrency(
    businesses,
    async (business) => {
      const { business: updated } = await checkAndUpdateBusiness(pool, business, opts);
      counts.checked += 1;
      if (Object.prototype.hasOwnProperty.call(counts, updated.website_status)) {
        counts[updated.website_status] += 1;
      }
    },
    BATCH_CONCURRENCY
  );

  return counts;
}

module.exports = {
  NotFoundError,
  ValidationError,
  BATCH_LIMIT,
  BATCH_CONCURRENCY,
  isValidUuid,
  loadBusiness,
  checkAndUpdateBusiness,
  checkBusinessById,
  checkBusinessBatch,
  resolveBatchLimit,
  runWithConcurrency,
};
