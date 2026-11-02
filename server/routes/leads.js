const express = require('express');
const pool = require('../db');
const {
  NotFoundError,
  ValidationError,
  getLeadDetail,
  updatePipelineStage,
  updateSalesNotes,
} = require('../lib/leadDetailService');
const { getSalesIntelligence } = require('../lib/salesIntelligenceService');
const { getLeadsExportCsv } = require('../lib/leadExportService');
const { listLeads } = require('../lib/leadListService');

const router = express.Router();

/**
 * GET /api/leads
 *
 * Every lead joined with its business (name/category/location) and,
 * where one exists, the most recently generated recommended_service
 * from ai_analysis. Returns the full read-only set — LeadsTable
 * already implements search, priority/status filtering, sorting, and
 * pagination client-side (see frontend/src/components/leads/LeadsTable.tsx),
 * so this endpoint intentionally mirrors that contract rather than
 * duplicating query params for it. Each row also carries has_phone /
 * has_email / has_social / has_whatsapp flags (see leadListService.js).
 */
router.get('/', async (req, res, next) => {
  try {
    res.json(await listLeads(pool));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/export.csv
 *
 * Phase 22 Part 1. Downloadable CSV of every lead/business currently
 * in Neon -- Business, Phone, Category, Location, Website, Website
 * Status, Lead Score, Priority, Recommended Service, then (contacts
 * update) Email and WhatsApp / Social, in that order.
 * No pagination; no fake/demo rows. Recommended Service reuses the
 * same "latest COMPLETED ai_analysis" definition Phase 19 Sales
 * Intelligence is built on (see server/lib/leadExportService.js) --
 * an empty field, not an invented value, whenever no such analysis
 * exists yet.
 *
 * Registered BEFORE GET /:id below so "export.csv" is never captured
 * by the :id param (it isn't a valid lead UUID anyway, but the route
 * order matters regardless of that validation).
 */
router.get('/export.csv', async (req, res, next) => {
  try {
    const csv = await getLeadsExportCsv(pool, { includeContacts: true });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="alvin-leads.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/:id
 *
 * Phase 13A. Full lead detail: the lead itself, its business, the
 * business's latest COMPLETED website analysis (if any), its latest
 * COMPLETED AI opportunity analysis (if any), the Phase 12 scoring
 * already stored on the lead, and the lead's current pipeline stage.
 *
 * IMPORTANT: :id is the lead's own id (leads.id), NOT a business id --
 * see server/lib/leadDetailService.js. This is a pure READ: no AI call,
 * no PageSpeed call, no recalculated score. Everything returned is
 * either already sitting in Neon or, for a lead whose pipeline has
 * never been touched, the schema's own 'new' default (never written
 * to the database by this GET).
 *
 * Also returns `contacts` (see server/lib/contactService.js): the
 * Google phone (+ tel / "try WhatsApp" links), contacts found on the
 * business's website with source_url/found_at, and -- for a business
 * with no website -- Google/Instagram search helper links.
 *
 * Returns: { lead, business, website_analysis, ai_analysis, scoring, pipeline, contacts }
 */
router.get('/:id', async (req, res, next) => {
  const { id } = req.params;

  try {
    const detail = await getLeadDetail(pool, id);
    res.json(detail);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    next(err);
  }
});

/**
 * GET /api/leads/:id/intelligence
 *
 * Phase 19 Part 1. Structured Sales Intelligence for one lead --
 * read-only, same :id/error semantics as GET /api/leads/:id above
 * (see server/lib/salesIntelligenceService.js). Never calls Gemini,
 * PageSpeed, or Google -- it is a pure transformation of data
 * GET /api/leads/:id already loads, and it always keeps three things
 * clearly separate in the response:
 *
 *   - verified_observations: deterministic facts from businesses /
 *     website_analysis (the exact snapshot already sent to Gemini)
 *   - ai_interpretation: the AI's already-anti-hallucination-filtered
 *     problems/opportunities -- NEVER presented as verified fact
 *   - service_match: a potential Alvin Solutions service recommendation
 *     (or null, with a reason, if the evidence doesn't support one)
 *
 * Returns: { lead_id, business_id, has_analysis, verified_observations,
 * ai_interpretation, service_match, relevance_summary, ai_model, analyzed_at }
 */
router.get('/:id/intelligence', async (req, res, next) => {
  const { id } = req.params;

  try {
    const intelligence = await getSalesIntelligence(pool, id);
    res.json(intelligence);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    next(err);
  }
});

/**
 * PATCH /api/leads/:id/pipeline
 *
 * Phase 13A. Body: { stage }. Sets the lead's sales pipeline stage to
 * exactly the value the caller supplied -- validated against the
 * fixed vocabulary in migrations/006_pipeline_stage_realignment.sql
 * ('new' | 'researched' | 'contacted' | 'responded' | 'meeting' |
 * 'proposal' | 'won' | 'lost') and rejected otherwise. Stage changes
 * are ALWAYS user-driven: this endpoint never reads AI analysis,
 * website analysis, or lead score to decide or override the value
 * given in the request body.
 *
 * Returns the persisted sales_pipeline row.
 */
router.patch('/:id/pipeline', async (req, res, next) => {
  const { id } = req.params;
  const { stage } = req.body || {};

  try {
    const pipeline = await updatePipelineStage(pool, id, stage);
    res.json(pipeline);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * PATCH /api/leads/:id/notes
 *
 * Phase 13B2. Body: { sales_notes }. Sets the lead's free-text
 * sales_notes to exactly the value the caller supplied (a string, or
 * null/empty to clear it). Never derives notes from AI analysis or
 * any other source -- this is a plain user-driven text field, exactly
 * like the pipeline stage endpoint above.
 *
 * Returns the persisted `leads` row.
 */
router.patch('/:id/notes', async (req, res, next) => {
  const { id } = req.params;
  const { sales_notes } = req.body || {};

  try {
    const lead = await updateSalesNotes(pool, id, sales_notes);
    res.json(lead);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
