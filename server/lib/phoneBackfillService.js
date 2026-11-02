/**
 * Backfill of businesses.international_phone for businesses saved before
 * migration 009 (so searches don't have to be re-run).
 *
 * SAFETY / COST CONTROLS
 *   - Only businesses that HAVE a phone, have NO international number,
 *     have a Google place id, and have never been asked
 *     (international_phone_checked_at IS NULL) are selected.
 *   - A bounded `limit` per run (default 25, max 200): each business is
 *     one billed Place Details request.
 *   - Bounded concurrency (3 in flight at once).
 *   - A business Google has no number for (or no longer knows) is marked
 *     checked and never re-fetched; a failed request is NOT marked, so
 *     it is retried by a later run.
 *   - A run-level error (missing/invalid API key, permission denied,
 *     rate limit) stops the run instead of burning through the batch.
 *   - Nothing is guessed: the stored value is exactly what Google sent.
 *
 * Decoupled from Express and from the Google client (both injectable)
 * so it is unit-testable with fakes.
 */

'use strict';

const { runWithConcurrency } = require('./websiteCheckService');
const { getPlaceInternationalPhone, GooglePlacesError } = require('./googlePlaces');

const BACKFILL_LIMIT = Object.freeze({ DEFAULT: 25, MIN: 1, MAX: 200 });
const BACKFILL_CONCURRENCY = 3;

/** Google failures that will repeat for every remaining business -- stop the run. */
const RUN_LEVEL_REASONS = new Set(['MISSING_API_KEY', 'INVALID_API_KEY', 'PERMISSION_DENIED', 'RATE_LIMITED']);

class BackfillValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function resolveBackfillLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null) return BACKFILL_LIMIT.DEFAULT;
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < BACKFILL_LIMIT.MIN || n > BACKFILL_LIMIT.MAX) {
    throw new BackfillValidationError(
      `"limit" must be an integer between ${BACKFILL_LIMIT.MIN} and ${BACKFILL_LIMIT.MAX}.`
    );
  }
  return n;
}

/**
 * @param {{query: Function}} pool
 * @param {{ limit?: unknown }} [body]
 * @param {{ fetchDetails?: Function, concurrency?: number }} [deps]
 * @returns {Promise<{
 *   requested_limit: number,
 *   businesses_found: number,
 *   updated: number,
 *   no_number: number,
 *   failed: number,
 *   stopped_early: string|null,
 *   remaining_estimate: number|null,
 * }>}
 * @throws {Error} name 'ValidationError' when limit is out of bounds
 */
async function backfillInternationalPhones(pool, body = {}, deps = {}) {
  const limit = resolveBackfillLimit(body.limit);
  const fetchDetails = deps.fetchDetails || getPlaceInternationalPhone;
  const concurrency = deps.concurrency || BACKFILL_CONCURRENCY;

  const { rows: businesses } = await pool.query(
    `
      SELECT id, external_place_id
      FROM businesses
      WHERE phone IS NOT NULL
        AND international_phone IS NULL
        AND international_phone_checked_at IS NULL
        AND external_place_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [limit]
  );

  const result = {
    requested_limit: limit,
    businesses_found: businesses.length,
    updated: 0,
    no_number: 0,
    failed: 0,
    stopped_early: null,
    remaining_estimate: null,
  };

  await runWithConcurrency(
    businesses,
    async (business) => {
      if (result.stopped_early) return; // a run-level error already happened

      let details;
      try {
        details = await fetchDetails(business.external_place_id);
      } catch (err) {
        if (err instanceof GooglePlacesError && RUN_LEVEL_REASONS.has(err.reason)) {
          result.stopped_early = err.reason;
        }
        result.failed += 1;
        console.error('[phone-backfill]', business.id, err && err.reason ? err.reason : 'error');
        return; // not marked checked: a later run retries it
      }

      try {
        const number = details && details.internationalPhoneNumber ? details.internationalPhoneNumber : null;
        // Only fills an empty value, so a concurrent search can't be overwritten.
        await pool.query(
          `
            UPDATE businesses
            SET international_phone = $2, international_phone_checked_at = now()
            WHERE id = $1 AND international_phone IS NULL
          `,
          [business.id, number]
        );
        if (number) result.updated += 1;
        else result.no_number += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[phone-backfill] save failed', business.id, err && err.code ? err.code : 'error');
      }
    },
    concurrency
  );

  try {
    const { rows } = await pool.query(
      `
        SELECT count(*)::int AS n
        FROM businesses
        WHERE phone IS NOT NULL
          AND international_phone IS NULL
          AND international_phone_checked_at IS NULL
          AND external_place_id IS NOT NULL
      `
    );
    result.remaining_estimate = rows[0] ? rows[0].n : null;
  } catch {
    /* the count is informational only */
  }

  return result;
}

module.exports = {
  BACKFILL_LIMIT,
  BACKFILL_CONCURRENCY,
  BackfillValidationError,
  resolveBackfillLimit,
  backfillInternationalPhones,
};
