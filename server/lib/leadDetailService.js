/**
 * Orchestrates GET /api/leads/:id and PATCH /api/leads/:id/pipeline
 * (Phase 13A).
 *
 * Deliberately decoupled from Express, mirroring
 * leadScoringService.js / websiteAnalysisService.js /
 * aiOpportunityAnalysisService.js: server/routes/leads.js is a thin
 * HTTP wrapper around what's exported here.
 *
 * This is a READ-ONLY module with respect to analysis data: it never
 * calls Gemini/OpenAI/PageSpeed/Google, never recalculates a lead
 * score, and never generates notes. The only write this module
 * performs is persisting a user-chosen sales_pipeline.stage value via
 * updatePipelineStage -- everything else is assembled from rows
 * already sitting in Neon (businesses, website_analysis, ai_analysis,
 * leads, sales_pipeline).
 *
 * IMPORTANT: a lead's id (leads.id) is NOT the same as its business id
 * (leads.business_id) -- every lookup below goes through leads.id
 * first, then follows the leads.business_id relationship to load the
 * associated business/website_analysis/ai_analysis rows. Nothing here
 * ever queries businesses directly by the lead id.
 */

'use strict';

const { isValidUuid } = require('./websiteCheckService');
const { loadContacts, buildContactsSummary } = require('./contactService');

/** Thrown when a lead id doesn't match any row. */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown for a malformed request (bad UUID, invalid pipeline stage). */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Matches the sales_pipeline.stage CHECK constraint added in
 * migrations/006_pipeline_stage_realignment.sql. Keep in sync with
 * that migration.
 */
const PIPELINE_STAGES = Object.freeze([
  'new',
  'researched',
  'contacted',
  'responded',
  'meeting',
  'proposal',
  'won',
  'lost',
]);

// ---------------------------------------------------------------------
// 1. Load verified data from Neon
// ---------------------------------------------------------------------

/**
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @returns {Promise<object|null>} the raw `leads` row, or null
 */
async function loadLeadById(pool, leadId) {
  const { rows } = await pool.query(
    `
      SELECT
        id, business_id, lead_score, priority, lead_status,
        estimated_opportunity, sales_notes, scoring_factors, scored_at,
        created_at, updated_at
      FROM leads
      WHERE id = $1
    `,
    [leadId]
  );
  return rows[0] || null;
}

/**
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>} the full `businesses` row, or null
 */
async function loadBusinessById(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT
        id, external_place_id, name, category, phone, email, address,
        city, country, latitude, longitude, google_maps_url,
        google_rating, google_review_count, website_url,
        website_status, website_checked_at, created_at, updated_at
      FROM businesses
      WHERE id = $1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * The latest COMPLETED website analysis for a business, or null. A
 * 'failed'/'blocked'/'timeout'/'rate_limited'/'unavailable' attempt is
 * never returned here -- the lead detail page only ever shows a
 * genuinely completed analysis, exactly like
 * leadScoringService.loadLatestCompletedWebsiteAnalysis.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>}
 */
async function loadLatestCompletedWebsiteAnalysis(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT
        id, business_id, analyzed_url, analyzed_at, performance_score,
        accessibility_score, seo_score, best_practices_score,
        mobile_indicator, https_enabled, page_title, meta_description,
        viewport_present, http_status, response_time_ms,
        analysis_status, created_at
      FROM website_analysis
      WHERE business_id = $1 AND analysis_status = 'completed'
      ORDER BY analyzed_at DESC
      LIMIT 1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * The latest COMPLETED AI opportunity analysis for a business, or
 * null. This is a READ of whatever is already stored -- no AI call is
 * ever made here (see the module docstring).
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<object|null>}
 */
async function loadLatestCompletedAiAnalysis(pool, businessId) {
  const { rows } = await pool.query(
    `
      SELECT
        id, business_id, summary, problems, opportunities,
        recommended_service, reasoning, sales_angle, confidence,
        ai_model, created_at
      FROM ai_analysis
      WHERE business_id = $1 AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * The lead's current pipeline row, if one has ever been persisted.
 *
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @returns {Promise<object|null>}
 */
async function loadPipelineByLeadId(pool, leadId) {
  const { rows } = await pool.query(
    `
      SELECT
        id, lead_id, stage, contacted_at, response_at, meeting_at,
        proposal_at, won_at, lost_at, notes, created_at, updated_at
      FROM sales_pipeline
      WHERE lead_id = $1
    `,
    [leadId]
  );
  return rows[0] || null;
}

/**
 * A lead that has never had its pipeline stage touched has no
 * sales_pipeline row yet -- this is not an error or a missing value,
 * it just means the lead is still at the schema's own default stage
 * ('new'). Returning a virtual, unpersisted row here (rather than
 * null) lets the detail page always render a pipeline section without
 * writing to the database on a GET. The row is only ever actually
 * persisted the first time updatePipelineStage is called.
 *
 * @param {string} leadId
 * @returns {object}
 */
function virtualDefaultPipeline(leadId) {
  return {
    id: null,
    lead_id: leadId,
    stage: 'new',
    contacted_at: null,
    response_at: null,
    meeting_at: null,
    proposal_at: null,
    won_at: null,
    lost_at: null,
    notes: null,
    created_at: null,
    updated_at: null,
  };
}

// ---------------------------------------------------------------------
// 2. GET /api/leads/:id
// ---------------------------------------------------------------------

/**
 * Full Phase 13A orchestration for one lead:
 *   1. load the lead itself (by leads.id -- NOT business id)
 *   2. follow lead.business_id to load the business
 *   3. load the business's latest COMPLETED website analysis, if any
 *   4. load the business's latest COMPLETED AI analysis, if any
 *   5. load (or virtually default) the lead's pipeline stage
 *   6. load the business's contacts (best-effort; see contactService.js)
 *   7. assemble the response
 *
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @returns {Promise<{
 *   lead: object,
 *   business: object,
 *   website_analysis: object|null,
 *   ai_analysis: object|null,
 *   scoring: { lead_score: number|null, priority: string, scoring_factors: Array<object>|null, scored_at: string|null },
 *   pipeline: object,
 * }>}
 * @throws {ValidationError} if leadId isn't a syntactically valid UUID
 * @throws {NotFoundError} if no lead has that id
 */
async function getLeadDetail(pool, leadId) {
  if (!isValidUuid(leadId)) {
    throw new ValidationError('leadId must be a valid UUID.');
  }

  const lead = await loadLeadById(pool, leadId);
  if (!lead) {
    throw new NotFoundError(`No lead found with id ${leadId}`);
  }

  // lead.business_id is a NOT NULL FK (migrations/001_init_schema.sql),
  // so this should always resolve -- but never assume; a missing
  // business is treated as a genuine NotFoundError rather than a crash.
  const business = await loadBusinessById(pool, lead.business_id);
  if (!business) {
    throw new NotFoundError(`Lead ${leadId} references a business that no longer exists.`);
  }

  const [websiteAnalysis, aiAnalysis, pipeline, loadedContacts] = await Promise.all([
    loadLatestCompletedWebsiteAnalysis(pool, lead.business_id),
    loadLatestCompletedAiAnalysis(pool, lead.business_id),
    loadPipelineByLeadId(pool, leadId),
    // Best-effort: never rejects (an unmigrated database just yields no contacts).
    loadContacts(pool, lead.business_id),
  ]);

  return {
    lead,
    business,
    website_analysis: websiteAnalysis,
    ai_analysis: aiAnalysis,
    scoring: {
      lead_score: lead.lead_score,
      priority: lead.priority,
      scoring_factors: lead.scoring_factors,
      scored_at: lead.scored_at,
    },
    pipeline: pipeline || virtualDefaultPipeline(leadId),
    contacts: buildContactsSummary(business, loadedContacts),
  };
}

// ---------------------------------------------------------------------
// 3. PATCH /api/leads/:id/pipeline
// ---------------------------------------------------------------------

/**
 * Validates a stage value against the vocabulary in
 * migrations/006_pipeline_stage_realignment.sql.
 *
 * @param {unknown} value
 * @returns {string} the validated stage
 * @throws {ValidationError}
 */
function validateStage(value) {
  if (typeof value !== 'string' || !PIPELINE_STAGES.includes(value)) {
    throw new ValidationError(
      `"stage" must be one of: ${PIPELINE_STAGES.join(', ')}.`
    );
  }
  return value;
}

/**
 * Deterministically (re)sets ONE lead's pipeline stage. This is the
 * ONLY write this module performs, and it only ever writes a value the
 * caller explicitly chose -- never something inferred from AI
 * analysis, website analysis, or lead score. Persists via
 * INSERT ... ON CONFLICT (lead_id) DO UPDATE against the unique
 * constraint added in migrations/006_pipeline_stage_realignment.sql,
 * so a lead's first stage change creates its sales_pipeline row and
 * every later change updates that same row in place.
 *
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @param {unknown} stage
 * @returns {Promise<object>} the persisted sales_pipeline row
 * @throws {ValidationError} if leadId isn't a valid UUID or stage is invalid
 * @throws {NotFoundError} if no lead has that id
 */
async function updatePipelineStage(pool, leadId, stage) {
  if (!isValidUuid(leadId)) {
    throw new ValidationError('leadId must be a valid UUID.');
  }
  const validStage = validateStage(stage);

  const lead = await loadLeadById(pool, leadId);
  if (!lead) {
    throw new NotFoundError(`No lead found with id ${leadId}`);
  }

  const { rows } = await pool.query(
    `
      INSERT INTO sales_pipeline (lead_id, stage)
      VALUES ($1, $2)
      ON CONFLICT (lead_id) DO UPDATE
        SET stage = EXCLUDED.stage
      RETURNING
        id, lead_id, stage, contacted_at, response_at, meeting_at,
        proposal_at, won_at, lost_at, notes, created_at, updated_at
    `,
    [leadId, validStage]
  );

  return rows[0];
}

// ---------------------------------------------------------------------
// 4. PATCH /api/leads/:id/notes
// ---------------------------------------------------------------------

/**
 * Validates a sales_notes value. Accepted: a string (including empty,
 * which is normalized to null so "cleared" notes read back as null
 * rather than an empty string) or null/undefined (also normalized to
 * null). Anything else (a number, an object, an array, a boolean) is
 * rejected -- this is a free-text column, but it must still be text.
 *
 * @param {unknown} value
 * @returns {string|null}
 * @throws {ValidationError}
 */
function validateSalesNotes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('"sales_notes" must be a string or null.');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/**
 * Deterministically (re)sets ONE lead's sales_notes. This is the ONLY
 * write this function performs -- it never touches lead_score,
 * priority, scoring_factors, pipeline stage, or any analysis table.
 * Mirrors updatePipelineStage's shape: validate id, validate the
 * payload, confirm the lead exists, then persist exactly the value the
 * caller supplied.
 *
 * @param {{query: Function}} pool
 * @param {string} leadId
 * @param {unknown} notes
 * @returns {Promise<object>} the persisted `leads` row (same column set as loadLeadById)
 * @throws {ValidationError} if leadId isn't a valid UUID or notes isn't a string/null
 * @throws {NotFoundError} if no lead has that id
 */
async function updateSalesNotes(pool, leadId, notes) {
  if (!isValidUuid(leadId)) {
    throw new ValidationError('leadId must be a valid UUID.');
  }
  const validNotes = validateSalesNotes(notes);

  const lead = await loadLeadById(pool, leadId);
  if (!lead) {
    throw new NotFoundError(`No lead found with id ${leadId}`);
  }

  const { rows } = await pool.query(
    `
      UPDATE leads
      SET sales_notes = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING
        id, business_id, lead_score, priority, lead_status,
        estimated_opportunity, sales_notes, scoring_factors, scored_at,
        created_at, updated_at
    `,
    [leadId, validNotes]
  );

  return rows[0];
}

module.exports = {
  NotFoundError,
  ValidationError,
  PIPELINE_STAGES,
  loadLeadById,
  loadBusinessById,
  loadLatestCompletedWebsiteAnalysis,
  loadLatestCompletedAiAnalysis,
  loadPipelineByLeadId,
  virtualDefaultPipeline,
  getLeadDetail,
  validateStage,
  updatePipelineStage,
  validateSalesNotes,
  updateSalesNotes,
};
