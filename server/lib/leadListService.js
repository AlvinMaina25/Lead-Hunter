/**
 * GET /api/leads: every lead joined with its business and the latest
 * recommended service, plus a small contact summary per lead
 * (has_phone / has_email / has_social / has_whatsapp) that the Leads
 * table uses for its indicators and its "has email / any contact"
 * filter. Flags only -- never the contact values themselves.
 *
 * Still ONE query (the contact flags are EXISTS sub-selects, no N+1).
 *
 * If migration 009 hasn't been applied yet (business_contacts doesn't
 * exist), the list falls back to the pre-009 query with the flags
 * derived from what that query can know, so deploying the code before
 * running `npm run migrate` never breaks the Leads page.
 */

'use strict';

const BASE_COLUMNS = `
  l.id,
  l.business_id,
  l.lead_score,
  l.priority,
  l.lead_status,
  l.estimated_opportunity,
  l.sales_notes,
  l.scoring_factors,
  l.scored_at,
  l.created_at,
  l.updated_at,
  b.name AS business_name,
  b.category AS business_category,
  b.city AS business_city,
  b.country AS business_country,
  a.recommended_service
`;

const FROM_CLAUSE = `
  FROM leads l
  JOIN businesses b ON b.id = l.business_id
  LEFT JOIN LATERAL (
    SELECT recommended_service
    FROM ai_analysis
    WHERE business_id = l.business_id
    ORDER BY created_at DESC
    LIMIT 1
  ) a ON true
  ORDER BY l.created_at DESC
`;

const SOCIAL_TYPES_SQL = `('instagram','facebook','tiktok','x','linkedin','youtube')`;

const WITH_CONTACTS_SQL = `
  SELECT
    ${BASE_COLUMNS},
    (b.phone IS NOT NULL AND btrim(b.phone) <> '') AS has_phone,
    (
      (b.email IS NOT NULL AND btrim(b.email) <> '')
      OR EXISTS (SELECT 1 FROM business_contacts c WHERE c.business_id = b.id AND c.contact_type = 'email')
    ) AS has_email,
    EXISTS (
      SELECT 1 FROM business_contacts c WHERE c.business_id = b.id AND c.contact_type IN ${SOCIAL_TYPES_SQL}
    ) AS has_social,
    EXISTS (
      SELECT 1 FROM business_contacts c WHERE c.business_id = b.id AND c.contact_type = 'whatsapp'
    ) AS has_whatsapp
  ${FROM_CLAUSE}
`;

const LEGACY_SQL = `
  SELECT
    ${BASE_COLUMNS},
    (b.phone IS NOT NULL AND btrim(b.phone) <> '') AS has_phone,
    (b.email IS NOT NULL AND btrim(b.email) <> '') AS has_email,
    false AS has_social,
    false AS has_whatsapp
  ${FROM_CLAUSE}
`;

/** Postgres "undefined_table" / "undefined_column": the schema predates migration 009. */
const SCHEMA_NOT_MIGRATED_CODES = new Set(['42P01', '42703']);

/**
 * @param {{query: Function}} pool
 * @returns {Promise<Array<object>>}
 */
async function listLeads(pool) {
  try {
    const { rows } = await pool.query(WITH_CONTACTS_SQL);
    return rows;
  } catch (err) {
    if (err && SCHEMA_NOT_MIGRATED_CODES.has(err.code)) {
      console.warn('[leads] contact tables missing - run `npm run migrate` (serving the list without contact flags)');
      const { rows } = await pool.query(LEGACY_SQL);
      return rows;
    }
    throw err;
  }
}

module.exports = { listLeads, WITH_CONTACTS_SQL, LEGACY_SQL };
