#!/usr/bin/env node
/**
 * One-off, bounded backfill of businesses.international_phone from
 * Google Place Details, for businesses saved before migration 009.
 *
 * Only businesses that have a phone but no international number (and
 * have never been checked) are touched. Each one is a billed Place
 * Details request, so a limit is enforced.
 *
 * Usage:
 *   npm run backfill:international-phone                 # default limit (25)
 *   npm run backfill:international-phone -- --limit 100  # up to 200
 *
 * Requires DATABASE_URL and GOOGLE_PLACES_API_KEY (see .env.example).
 * Safe to run repeatedly: businesses already handled are skipped.
 */
require('dotenv').config();

const { backfillInternationalPhones } = require('../server/lib/phoneBackfillService');

function parseLimit(argv) {
  const i = argv.indexOf('--limit');
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main() {
  const pool = require('../server/db'); // throws a clear error if DATABASE_URL is missing

  try {
    const summary = await backfillInternationalPhones(pool, { limit: parseLimit(process.argv.slice(2)) });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.stopped_early) {
      console.error(`Stopped early: ${summary.stopped_early}. Fix the Google Places configuration and re-run.`);
      process.exitCode = 1;
    } else if (summary.remaining_estimate > 0) {
      console.log(`${summary.remaining_estimate} business(es) still to do - run again to continue.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
