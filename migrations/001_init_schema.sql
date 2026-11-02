-- =====================================================================
-- Alvin Lead Hunter — Initial schema
-- Migration: 001_init_schema
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- This migration is idempotent-safe on a fresh database. It is intended
-- to be run exactly once via `npm run migrate` (see scripts/migrate.js),
-- which tracks applied migrations in the schema_migrations table.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
-- gen_random_uuid() is built into PostgreSQL 13+, but pgcrypto is
-- enabled defensively in case the target Postgres predates that change.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Shared helper: keep updated_at columns current automatically
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Shared helper: normalize website URLs before they are stored
-- Lower-cases the URL, trims whitespace, and strips a trailing slash
-- so that "Example.com/" and "example.com" are stored the same way.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_website_url()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.website_url IS NOT NULL THEN
    NEW.website_url := lower(trim(NEW.website_url));
    NEW.website_url := regexp_replace(NEW.website_url, '/+$', '');
    IF NEW.website_url = '' THEN
      NEW.website_url := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. businesses
-- =====================================================================
CREATE TABLE businesses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_place_id    TEXT UNIQUE,                     -- e.g. Google Places ID; unique when provided (NULLs are not compared as duplicates in Postgres)
  name                 TEXT NOT NULL,
  category             TEXT,
  phone                TEXT,
  email                TEXT,
  address              TEXT,
  city                 TEXT,
  country              TEXT,
  latitude             NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude            NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
  google_maps_url      TEXT,
  google_rating        NUMERIC(2,1) CHECK (google_rating BETWEEN 0 AND 5),
  google_review_count  INTEGER CHECK (google_review_count >= 0),
  website_url          TEXT,
  website_status       TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (website_status IN ('active','inactive','broken','no_website','unknown')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_businesses_normalize_url
  BEFORE INSERT OR UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION normalize_website_url();

CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_businesses_external_place_id ON businesses (external_place_id);
CREATE INDEX idx_businesses_name             ON businesses (name);
CREATE INDEX idx_businesses_city             ON businesses (city);
CREATE INDEX idx_businesses_category         ON businesses (category);
CREATE INDEX idx_businesses_website_url      ON businesses (website_url);

-- =====================================================================
-- 2. website_analysis
-- =====================================================================
CREATE TABLE website_analysis (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  analyzed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  performance_score     SMALLINT CHECK (performance_score BETWEEN 0 AND 100),
  accessibility_score   SMALLINT CHECK (accessibility_score BETWEEN 0 AND 100),
  seo_score             SMALLINT CHECK (seo_score BETWEEN 0 AND 100),
  best_practices_score  SMALLINT CHECK (best_practices_score BETWEEN 0 AND 100),
  mobile_friendly       BOOLEAN,
  https_enabled         BOOLEAN,
  page_title            TEXT,
  meta_description      TEXT,
  viewport_present      BOOLEAN,
  load_time             NUMERIC(6,2) CHECK (load_time >= 0),   -- seconds
  analysis_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (analysis_status IN ('pending','completed','failed')),
  raw_analysis_json     JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_website_analysis_business_id ON website_analysis (business_id);
CREATE INDEX idx_website_analysis_status      ON website_analysis (analysis_status);

-- =====================================================================
-- 3. ai_analysis
-- =====================================================================
CREATE TABLE ai_analysis (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  summary              TEXT,
  problems             JSONB,       -- array of identified problems
  opportunities        JSONB,       -- array of identified opportunities
  recommended_service  TEXT,
  reasoning            TEXT,
  confidence           NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  ai_model             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_analysis_business_id ON ai_analysis (business_id);

-- =====================================================================
-- 4. leads
-- =====================================================================
CREATE TABLE leads (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_score             SMALLINT CHECK (lead_score BETWEEN 0 AND 100),
  priority               TEXT NOT NULL DEFAULT 'medium'
                           CHECK (priority IN ('low','medium','high','urgent')),
  lead_status            TEXT NOT NULL DEFAULT 'new'
                           CHECK (lead_status IN ('new','contacted','qualified','disqualified','converted','lost')),
  estimated_opportunity  NUMERIC(12,2) CHECK (estimated_opportunity >= 0),
  sales_notes            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_leads_business_id ON leads (business_id);
CREATE INDEX idx_leads_lead_score  ON leads (lead_score);
CREATE INDEX idx_leads_lead_status ON leads (lead_status);

-- =====================================================================
-- 5. sales_pipeline
-- =====================================================================
CREATE TABLE sales_pipeline (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new','contacted','responded','meeting_scheduled','proposal_sent','negotiation','won','lost')),
  contacted_at  TIMESTAMPTZ,
  response_at   TIMESTAMPTZ,
  meeting_at    TIMESTAMPTZ,
  proposal_at   TIMESTAMPTZ,
  won_at        TIMESTAMPTZ,
  lost_at       TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_sales_pipeline_updated_at
  BEFORE UPDATE ON sales_pipeline
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sales_pipeline_lead_id ON sales_pipeline (lead_id);
CREATE INDEX idx_sales_pipeline_stage   ON sales_pipeline (stage);

-- =====================================================================
-- 6. searches
-- =====================================================================
CREATE TABLE searches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_query   TEXT NOT NULL,
  category       TEXT,
  location       TEXT,
  results_count  INTEGER NOT NULL DEFAULT 0 CHECK (results_count >= 0),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed')),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX idx_searches_status ON searches (status);

-- =====================================================================
-- 7. search_results (links searches <-> businesses)
-- =====================================================================
CREATE TABLE search_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id      UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rank_position  INTEGER CHECK (rank_position >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (search_id, business_id)
);

CREATE INDEX idx_search_results_search_id   ON search_results (search_id);
CREATE INDEX idx_search_results_business_id ON search_results (business_id);

COMMIT;
