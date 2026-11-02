-- =====================================================================
-- Alvin Lead Hunter — Deterministic lead scoring (Phase 12)
-- Migration: 005_lead_scoring
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- Purely additive on top of 001_init_schema.sql's `leads` table:
--
--   * no DROP TABLE, no DROP COLUMN, no DELETE, no TRUNCATE
--   * every existing column keeps its name, type, and existing data
--   * new columns are added with ADD COLUMN IF NOT EXISTS
--
-- WHY `leads`, not a new table: 001_init_schema.sql already created a
-- `leads` table with `lead_score` (SMALLINT, 0-100) and `priority`
-- columns shaped for exactly this purpose. No Phase to date has ever
-- written a row into `leads` (grep the codebase: there is no
-- `INSERT INTO leads` anywhere before this migration), so extending it
-- is safe and avoids the duplicate-lead-table this phase's spec
-- explicitly warns against.
--
-- ONE ROW PER BUSINESS: `leads` had no uniqueness constraint on
-- business_id before this migration. Phase 12 needs a single, current
-- "scoring state" per business (score/priority/factors/scored_at) that
-- gets safely recomputed and overwritten as new website/AI analyses
-- come in, rather than an ever-growing history table like
-- `website_analysis`/`ai_analysis` -- lead_status/sales_notes/
-- estimated_opportunity are themselves mutable "current state" fields,
-- not historical log entries, so a 1:1 relationship with `businesses`
-- fits the table's existing design. This migration adds a UNIQUE
-- constraint on business_id (guarded so it is only added if it does
-- not already exist) so the scoring service can safely
-- `INSERT ... ON CONFLICT (business_id) DO UPDATE`. This is safe to
-- add because, as above, `leads` has no rows in practice yet; if a
-- deployment somehow already has duplicate business_id rows, this
-- ALTER will fail loudly rather than silently corrupt data, which is
-- the correct behavior for the DBA to notice and reconcile by hand.
--
-- PRIORITY VOCABULARY CHANGE: 001 constrained `priority` to
-- ('low','medium','high','urgent'), but no code path has ever written
-- 'urgent' (leads.priority has never been written by any shipped code
-- -- see above), and Phase 12 explicitly specifies a four-tier
-- Low/Medium/High/Very High model. This migration replaces 'urgent'
-- with 'very_high' in the CHECK constraint, keeping the rest of the
-- codebase's existing lowercase-snake_case enum convention (compare
-- website_status, lead_status, recommended_service) rather than the
-- Title-Case spelling used for illustration in the Phase 12 prose spec.
-- Display formatting ("Very High") is a presentation-layer concern,
-- handled in the frontend. server/routes/dashboard.js's
-- highPriorityLeads count (the only other reader of leads.priority) is
-- updated in this same phase to match, since that IS the "Phase 12
-- explicitly requires integration" case called out in the phase brief.
--
-- New columns:
--   scoring_factors   JSONB. Ordered array of
--                     {code, label, points, reason} objects explaining
--                     exactly how lead_score was produced. NULL until a
--                     lead has been scored at least once.
--   scored_at         TIMESTAMPTZ. When lead_score/priority/
--                     scoring_factors were last (re)computed. NULL
--                     means "never scored".
--
-- Idempotent-safe: every step is guarded so this migration can be
-- re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS scoring_factors JSONB,
  ADD COLUMN IF NOT EXISTS scored_at       TIMESTAMPTZ;

COMMENT ON COLUMN leads.scoring_factors IS
  'Ordered array of {code, label, points, reason} objects produced by server/lib/leadScoring.js. Explains exactly how lead_score was calculated. NULL until scored at least once.';
COMMENT ON COLUMN leads.scored_at IS
  'When lead_score/priority/scoring_factors were last (re)computed by POST /api/businesses/:id/lead-score. NULL = never scored.';

-- ---------------------------------------------------------------------
-- 2. One lead row per business (see rationale above).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_business_id_key'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT leads_business_id_key UNIQUE (business_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. Priority vocabulary: 'urgent' -> 'very_high'
-- ---------------------------------------------------------------------
-- Defensive rescue in case some environment DID write 'urgent' despite
-- no shipped code path doing so (e.g. manual testing/seed data). Safe
-- no-op otherwise.
UPDATE leads SET priority = 'high' WHERE priority = 'urgent';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_priority_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_priority_check
  CHECK (priority IN ('low', 'medium', 'high', 'very_high'));

-- lead_score already has a valid 0-100 CHECK from 001_init_schema.sql
-- (`lead_score SMALLINT CHECK (lead_score BETWEEN 0 AND 100)`) --
-- nothing to change there.

COMMIT;
