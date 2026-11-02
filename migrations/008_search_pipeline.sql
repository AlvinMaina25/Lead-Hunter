-- =====================================================================
-- Alvin Lead Hunter — Post-search pipeline status
-- Migration: 008_search_pipeline
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- After a manual search completes, the server now runs a background
-- pipeline over THAT search's businesses (website check + website
-- analysis and AI analysis when requested, then lead scoring -- see
-- server/lib/searchPipelineService.js). The search request itself
-- returns before the pipeline finishes, so its progress and outcome
-- have to live somewhere the UI can read later. This migration adds
-- exactly that to the existing `searches` table -- no second table:
--
--   pipeline_status        NOT NULL DEFAULT 'not_run'.
--                          not_run                 no pipeline was ever started for
--                                                  this search (every row created
--                                                  before this migration)
--                          running                 started, not finished
--                          completed               every stage succeeded for every
--                                                  business
--                          completed_with_errors   finished; at least one stage failed
--                                                  for at least one business (the
--                                                  rest were still processed)
--                          failed                  the pipeline itself crashed
--                          interrupted             the server restarted while it was
--                                                  'running' (set at startup)
--   pipeline_started_at    NEW, nullable. NULL until a pipeline starts.
--   pipeline_completed_at  NEW, nullable. NULL while running / never run.
--   pipeline_summary       NEW, nullable JSONB. Counts for the finished
--                          run, e.g. {"businesses_total": 12, "scored": 12, ...}.
--   pipeline_failures      NEW, NOT NULL DEFAULT '[]'. JSONB array of
--                          {business_id, stage, code} -- error CODES
--                          only, never raw error text.
--
-- Purely additive: no DROP, no DELETE, no TRUNCATE, no change to any
-- existing column or constraint, and no secrets are stored here.
--
-- Idempotent-safe: ADD COLUMN IF NOT EXISTS, and the CHECK constraint
-- is only added when it does not already exist, so this migration can
-- be re-run without erroring if partially applied.
-- =====================================================================

BEGIN;

ALTER TABLE searches
  ADD COLUMN IF NOT EXISTS pipeline_status       TEXT        NOT NULL DEFAULT 'not_run',
  ADD COLUMN IF NOT EXISTS pipeline_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pipeline_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pipeline_summary      JSONB,
  ADD COLUMN IF NOT EXISTS pipeline_failures     JSONB       NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'searches_pipeline_status_check'
  ) THEN
    ALTER TABLE searches
      ADD CONSTRAINT searches_pipeline_status_check
      CHECK (pipeline_status IN (
        'not_run', 'running', 'completed', 'completed_with_errors', 'failed', 'interrupted'
      ));
  END IF;
END $$;

COMMENT ON COLUMN searches.pipeline_status IS
  'Progress of the post-search pipeline (server/lib/searchPipelineService.js). not_run = never started (all pre-008 rows).';
COMMENT ON COLUMN searches.pipeline_failures IS
  'JSON array of {business_id, stage, code} for every stage that failed in the last pipeline run. Codes only, never raw error text.';

COMMIT;
