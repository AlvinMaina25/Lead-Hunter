-- =====================================================================
-- Alvin Lead Hunter — Sales pipeline stage realignment (Phase 13A)
-- Migration: 006_pipeline_stage_realignment
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- Purely additive/idempotent-safe on top of 001_init_schema.sql's
-- `sales_pipeline` table:
--
--   * no DROP TABLE, no DELETE, no TRUNCATE
--   * every existing column keeps its name, type, and existing data
--
-- WHY THIS TABLE: `sales_pipeline` already exists (001_init_schema.sql)
-- with a `lead_id` FK, a `stage` column, and per-stage timestamp
-- columns -- exactly the shape Phase 13A's pipeline-stage requirement
-- needs. grep of the codebase (server/**, frontend/**) shows no
-- `INSERT INTO sales_pipeline` / `FROM sales_pipeline` anywhere -- this
-- table has never been read or written by any shipped code path, so
-- realigning its CHECK constraint and adding a uniqueness guarantee is
-- safe and avoids inventing a second, duplicate pipeline table.
--
-- STAGE VOCABULARY CHANGE: 001 constrained `stage` to
--   ('new','contacted','responded','meeting_scheduled','proposal_sent',
--    'negotiation','won','lost')
-- Phase 13A's spec requires exactly these eight stages instead:
--   ('new','researched','contacted','responded','meeting','proposal',
--    'won','lost')
-- Since no code path has ever written a row here, there is no real
-- data at risk, but the defensive rescue below (mirroring migration
-- 005's priority rescue) remaps any pre-existing value under the old
-- vocabulary to its closest equivalent under the new one, so this
-- migration never fails against a hand-seeded or partially-applied
-- database:
--   'meeting_scheduled' -> 'meeting'
--   'proposal_sent'     -> 'proposal'
--   'negotiation'       -> 'proposal'   (closest remaining stage; no
--                                        1:1 equivalent exists)
--
-- ONE ROW PER LEAD: `sales_pipeline` had no uniqueness constraint on
-- lead_id before this migration. The lead detail page needs a single,
-- current "what stage is this lead at" row per lead (not an
-- ever-growing history log), so this migration adds a UNIQUE
-- constraint on lead_id (guarded so it is only added if it does not
-- already exist), mirroring leads_business_id_key from
-- migrations/005_lead_scoring.sql. This lets
-- server/lib/leadDetailService.js safely
-- `INSERT ... ON CONFLICT (lead_id) DO UPDATE`. Safe to add because,
-- as above, this table has no rows in practice yet; if a deployment
-- somehow already has duplicate lead_id rows, this ALTER will fail
-- loudly rather than silently corrupt data, which is the correct
-- behavior for a human to notice and reconcile by hand.
--
-- The existing per-stage timestamp columns (contacted_at, response_at,
-- meeting_at, proposal_at, won_at, lost_at) and `notes` are left
-- exactly as they are -- Phase 13A does not automatically populate
-- them on a stage change, so no column rename/add is needed here.
--
-- Idempotent-safe: every step is guarded so this migration can be
-- re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Defensive rescue: remap any pre-existing value under the old
--    vocabulary to its closest equivalent under the new one. No-op on
--    a table with no rows (the expected state in every real deployment
--    today).
-- ---------------------------------------------------------------------
UPDATE sales_pipeline SET stage = 'meeting'  WHERE stage = 'meeting_scheduled';
UPDATE sales_pipeline SET stage = 'proposal' WHERE stage = 'proposal_sent';
UPDATE sales_pipeline SET stage = 'proposal' WHERE stage = 'negotiation';

-- ---------------------------------------------------------------------
-- 2. Stage vocabulary: replace the CHECK constraint.
-- ---------------------------------------------------------------------
ALTER TABLE sales_pipeline DROP CONSTRAINT IF EXISTS sales_pipeline_stage_check;
ALTER TABLE sales_pipeline
  ADD CONSTRAINT sales_pipeline_stage_check
  CHECK (stage IN ('new', 'researched', 'contacted', 'responded', 'meeting', 'proposal', 'won', 'lost'));

-- 001's default of 'new' is still a valid value under the new
-- vocabulary, so it is intentionally left in place unchanged.

-- ---------------------------------------------------------------------
-- 3. One pipeline row per lead (see rationale above).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_pipeline_lead_id_key'
  ) THEN
    ALTER TABLE sales_pipeline ADD CONSTRAINT sales_pipeline_lead_id_key UNIQUE (lead_id);
  END IF;
END $$;

COMMIT;
