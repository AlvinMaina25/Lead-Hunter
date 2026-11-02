-- =====================================================================
-- Alvin Lead Hunter — Website detection foundation
-- Migration: 002_add_website_checked_at
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- Phase 9A lays the groundwork for actually checking business websites
-- (no HTTP requests happen yet — that's a later phase). This migration
-- only touches the `businesses` table and only adds/aligns what that
-- future work needs:
--
--   1. A new website_checked_at column: when we last attempted a
--      reachability check for this business's website. NULL means
--      "never checked", which is true for every existing row.
--
--   2. The website_status CHECK constraint is narrowed to the four
--      values the detection feature actually uses:
--        'no_website' | 'reachable' | 'unreachable' | 'unknown'
--      The original constraint also allowed 'active' / 'inactive' /
--      'broken', but no code path has ever written those values
--      (see server/lib/normalize.js, which only ever sets 'unknown'
--      or 'no_website') — they were placeholders for analysis logic
--      that is only now being built, under this new, simpler
--      vocabulary. Existing rows only ever contain 'unknown' or
--      'no_website', both of which remain valid, so this is safe to
--      apply without a data backfill.
--
-- Idempotent-safe: guards column/constraint creation so this migration
-- can be re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. website_checked_at
-- ---------------------------------------------------------------------
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS website_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN businesses.website_checked_at IS
  'When website_status was last (re)computed by an actual reachability check. NULL = never checked.';

-- ---------------------------------------------------------------------
-- 2. Narrow the website_status vocabulary
-- ---------------------------------------------------------------------
ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_website_status_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_website_status_check
  CHECK (website_status IN ('no_website', 'reachable', 'unreachable', 'unknown'));

COMMIT;
