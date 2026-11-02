-- =====================================================================
-- Alvin Lead Hunter — Website analysis results (Phase 10A)
-- Migration: 003_website_analysis_results
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- PHASE 10D REWRITE: this migration was originally written as
-- `DROP TABLE IF EXISTS website_analysis;` followed by a fresh
-- `CREATE TABLE`. That was destructive -- it would silently discard
-- any rows already sitting in `website_analysis`, including real
-- Phase 10A/10B analysis results. This version is additive/idempotent
-- instead: it never drops the table, never drops a column, and never
-- deletes a row, regardless of which of these states the database is
-- currently in:
--
--   (a) `website_analysis` doesn't exist yet at all
--   (b) `website_analysis` exists in its original 001_init_schema.sql
--       shape (columns: url, mobile_friendly, load_time,
--       raw_analysis_json, analysis_status IN ('pending','completed','failed'))
--   (c) `website_analysis` already exists in this migration's target
--       (Phase 10A) shape, possibly already holding real rows
--   (d) any of the above, but with existing rows present
--
-- It is safe to run this migration more than once (every step below
-- is guarded with IF [NOT] EXISTS or an equivalent existence check).
--
-- This migration does NOT touch `businesses`, `ai_analysis`, `leads`,
-- `sales_pipeline`, `searches`, or `search_results`, and does not
-- modify migrations 001 or 002.
--
-- Column notes (target/final shape):
--   business_id             FK to businesses, cascade-deleted with it.
--                            Unchanged from 001 -- same name, type, and
--                            constraint.
--   analyzed_url            The exact URL actually requested (after
--                           Phase 9 normalization), not necessarily
--                           identical to businesses.website_url.
--                           Renamed from 001's `url` column (same TEXT
--                           NOT NULL data, values preserved) when that
--                           column is present.
--   analyzed_at             When this analysis attempt ran. Unchanged
--                           from 001.
--   *_score                 0-100 Lighthouse category scores from
--                           PageSpeed Insights. NULL when PageSpeed
--                           didn't return that category (never
--                           defaulted to 0 or invented). Unchanged
--                           from 001 -- same names, types, constraints.
--   mobile_indicator        NEW column. The PageSpeed "form factor"
--                           (strategy) actually used for the
--                           request/response (e.g. 'mobile'). This is
--                           NOT the same concept as 001's
--                           `mobile_friendly` BOOLEAN (a yes/no
--                           judgement) -- there is no safe, lossless
--                           way to convert one into the other, so
--                           `mobile_friendly` is left in place,
--                           untouched, as a legacy/deprecated column
--                           rather than being dropped or coerced.
--   https_enabled           Whether the final fetched URL used https.
--                           Unchanged from 001.
--   page_title / meta_description  NULL means "no such tag was found
--                           in the homepage HTML", a measured finding,
--                           not a missing value. Unchanged from 001.
--   viewport_present        Boolean presence check for
--                           <meta name="viewport">. Unchanged from 001.
--   html_size_bytes         NEW column. Bytes of homepage HTML
--                           actually read (bounded -- see
--                           server/lib/websiteAnalysis.js). NULL for
--                           any pre-existing legacy row, since it was
--                           never measured for those.
--   response_time_ms        NEW column. Wall-clock time for the
--                           homepage fetch, in milliseconds. This is
--                           NOT filled in from 001's `load_time`
--                           NUMERIC(6,2) (seconds) column -- that
--                           older field may have measured something
--                           different (e.g. a full page load, not a
--                           single bounded homepage GET), so
--                           multiplying it by 1000 would be inventing
--                           a value this migration cannot actually
--                           observe. `load_time` is left in place,
--                           untouched.
--   http_status             NEW column. HTTP status code of the final
--                           response.
--   raw_analysis_response   Full raw homepage-fetch + PageSpeed
--                           payload for debugging; never surfaced to
--                           the frontend as-is. Renamed from 001's
--                           `raw_analysis_json` (same JSONB data,
--                           values preserved) when that column is
--                           present.
--   analysis_status         Outcome of this analysis attempt. NOT the
--                           same vocabulary as businesses.website_status.
--                           001 allowed ('pending','completed','failed')
--                           with a 'pending' default; the Phase 10A/10B
--                           vocabulary is
--                           ('completed','failed','rate_limited',
--                           'blocked','timeout','unavailable') and has
--                           no default (application code always sets
--                           it explicitly). See the constraint-handling
--                           note further down for how this is changed
--                           without breaking on pre-existing rows.
--   error_code/error_message  NEW columns. Populated only when
--                           analysis_status is not 'completed'.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Fresh database: table doesn't exist yet at all. Create it directly
--    in its final Phase 10A shape. Every later step in this migration
--    is a no-op against a table created this way, since it already has
--    every target column and constraint.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_analysis (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  analyzed_url          TEXT NOT NULL,
  analyzed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  performance_score     SMALLINT CHECK (performance_score BETWEEN 0 AND 100),
  accessibility_score   SMALLINT CHECK (accessibility_score BETWEEN 0 AND 100),
  seo_score             SMALLINT CHECK (seo_score BETWEEN 0 AND 100),
  best_practices_score  SMALLINT CHECK (best_practices_score BETWEEN 0 AND 100),
  mobile_indicator      TEXT,

  https_enabled         BOOLEAN,
  page_title            TEXT,
  meta_description      TEXT,
  viewport_present      BOOLEAN,

  html_size_bytes       INTEGER CHECK (html_size_bytes >= 0),
  response_time_ms      INTEGER CHECK (response_time_ms >= 0),
  http_status           SMALLINT CHECK (http_status BETWEEN 100 AND 599),

  raw_analysis_response JSONB,

  analysis_status       TEXT NOT NULL
                          CHECK (analysis_status IN (
                            'completed',
                            'failed',
                            'rate_limited',
                            'blocked',
                            'timeout',
                            'unavailable'
                          )),
  error_code            TEXT,
  error_message         TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. Existing table from 001: rename the two columns that map 1:1 in
--    meaning and type, preserving their existing data exactly. Guarded
--    so this only fires when the OLD name is present and the NEW name
--    isn't already there (i.e. never on a table that's already been
--    migrated, and never on a table that never had the old column).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'website_analysis' AND column_name = 'url'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'website_analysis' AND column_name = 'analyzed_url'
  ) THEN
    ALTER TABLE website_analysis RENAME COLUMN url TO analyzed_url;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'website_analysis' AND column_name = 'raw_analysis_json'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'website_analysis' AND column_name = 'raw_analysis_response'
  ) THEN
    ALTER TABLE website_analysis RENAME COLUMN raw_analysis_json TO raw_analysis_response;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. Existing table from 001: add every Phase 10A column that has no
--    old-schema equivalent. Each is nullable, so adding it to a table
--    that already has rows never fails and never invents a value for
--    those rows -- they simply read back as NULL ("not measured"),
--    which is exactly how the application already treats an unmeasured
--    field. `IF NOT EXISTS` makes each of these safe to re-run.
-- ---------------------------------------------------------------------
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS mobile_indicator      TEXT;
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS html_size_bytes       INTEGER CHECK (html_size_bytes >= 0);
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS response_time_ms      INTEGER CHECK (response_time_ms >= 0);
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS http_status           SMALLINT CHECK (http_status BETWEEN 100 AND 599);
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS raw_analysis_response JSONB;
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS error_code            TEXT;
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS error_message         TEXT;

-- `analyzed_url` only needs adding here for the edge case where the
-- table already exists but somehow has neither `url` nor
-- `analyzed_url` (e.g. a hand-edited database). On the normal 001
-- lineage this is always a no-op, since step 2 already renamed `url`
-- to `analyzed_url` before this line runs. NOT NULL is intentionally
-- left off here (unlike the fresh-table CREATE TABLE above) because
-- ADD COLUMN with a NOT NULL constraint and no DEFAULT fails outright
-- against a table that already has rows.
ALTER TABLE website_analysis ADD COLUMN IF NOT EXISTS analyzed_url TEXT;

-- ---------------------------------------------------------------------
-- 4. `analysis_status`: this column already exists under this exact
--    name in every prior schema version (001 and any earlier draft of
--    003), so there is no rename/add step for it -- only its CHECK
--    constraint needs to change, from 001's ('pending','completed',
--    'failed') vocabulary to Phase 10A/10B's six-value vocabulary.
--
--    The old constraint is dropped by its default auto-generated name
--    (Postgres names a single-column inline CHECK
--    "<table>_<column>_check" unless told otherwise, and both 001's
--    and this migration's original inline CHECK on this column would
--    have used that same default name). Dropping a CHECK CONSTRAINT
--    only removes a validation rule -- it does not touch any row's
--    data.
--
--    The new constraint is added as NOT VALID: it is fully enforced
--    for every INSERT/UPDATE from this point forward (so the
--    application can never write anything outside the six allowed
--    values), but it does NOT retroactively scan or reject whatever
--    rows already exist -- so a legacy 'pending' row (if any exist)
--    is left exactly as it is instead of blocking this migration or
--    being altered/deleted. If you later confirm no legacy rows
--    violate the new list, you can tighten this further with
--    `ALTER TABLE website_analysis VALIDATE CONSTRAINT
--    website_analysis_analysis_status_check;` as a separate, explicit
--    step -- this migration does not do that automatically, since
--    that command can fail the whole statement if a violating row
--    exists.
-- ---------------------------------------------------------------------
ALTER TABLE website_analysis DROP CONSTRAINT IF EXISTS website_analysis_analysis_status_check;

ALTER TABLE website_analysis
  ADD CONSTRAINT website_analysis_analysis_status_check
  CHECK (analysis_status IN (
    'completed',
    'failed',
    'rate_limited',
    'blocked',
    'timeout',
    'unavailable'
  )) NOT VALID;

-- The 001 default of 'pending' is stale under the new vocabulary and
-- is never relied on by application code (every insert sets
-- analysis_status explicitly) -- dropped for hygiene. DROP DEFAULT is
-- a no-op, not an error, on a column that has no default.
ALTER TABLE website_analysis ALTER COLUMN analysis_status DROP DEFAULT;

-- ---------------------------------------------------------------------
-- 5. Indexes -- same names as both 001's and the original 003's
--    indexes, so these are no-ops wherever they already exist.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_website_analysis_business_id  ON website_analysis (business_id);
CREATE INDEX IF NOT EXISTS idx_website_analysis_status       ON website_analysis (analysis_status);
CREATE INDEX IF NOT EXISTS idx_website_analysis_analyzed_at  ON website_analysis (analyzed_at);

COMMENT ON TABLE website_analysis IS
  'One row per homepage analysis attempt (Phase 10A). Multiple rows per business are expected over time. May contain legacy columns (mobile_friendly, load_time) preserved from the original 001_init_schema.sql placeholder shape; these are no longer written by application code.';

COMMIT;
