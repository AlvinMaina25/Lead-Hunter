/**
 * Orchestrates GET /api/leads/export.csv (Phase 22 Part 1).
 *
 * Deliberately decoupled from Express, mirroring analyticsService.js /
 * leadDetailService.js / salesIntelligenceService.js:
 * server/routes/leads.js is a thin HTTP wrapper around what's exported
 * here, and server/lib/leadExport.js owns the pure CSV-building logic
 * (this module owns nothing but the data load + wiring the two
 * together).
 *
 * This is a READ-ONLY module: no lead, business, or analysis row is
 * ever written here. It issues exactly ONE SQL query (no N+1: one
 * business per lead via a plain JOIN, plus each business's latest
 * COMPLETED ai_analysis via a single LATERAL join, not a separate
 * query per lead).
 *
 * IMPORTANT (Phase 19 compatibility): Recommended Service reuses the
 * exact same definition of "the recommended service for a business"
 * that server/lib/leadDetailService.js#loadLatestCompletedAiAnalysis
 * already uses for GET /api/leads/:id and GET /api/leads/:id/intelligence
 * -- the latest `ai_analysis` row for that business with
 * status = 'completed', ordered by created_at DESC. No new
 * sales-intelligence logic is introduced; this module never computes,
 * guesses, or re-labels a service match, and never reads an
 * in-progress/failed ai_analysis row's recommended_service. (The
 * unrelated, pre-existing GET /api/leads list endpoint's LATERAL join
 * does not filter by status; that is Phase 13-era behavior left
 * untouched -- this export intentionally follows the later, more
 * precise Phase 19/leadDetailService "latest COMPLETED analysis"
 * contract instead, since that is the definition Phase 19 Sales
 * Intelligence itself is built on.)
 */

'use strict';

const { buildCsv } = require('./leadExport');

/** Same SELECT plus contact columns: the business's own email and contacts found on its website. */
const CONTACTS_SELECT = `
      b.email AS business_email,
      c.emails AS emails,
      c.whatsapp AS whatsapp,
      c.socials AS socials,`;

const CONTACTS_JOIN = `
    LEFT JOIN LATERAL (
      SELECT
        array_agg(value ORDER BY created_at, value) FILTER (WHERE contact_type = 'email') AS emails,
        array_agg(value ORDER BY created_at, value) FILTER (WHERE contact_type = 'whatsapp') AS whatsapp,
        array_agg(value ORDER BY contact_type, created_at, value)
          FILTER (WHERE contact_type IN ('instagram','facebook','tiktok','x','linkedin','youtube')) AS socials
      FROM business_contacts
      WHERE business_id = l.business_id
    ) c ON true`;

function exportSql({ includeContacts }) {
  return `
    SELECT${includeContacts ? CONTACTS_SELECT : ''}
      b.name AS business_name,
      b.phone AS phone,
      b.category AS category,
      b.city AS city,
      b.country AS country,
      b.website_url AS website_url,
      b.website_status AS website_status,
      l.lead_score AS lead_score,
      l.priority AS priority,
      a.recommended_service AS recommended_service
    FROM leads l
    JOIN businesses b ON b.id = l.business_id
    LEFT JOIN LATERAL (
      SELECT recommended_service
      FROM ai_analysis
      WHERE business_id = l.business_id AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    ) a ON true${includeContacts ? CONTACTS_JOIN : ''}
    ORDER BY l.created_at DESC
  `;
}

/**
 * One JOIN + one LATERAL join, in a single query -- no per-lead
 * queries. Only the columns the CSV export actually needs are
 * selected; no passwords, tokens, API keys, raw AI prompts/responses,
 * or other internal columns are read.
 *
 * @param {{query: Function}} pool
 * @param {{ includeContacts?: boolean }} [options] - also select the
 *   business email and website-found email/WhatsApp/social contacts
 *   (extra keys: business_email, emails, whatsapp, socials). Default
 *   false: exactly the original ten keys.
 * @returns {Promise<Array<{
 *   business_name: string,
 *   phone: string|null,
 *   category: string|null,
 *   city: string|null,
 *   country: string|null,
 *   website_url: string|null,
 *   website_status: string,
 *   lead_score: number|null,
 *   priority: string,
 *   recommended_service: string|null,
 * }>>}
 */
async function loadLeadsForExport(pool, { includeContacts = false } = {}) {
  try {
    const { rows } = await pool.query(exportSql({ includeContacts }));
    return rows;
  } catch (err) {
    // 42P01 = undefined_table: migration 009 hasn't been applied, so there
    // is no business_contacts table yet. Export without contact data
    // rather than failing the whole download.
    if (includeContacts && err && err.code === '42P01') {
      console.warn('[export] business_contacts missing - run `npm run migrate`; exporting without scraped contacts');
      const { rows } = await pool.query(exportSql({ includeContacts: false }));
      return rows;
    }
    throw err;
  }
}

/**
 * Full Phase 22 Part 1 read: load every exportable lead/business row
 * and render it as a CSV string. No pagination -- this is the
 * complete dataset available to the application, exactly as the spec
 * asks.
 *
 * @param {{query: Function}} pool
 * @param {{ includeContacts?: boolean }} [options] - add the Email and
 *   WhatsApp / Social columns. Default false (the original nine columns);
 *   GET /api/leads/export.csv passes true.
 * @returns {Promise<string>} the full CSV document, including header row
 */
async function getLeadsExportCsv(pool, { includeContacts = false } = {}) {
  const records = await loadLeadsForExport(pool, { includeContacts });
  return buildCsv(records, { includeContacts });
}

module.exports = {
  loadLeadsForExport,
  getLeadsExportCsv,
};
