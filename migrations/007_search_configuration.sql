-- =====================================================================
-- Alvin Lead Hunter — Search configuration (Phase 20 Part 1)
-- Migration: 007_search_configuration
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- The `searches` table (001_init_schema.sql) already stores what was
-- searched (search_query, category, location), its status and its
-- timestamps (started_at, completed_at). It has nowhere to record HOW
-- a manual search was configured, so this migration adds exactly the
-- missing pieces to that same table -- no second table:
--
--   keyword                     NEW, nullable. The optional keyword
--                                that was folded into search_query.
--                                NULL on rows created before this
--                                migration (it was never stored on its
--                                own; it is only embedded in
--                                search_query there).
--   radius_meters               NEW, nullable. Search radius around the
--                                resolved `location`, in metres. NULL =
--                                no radius was requested (every row
--                                created before this migration).
--                                CHECK 0 < radius_meters <= 50000, the
--                                range Google Places Text Search (New)
--                                accepts for locationBias.circle.
--   max_results                 NEW, NOT NULL DEFAULT 20. Maximum number
--                                of businesses the search was asked to
--                                keep. 20 is not an invented backfill:
--                                every search before this migration
--                                always requested 20 (googlePlaces.js
--                                MAX_RESULT_COUNT). CHECK 1..20 (one
--                                Google page; no pagination yet).
--   website_analysis_requested  NEW, NOT NULL DEFAULT false. The user's
--                                "run website analysis" choice.
--   ai_analysis_requested       NEW, NOT NULL DEFAULT false. The user's
--                                "run AI analysis" choice.
--
-- The two *_requested columns record the user's CHOICE for later
-- pipeline stages. Phase 20 does not execute either analysis as part
-- of a search (the existing pipeline never did), so `true` means
-- "requested", not "done". Existing rows correctly read `false`:
-- nothing was ever requested for them.
--
-- Purely additive: no DROP, no DELETE, no TRUNCATE, no change to any
-- existing column or constraint, and no secrets are stored here.
--
-- Idempotent-safe: ADD COLUMN IF NOT EXISTS, and each CHECK constraint
-- is only added when it does not already exist, so this migration can
-- be re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

ALTER TABLE searches
  ADD COLUMN IF NOT EXISTS keyword                    TEXT,
  ADD COLUMN IF NOT EXISTS radius_meters              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS max_results                INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS website_analysis_requested BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_analysis_requested      BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'searches_radius_meters_check'
  ) THEN
    ALTER TABLE searches
      ADD CONSTRAINT searches_radius_meters_check
      CHECK (radius_meters IS NULL OR (radius_meters > 0 AND radius_meters <= 50000));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'searches_max_results_check'
  ) THEN
    ALTER TABLE searches
      ADD CONSTRAINT searches_max_results_check
      CHECK (max_results >= 1 AND max_results <= 20);
  END IF;
END $$;

COMMIT;
