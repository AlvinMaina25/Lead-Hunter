-- =====================================================================
-- Alvin Lead Hunter — Contactable leads
-- Migration: 009_contacts
-- Target: PostgreSQL 13+ (Neon)
-- =====================================================================
-- 1. businesses.international_phone
--      Google's internationalPhoneNumber exactly as returned (e.g.
--      "+254 20 123 4567"). NULL for every pre-009 row until the
--      backfill (scripts/backfill-international-phone.js) fills it, and
--      for any business Google has no number for. We never derive it
--      from `phone` -- a national number alone does not tell us the
--      country code, and we never guess one.
--      international_phone_checked_at records that the backfill asked
--      Google for this business, so a business Google has no number for
--      is not re-fetched (and re-billed) on every backfill run.
--
-- 2. business_contacts
--      Contact details FOUND on a business's own website during website
--      analysis (homepage + at most one contact page). One row per
--      distinct (business, type, value); re-analysis updates
--      source_url/found_at on the existing row instead of adding a
--      duplicate. Only values actually found are stored -- nothing is
--      ever generated (no info@domain patterns).
--
--      contact_type: email | phone | whatsapp | instagram | facebook |
--                    tiktok | x | linkedin | youtube | contact_page
--      value:        email address, tel number (digits and an optional
--                    leading +), or an http(s) URL for everything else.
--      source_url:   the page the value was found on.
--      found_at:     when it was last seen on that page.
--
-- Purely additive: no DROP/DELETE/TRUNCATE of existing objects.
-- Idempotent: IF NOT EXISTS everywhere; the trigger is dropped and
-- recreated; safe to re-run if partially applied.
-- =====================================================================

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS international_phone TEXT,
  ADD COLUMN IF NOT EXISTS international_phone_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN businesses.international_phone IS
  'Google Places internationalPhoneNumber, as returned. NULL = not fetched yet (run the backfill) or Google has none. Never derived from phone.';

COMMENT ON COLUMN businesses.international_phone_checked_at IS
  'When the international-phone backfill last asked Google about this business. NULL = never asked.';

CREATE TABLE IF NOT EXISTS business_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_type  TEXT        NOT NULL
                  CHECK (contact_type IN (
                    'email', 'phone', 'whatsapp', 'instagram', 'facebook',
                    'tiktok', 'x', 'linkedin', 'youtube', 'contact_page'
                  )),
  value         TEXT        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 2048),
  source_url    TEXT        NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2048),
  found_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_contacts_unique UNIQUE (business_id, contact_type, value)
);

-- The UNIQUE constraint's index already serves business_id lookups
-- (it leads with business_id), so no separate business_id index.

DROP TRIGGER IF EXISTS trg_business_contacts_updated_at ON business_contacts;
CREATE TRIGGER trg_business_contacts_updated_at
  BEFORE UPDATE ON business_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE business_contacts IS
  'Contact details found on a business''s own website during analysis. Only values actually found; never guessed.';

COMMIT;
