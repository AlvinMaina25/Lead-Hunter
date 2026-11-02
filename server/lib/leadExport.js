/**
 * CSV building for GET /api/leads/export.csv (Phase 22 Part 1).
 *
 * Deliberately decoupled from Express and from the database, mirroring
 * analytics.js / leadScoring.js: server/lib/leadExportService.js owns
 * the one SQL query this feature needs, and server/routes/leads.js is
 * a thin HTTP wrapper. Everything in this module is a pure function of
 * plain JS values, so it is fully unit-testable without a real (or
 * fake) Postgres pool.
 *
 * This module invents NO new data. Recommended Service is expected to
 * already be the exact `recommended_service` value Phase 19 computed
 * and stored on `ai_analysis` (see leadExportService.js) -- this
 * module never derives, guesses, or re-labels it.
 */

'use strict';

/**
 * Stable column order for the export, both for the header row and for
 * every data row. Keep in sync with rowFromExportRecord below.
 */
const CSV_COLUMNS = Object.freeze([
  'Business',
  'Phone',
  'Category',
  'Location',
  'Website',
  'Website Status',
  'Lead Score',
  'Priority',
  'Recommended Service',
]);

/**
 * Contact columns appended AFTER the original nine when contacts are
 * included (the HTTP export always includes them; see
 * leadExportService.getLeadsExportCsv). Kept separate from CSV_COLUMNS
 * so the original nine-column contract is unchanged for callers that
 * don't opt in.
 */
const CSV_CONTACT_COLUMNS = Object.freeze(['Email', 'WhatsApp / Social']);

/** Separator between multiple values inside one CSV cell. */
const CSV_MULTI_VALUE_SEPARATOR = '; ';

/** CRLF, per RFC 4180. */
const CSV_LINE_ENDING = '\r\n';

/**
 * Leading characters that Excel/Google Sheets treat as the start of a
 * formula when a CSV cell is opened (CSV/formula injection, CWE-1236).
 * Business name, category, and recommended-service values ultimately
 * come from third-party (Google Places) or AI-generated data we don't
 * control, so any of these could be crafted to execute as a formula
 * (or trigger a DDE/external-command call in older Excel versions) the
 * moment someone opens the exported file.
 */
const FORMULA_TRIGGER_PATTERN = /^[=+\-@]/;

/**
 * Turns one arbitrary value into a safe CSV field per RFC 4180:
 *   - null/undefined become an empty field (never the strings "null"/
 *     "undefined").
 *   - Any other value is stringified.
 *   - A value containing a comma, a double quote, or a line break
 *     (\n or \r) is wrapped in double quotes, with any double quote
 *     inside it doubled ("" ).
 *
 * @param {unknown} value
 * @param {{ guardFormulaInjection?: boolean }} [options] - when true,
 *   a value starting with =, +, -, or @ is prefixed with a leading
 *   single quote so Excel/Sheets opens it as inert text instead of a
 *   formula. Only pass this for free-text fields (business name,
 *   category, recommended service) -- NEVER for phone, since a real
 *   phone number may legitimately start with "+" (e.g. "+254...").
 *   RFC 4180 quoting below is still applied on top of this as needed.
 * @returns {string}
 */
function csvEscape(value, { guardFormulaInjection = false } = {}) {
  if (value === null || value === undefined) return '';

  let str = String(value);
  if (guardFormulaInjection && FORMULA_TRIGGER_PATTERN.test(str)) {
    str = `'${str}`;
  }

  const needsQuoting = /[",\n\r]/.test(str);
  if (!needsQuoting) return str;

  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Joins city/country the same way the frontend's LeadsTable "Location"
 * column already does (frontend/src/components/leads/LeadsTable.tsx):
 * both present -> "City, Country"; only one present -> just that one;
 * neither present -> empty (the UI's "—" placeholder is a display
 * concern, not a CSV value -- an empty field is correct here per the
 * Phase 22 spec).
 *
 * @param {string|null|undefined} city
 * @param {string|null|undefined} country
 * @returns {string}
 */
function buildLocation(city, country) {
  return [city, country].filter((v) => v !== null && v !== undefined && v !== '').join(', ');
}

/**
 * Joins scraped/third-party values into one cell. Control characters
 * (newlines, tabs, ...) are replaced by spaces so a hostile value can't
 * smuggle in a line break or a leading TAB/CR that spreadsheets treat
 * specially; empty/non-string entries are dropped and duplicates
 * removed (case-insensitively), keeping first-seen order.
 *
 * @param {unknown} values
 * @returns {string}
 */
function joinScrapedValues(values) {
  if (!Array.isArray(values)) return '';
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out.join(CSV_MULTI_VALUE_SEPARATOR);
}

/**
 * The contact cells of one record: [Email, WhatsApp / Social]. Both
 * hold values scraped from third-party websites (or typed in by
 * someone), so BOTH go through the formula-injection guard -- an
 * address like "=cmd|'/c calc'!A1@x.com" or a URL-looking cell starting
 * with "@" must open as inert text.
 *
 * Record fields (all optional): business_email, emails[], whatsapp[],
 * socials[]. Email = the business's own email (if any) then every
 * scraped one; WhatsApp / Social = WhatsApp links then social profiles.
 *
 * @param {object} record
 * @returns {string[]} exactly CSV_CONTACT_COLUMNS.length escaped fields
 */
function contactCellsFromExportRecord(record) {
  const emails = [record.business_email, ...(Array.isArray(record.emails) ? record.emails : [])];
  const reach = [
    ...(Array.isArray(record.whatsapp) ? record.whatsapp : []),
    ...(Array.isArray(record.socials) ? record.socials : []),
  ];
  return [
    csvEscape(joinScrapedValues(emails), { guardFormulaInjection: true }),
    csvEscape(joinScrapedValues(reach), { guardFormulaInjection: true }),
  ];
}

/**
 * One export record's fields, in the CSV_COLUMNS order, already
 * escaped. Missing/null values become empty fields; nothing here
 * fabricates a value that isn't already on the record.
 *
 * With `includeContacts`, the CSV_CONTACT_COLUMNS cells are appended.
 *
 * @param {{
 *   business_name: string|null,
 *   phone: string|null,
 *   category: string|null,
 *   city: string|null,
 *   country: string|null,
 *   website_url: string|null,
 *   website_status: string|null,
 *   lead_score: number|null,
 *   priority: string|null,
 *   recommended_service: string|null,
 *   business_email?: string|null,
 *   emails?: string[],
 *   whatsapp?: string[],
 *   socials?: string[],
 * }} record
 * @param {{ includeContacts?: boolean }} [options]
 * @returns {string[]} CSV_COLUMNS.length (+ CSV_CONTACT_COLUMNS.length with includeContacts) escaped fields
 */
function rowFromExportRecord(record, { includeContacts = false } = {}) {
  const location = buildLocation(record.city, record.country);

  const fields = [
    csvEscape(record.business_name, { guardFormulaInjection: true }),
    csvEscape(record.phone), // NEVER guarded: legitimate numbers may start with "+" (e.g. +254...)
    csvEscape(record.category, { guardFormulaInjection: true }),
    csvEscape(location),
    csvEscape(record.website_url),
    csvEscape(record.website_status),
    csvEscape(record.lead_score),
    csvEscape(record.priority),
    csvEscape(record.recommended_service, { guardFormulaInjection: true }),
  ];

  return includeContacts ? [...fields, ...contactCellsFromExportRecord(record)] : fields;
}

/**
 * Builds the full CSV document (header + one row per record) as a
 * single string. CRLF line endings throughout, per RFC 4180 -- exactly
 * what CSV_LINE_ENDING declares, used consistently for the header row
 * and every data row.
 *
 * @param {Array<object>} records - see rowFromExportRecord's jsdoc for shape
 * @param {{ includeContacts?: boolean }} [options] - append the Email and
 *   WhatsApp / Social columns (default false: the original nine columns)
 * @returns {string}
 */
function buildCsv(records, { includeContacts = false } = {}) {
  const header = includeContacts ? [...CSV_COLUMNS, ...CSV_CONTACT_COLUMNS] : CSV_COLUMNS;
  const lines = [header.join(',')];
  for (const record of records) {
    lines.push(rowFromExportRecord(record, { includeContacts }).join(','));
  }
  return lines.join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
}

module.exports = {
  CSV_COLUMNS,
  CSV_CONTACT_COLUMNS,
  CSV_LINE_ENDING,
  csvEscape,
  joinScrapedValues,
  buildLocation,
  contactCellsFromExportRecord,
  rowFromExportRecord,
  buildCsv,
};
