/**
 * Structured Sales Intelligence (Phase 19 Part 1).
 *
 * Orchestrates GET /api/leads/:id/intelligence.
 *
 * This module invents NO new AI pipeline and NO new database state.
 * It is a pure, read-only TRANSFORMATION of data that already exists:
 *
 *   - VERIFIED OBSERVATIONS come from the exact same
 *     buildVerifiedInput(business, websiteAnalysis) snapshot that
 *     server/lib/aiOpportunityAnalysis.js already builds and sends to
 *     Gemini (and already checks AI evidence against) -- reused as-is,
 *     not recomputed, so "what counts as verified" has one single
 *     source of truth across the whole app.
 *   - AI INTERPRETATION comes from the already-persisted, already
 *     anti-hallucination-filtered `problems`/`opportunities` on the
 *     latest COMPLETED `ai_analysis` row (server/lib/leadDetailService.js
 *     already loads exactly this row for GET /api/leads/:id).
 *   - SERVICE MATCH comes from that same row's `recommended_service` /
 *     `reasoning` / `confidence`.
 *
 * The one rule this module exists to enforce: an AI-generated
 * interpretation, or a potential service match, must NEVER be mixed
 * into or mistaken for a verified observation. They are always
 * returned as separate top-level arrays/objects, never merged into
 * one list.
 *
 * Like leadDetailService.js, this module never calls Gemini/PageSpeed/
 * Google itself -- see getSalesIntelligence, which reuses
 * leadDetailService.getLeadDetail rather than issuing its own queries,
 * so a lead with no completed website/AI analysis yet is handled
 * exactly the same way GET /api/leads/:id already handles it (null
 * sections, not an error).
 */

'use strict';

const {
  NotFoundError,
  ValidationError,
  getLeadDetail,
} = require('./leadDetailService');
const { buildVerifiedInput } = require('./aiOpportunityAnalysis');

// ---------------------------------------------------------------------
// 1. Verified observations
// ---------------------------------------------------------------------

/**
 * Describes, for each field buildVerifiedInput can produce, how to
 * turn it into a human-readable {fact, source} verified observation.
 *
 * `source` names where the fact was actually measured/stored --
 * 'business_record' for plain `businesses` columns, 'website_analyzer'
 * for anything that only exists once a website_analysis row has been
 * produced (server/lib/websiteAnalysis.js / pagespeedInsights.js).
 *
 * `always: true` fields are included even when the underlying value is
 * false/absent, because the absence itself is the verified fact (e.g.
 * "no phone number is on file" is just as verified as "has one"; NULL
 * is never true/false, so `website_status`, which is NOT NULL with a
 * default of 'unknown' in businesses, is always meaningful too).
 * Every other field is included only when the value is not null --
 * skipping "not measured" rather than inventing a sentence for it.
 *
 * Deliberately does NOT include any field buildVerifiedInput doesn't
 * already produce (no booking/WhatsApp/contact-form/social-link
 * detection -- nothing in this codebase measures those yet; see the
 * Phase 19 Part 1 spec's "DO NOT invent fields" rule).
 */
const OBSERVATION_FIELD_DEFS = [
  { key: 'business_name', source: 'business_record', always: true, fact: (v) => `Business name is "${v}".` },
  { key: 'business_category', source: 'business_record', fact: (v) => `Business category is "${v}".` },
  { key: 'business_city', source: 'business_record', fact: (v) => `Business city is "${v}".` },
  { key: 'business_country', source: 'business_record', fact: (v) => `Business country is "${v}".` },
  { key: 'business_has_phone', source: 'business_record', always: true, fact: (v) => (v ? 'A phone number is on file.' : 'No phone number is on file.') },
  { key: 'business_has_email', source: 'business_record', always: true, fact: (v) => (v ? 'An email address is on file.' : 'No email address is on file.') },
  { key: 'business_google_rating', source: 'business_record', fact: (v) => `Google rating is ${v}.` },
  { key: 'business_google_review_count', source: 'business_record', fact: (v) => `Google review count is ${v}.` },
  { key: 'business_has_website', source: 'business_record', always: true, fact: (v) => (v ? 'Business has a website on file.' : 'Business has no website on file.') },
  { key: 'website_url', source: 'business_record', fact: (v) => `Website URL is ${v}.` },
  { key: 'website_status', source: 'business_record', always: true, fact: (v) => `Website status is "${v}".` },
  { key: 'website_https_enabled', source: 'website_analyzer', fact: (v) => (v ? 'Website uses HTTPS.' : 'Website does not use HTTPS.') },
  { key: 'website_http_status', source: 'website_analyzer', fact: (v) => `Website responded with HTTP status ${v}.` },
  { key: 'website_response_time_ms', source: 'website_analyzer', fact: (v) => `Website homepage responded in ${v}ms.` },
  { key: 'website_html_size_bytes', source: 'website_analyzer', fact: (v) => `Website homepage HTML size is ${v} bytes.` },
  { key: 'website_page_title', source: 'website_analyzer', fact: (v) => `Website page title is "${v}".` },
  { key: 'website_meta_description', source: 'website_analyzer', fact: (v) => `Website meta description is "${v}".` },
  { key: 'website_viewport_present', source: 'website_analyzer', fact: (v) => (v ? 'Website has a mobile viewport tag.' : 'Website has no mobile viewport tag.') },
  { key: 'analysis_performance_score', source: 'website_analyzer', fact: (v) => `PageSpeed performance score is ${v}/100.` },
  { key: 'analysis_accessibility_score', source: 'website_analyzer', fact: (v) => `PageSpeed accessibility score is ${v}/100.` },
  { key: 'analysis_seo_score', source: 'website_analyzer', fact: (v) => `PageSpeed SEO score is ${v}/100.` },
  { key: 'analysis_best_practices_score', source: 'website_analyzer', fact: (v) => `PageSpeed best-practices score is ${v}/100.` },
  { key: 'analysis_mobile_indicator', source: 'website_analyzer', fact: (v) => `Website was analyzed using form factor "${v}".` },
  { key: 'analysis_status', source: 'website_analyzer', fact: (v) => `Latest website analysis attempt status is "${v}".` },
  { key: 'analysis_analyzed_at', source: 'website_analyzer', fact: (v) => `Website was last analyzed at ${v}.` },
];

/**
 * @param {Record<string, string|number|boolean|null>} snapshot - buildVerifiedInput's output
 * @returns {Array<{fact: string, source: string}>}
 */
function buildVerifiedObservations(snapshot) {
  const observations = [];
  for (const def of OBSERVATION_FIELD_DEFS) {
    const value = snapshot[def.key];
    const present = value !== null && value !== undefined;
    if (!present && !def.always) continue;
    observations.push({ fact: def.fact(value), source: def.source });
  }
  return observations;
}

// ---------------------------------------------------------------------
// 2. AI interpretation (kept explicitly separate from observations)
// ---------------------------------------------------------------------

/**
 * The user-facing text for one stored problem/opportunity entry, or
 * null when the entry has no text to show.
 *
 * Two persisted shapes exist in ai_analysis.problems/opportunities:
 *   - current: an object { title, description, evidence[, service] }
 *     (aiOpportunityAnalysis.js RESPONSE_JSON_SCHEMA) -> "title: description"
 *   - legacy: a plain string (older rows / hand-inserted rows; the
 *     lead-detail AI-analysis panel already renders these) -> the
 *     string itself
 * An entry with neither is skipped. Text is never synthesized, and
 * a missing title/description is never interpolated into the
 * sentence (that is what produced "undefined: undefined").
 *
 * @param {unknown} item
 * @returns {string|null}
 */
function interpretationText(item) {
  const isText = (v) => typeof v === 'string' && v.trim().length > 0;

  if (isText(item)) return item;
  if (!item || typeof item !== 'object') return null;

  if (isText(item.title) && isText(item.description)) return `${item.title}: ${item.description}`;
  if (isText(item.title)) return item.title;
  if (isText(item.description)) return item.description;
  return null;
}

/**
 * @param {'problem'|'opportunity'} type
 * @param {unknown} item
 * @returns {{type: string, interpretation: string, service: string|null, evidence: Array<object>}|null}
 */
function toInterpretationItem(type, item) {
  const interpretation = interpretationText(item);
  if (interpretation === null) return null;

  const isObject = typeof item === 'object';
  return {
    type,
    interpretation,
    // `service` only ever exists on an object-shaped opportunity.
    service: type === 'opportunity' && isObject && typeof item.service === 'string' && item.service ? item.service : null,
    // Legacy string entries carry no evidence; none is invented for them.
    evidence: isObject && Array.isArray(item.evidence) ? item.evidence : [],
  };
}

/**
 * Flattens ai_analysis.problems + ai_analysis.opportunities (already
 * validated and anti-hallucination-filtered by
 * aiOpportunityAnalysis.js -- never re-validated here) into one
 * labeled array. Every item still carries its original `evidence`
 * array so the interpretation remains traceable back to the verified
 * fields it was actually reasoned from.
 *
 * @param {{problems: Array<object|string>|null, opportunities: Array<object|string>|null}|null} aiAnalysis
 * @returns {Array<{type: 'problem'|'opportunity', interpretation: string, service: string|null, evidence: Array<object>}>}
 */
function buildAiInterpretation(aiAnalysis) {
  if (!aiAnalysis) return [];

  const problems = Array.isArray(aiAnalysis.problems) ? aiAnalysis.problems : [];
  const opportunities = Array.isArray(aiAnalysis.opportunities) ? aiAnalysis.opportunities : [];

  return [
    ...problems.map((p) => toInterpretationItem('problem', p)),
    ...opportunities.map((o) => toInterpretationItem('opportunity', o)),
  ].filter((item) => item !== null);
}

// ---------------------------------------------------------------------
// 3. Service match
// ---------------------------------------------------------------------

const CONFIDENCE_HIGH_THRESHOLD = 70;
const CONFIDENCE_MEDIUM_THRESHOLD = 40;

/**
 * Buckets ai_analysis.confidence (0-100 integer,
 * migrations/004_ai_opportunity_analysis.sql) into the high/medium/low
 * vocabulary the Phase 19 Part 1 spec asks for. This bucketing applies
 * ONLY to the AI interpretation/service match -- never to a verified
 * observation, which has no confidence at all (it's either measured or
 * it isn't).
 *
 * @param {number|null} confidence
 * @returns {'high'|'medium'|'low'|null}
 */
function bucketConfidence(confidence) {
  if (confidence === null || confidence === undefined) return null;
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (confidence >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * @param {object|null} aiAnalysis - the latest COMPLETED ai_analysis row, or null
 * @returns {{service: string|null, reason: string|null, confidence: 'high'|'medium'|'low'|null}|null}
 */
function buildServiceMatch(aiAnalysis) {
  if (!aiAnalysis) return null;

  const hasService = Boolean(aiAnalysis.recommended_service);
  return {
    service: aiAnalysis.recommended_service || null,
    reason: hasService
      ? aiAnalysis.reasoning || null
      : aiAnalysis.reasoning ||
        'The verified evidence does not clearly support recommending a specific Alvin Solutions service.',
    confidence: bucketConfidence(aiAnalysis.confidence),
  };
}

/**
 * @param {object|null} aiAnalysis
 * @returns {string|null}
 */
function buildRelevanceSummary(aiAnalysis) {
  if (!aiAnalysis) return null;
  return aiAnalysis.sales_angle || aiAnalysis.summary || null;
}

// ---------------------------------------------------------------------
// 4. Orchestration
// ---------------------------------------------------------------------

/**
 * Full Phase 19 Part 1 read for one lead. Reuses
 * leadDetailService.getLeadDetail for every DB read (same NotFoundError
 * / ValidationError semantics as GET /api/leads/:id -- an invalid or
 * missing lead id fails exactly the same way here) and never issues a
 * query of its own.
 *
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @returns {Promise<{
 *   lead_id: string,
 *   business_id: string,
 *   has_analysis: boolean,
 *   verified_observations: Array<{fact: string, source: string}>,
 *   ai_interpretation: Array<{type: string, interpretation: string, service: string|null, evidence: Array<object>}>,
 *   service_match: {service: string|null, reason: string|null, confidence: string|null}|null,
 *   relevance_summary: string|null,
 *   ai_model: string|null,
 *   analyzed_at: string|null,
 * }>}
 * @throws {ValidationError} if leadId isn't a syntactically valid UUID
 * @throws {NotFoundError} if no lead has that id
 */
async function getSalesIntelligence(pool, leadId) {
  const detail = await getLeadDetail(pool, leadId);
  const { lead, business, website_analysis: websiteAnalysis, ai_analysis: aiAnalysis } = detail;

  const snapshot = buildVerifiedInput(business, websiteAnalysis);

  return {
    lead_id: lead.id,
    business_id: business.id,
    has_analysis: Boolean(aiAnalysis),
    verified_observations: buildVerifiedObservations(snapshot),
    ai_interpretation: buildAiInterpretation(aiAnalysis),
    service_match: buildServiceMatch(aiAnalysis),
    relevance_summary: buildRelevanceSummary(aiAnalysis),
    ai_model: aiAnalysis ? aiAnalysis.ai_model : null,
    analyzed_at: aiAnalysis ? aiAnalysis.created_at : null,
  };
}

module.exports = {
  NotFoundError,
  ValidationError,
  OBSERVATION_FIELD_DEFS,
  buildVerifiedObservations,
  buildAiInterpretation,
  bucketConfidence,
  buildServiceMatch,
  buildRelevanceSummary,
  getSalesIntelligence,
};
