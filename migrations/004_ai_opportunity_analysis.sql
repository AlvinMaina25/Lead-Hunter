-- =====================================================================
-- Alvin Lead Hunter — AI opportunity analysis (Phase 11B)
-- Migration: 004_ai_opportunity_analysis
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- 001_init_schema.sql already created an `ai_analysis` table shaped for
-- roughly this purpose (business_id, summary, problems, opportunities,
-- recommended_service, reasoning, confidence, ai_model, created_at).
-- This migration is purely additive on top of it:
--
--   * no DROP TABLE, no DROP COLUMN, no DELETE, no TRUNCATE
--   * every existing column keeps its name and its existing data
--   * new columns are added with ADD COLUMN IF NOT EXISTS
--   * the only column CHANGED in place is `confidence`, whose scale is
--     widened from 001's NUMERIC(4,3) fraction (0-1) to the INTEGER
--     percentage (0-100) the Phase 11B spec requires. Any pre-existing
--     0-1 value is losslessly rescaled (value * 100, rounded), not
--     discarded -- see step 2. In practice this table has never been
--     written to by any shipped code path yet, so there is no real data
--     at risk, but the migration is written to be safe either way.
--
-- Multiple AI analyses per business remain possible (no unique
-- constraint on business_id was ever added, and none is added here) --
-- every successful call to POST /api/businesses/:id/opportunity-analysis
-- inserts a new row rather than overwriting a previous one, exactly
-- like website_analysis already does for Phase 10.
--
-- New columns added:
--   status           NEW. Outcome of this analysis attempt:
--                     'completed'    -- validated AI output persisted
--                     'failed'       -- model output was malformed, or
--                                       every problem/opportunity was
--                                       rejected by anti-hallucination
--                                       validation, or a database/
--                                       validation error occurred
--                     'rate_limited' -- Gemini reported rate limiting
--                     'timeout'      -- Gemini request timed out
--                     'unavailable'  -- Gemini unreachable, or
--                                       GEMINI_API_KEY not configured
--                     No default -- application code always sets it
--                     explicitly, mirroring website_analysis.analysis_status.
--   error_code        NEW. Set only when status <> 'completed'.
--   error_message     NEW. Set only when status <> 'completed'. Never
--                     contains a raw stack trace or the API key.
--   input_snapshot     NEW. JSONB snapshot of the verified
--                     business/website/website_analysis fields actually
--                     sent to the model for THIS analysis. Kept because
--                     the underlying business/website data can change
--                     later -- this is what the stored result was
--                     actually reasoned from, for audit and for the
--                     anti-hallucination check to be re-verifiable.
--   raw_ai_response   NEW. The full validated structured JSON the model
--                     returned (same content as summary/problems/
--                     opportunities/recommended_service/reasoning/
--                     confidence/sales_angle, kept together as one blob
--                     for convenience/debugging). Never the raw HTTP
--                     body (which could include request metadata) --
--                     just the parsed JSON payload.
--   sales_angle       NEW. Required top-level output field from the
--                     Phase 11B schema; 001 had no equivalent column.
--   analyzed_at       NEW. Alias-purpose timestamp matching the Phase
--                     11B spec's "created_at/analyzed_at" language.
--                     001's `created_at` already serves this exact
--                     purpose (set once, at insert time, never
--                     updated), so rather than add a second
--                     always-identical timestamp column, this migration
--                     documents the equivalence here and application
--                     code reads/writes `created_at`. No new column.
--
-- Idempotent-safe: every step is guarded so this migration can be
-- re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------
ALTER TABLE ai_analysis
  ADD COLUMN IF NOT EXISTS status         TEXT,
  ADD COLUMN IF NOT EXISTS error_code     TEXT,
  ADD COLUMN IF NOT EXISTS error_message  TEXT,
  ADD COLUMN IF NOT EXISTS input_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS raw_ai_response JSONB,
  ADD COLUMN IF NOT EXISTS sales_angle    TEXT;

COMMENT ON COLUMN ai_analysis.status IS
  'Outcome of this AI analysis attempt: completed | failed | rate_limited | timeout | unavailable.';
COMMENT ON COLUMN ai_analysis.input_snapshot IS
  'Verified business/website/website_analysis fields actually sent to the model for this analysis (source-of-truth snapshot at analysis time).';
COMMENT ON COLUMN ai_analysis.raw_ai_response IS
  'Full validated structured JSON returned by the model for this analysis.';

-- ---------------------------------------------------------------------
-- 2. Rescale `confidence` from a 0-1 fraction to a 0-100 integer
--    percentage, preserving any existing data.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_analysis' AND column_name = 'confidence'
      AND data_type <> 'integer'
  ) THEN
    ALTER TABLE ai_analysis
      ALTER COLUMN confidence TYPE INTEGER
      USING (CASE WHEN confidence IS NULL THEN NULL ELSE ROUND(confidence * 100)::INTEGER END);
  END IF;
END $$;

ALTER TABLE ai_analysis DROP CONSTRAINT IF EXISTS ai_analysis_confidence_check;
ALTER TABLE ai_analysis
  ADD CONSTRAINT ai_analysis_confidence_check CHECK (confidence BETWEEN 0 AND 100);

-- ---------------------------------------------------------------------
-- 3. Constrain `status` to the Phase 11B vocabulary once every existing
--    row has a value (there are none pre-existing in practice, but this
--    is written defensively).
-- ---------------------------------------------------------------------
UPDATE ai_analysis SET status = 'completed' WHERE status IS NULL;

ALTER TABLE ai_analysis ALTER COLUMN status SET NOT NULL;

ALTER TABLE ai_analysis DROP CONSTRAINT IF EXISTS ai_analysis_status_check;
ALTER TABLE ai_analysis
  ADD CONSTRAINT ai_analysis_status_check
  CHECK (status IN ('completed', 'failed', 'rate_limited', 'timeout', 'unavailable'));

-- ---------------------------------------------------------------------
-- 4. Constrain `recommended_service` to the allowed service list or
--    NULL. Kept in sync with server/lib/aiOpportunityAnalysis.js's
--    ALLOWED_SERVICES.
-- ---------------------------------------------------------------------
ALTER TABLE ai_analysis DROP CONSTRAINT IF EXISTS ai_analysis_recommended_service_check;
ALTER TABLE ai_analysis
  ADD CONSTRAINT ai_analysis_recommended_service_check
  CHECK (recommended_service IS NULL OR recommended_service IN (
    'new_website',
    'website_redesign',
    'mobile_optimization',
    'seo_improvement',
    'digital_business_card',
    'qr_menu_order_system',
    'whatsapp_integration',
    'ai_customer_service_chatbot',
    'booking_system',
    'ecommerce_website'
  ));

-- ---------------------------------------------------------------------
-- 5. Helpful index for "latest analysis per business" lookups.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ai_analysis_business_id_created_at
  ON ai_analysis (business_id, created_at DESC);

COMMIT;
