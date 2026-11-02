const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotFoundError,
  ValidationError,
  PIPELINE_STAGES,
  getLeadDetail,
  updatePipelineStage,
  virtualDefaultPipeline,
  updateSalesNotes,
} = require('../leadDetailService');

/**
 * A minimal fake Postgres pool understanding only the exact queries
 * leadDetailService.js issues. Deliberately does NOT touch a real
 * database -- matches the pattern already used in
 * leadScoringService.test.js / websiteCheckService.test.js.
 */
function makeFakePool({
  leads = [],
  businesses = [],
  websiteAnalyses = [],
  aiAnalyses = [],
  pipelines = [],
} = {}) {
  const leadRows = new Map(leads.map((l) => [l.id, { ...l }]));
  const businessRows = new Map(businesses.map((b) => [b.id, { ...b }]));
  const websiteAnalysisRows = [...websiteAnalyses];
  const aiAnalysisRows = [...aiAnalyses];
  const pipelineRows = new Map(pipelines.map((p) => [p.lead_id, { ...p }]));
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT id, business_id, lead_score, priority, lead_status, estimated_opportunity, sales_notes, scoring_factors, scored_at, created_at, updated_at FROM leads')) {
      const row = leadRows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith('SELECT id, external_place_id, name, category, phone, email, address, city, country, latitude, longitude, google_maps_url, google_rating, google_review_count, website_url, website_status, website_checked_at, created_at, updated_at FROM businesses')) {
      const row = businessRows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith('SELECT id, business_id, analyzed_url, analyzed_at, performance_score, accessibility_score, seo_score, best_practices_score, mobile_indicator, https_enabled, page_title, meta_description, viewport_present, http_status, response_time_ms, analysis_status, created_at FROM website_analysis')) {
      const matches = websiteAnalysisRows
        .filter((a) => a.business_id === params[0] && a.analysis_status === 'completed')
        .sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));
      return { rows: matches.length ? [{ ...matches[0] }] : [] };
    }

    if (s.startsWith('SELECT id, business_id, summary, problems, opportunities, recommended_service, reasoning, sales_angle, confidence, ai_model, created_at FROM ai_analysis')) {
      const matches = aiAnalysisRows
        .filter((a) => a.business_id === params[0] && a.status === 'completed')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: matches.length ? [{ ...matches[0] }] : [] };
    }

    if (s.startsWith('SELECT id, lead_id, stage, contacted_at, response_at, meeting_at, proposal_at, won_at, lost_at, notes, created_at, updated_at FROM sales_pipeline WHERE lead_id')) {
      const row = pipelineRows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith('INSERT INTO sales_pipeline')) {
      const [leadId, stage] = params;
      const existing = pipelineRows.get(leadId) || {
        id: `pipeline-${leadId}`,
        lead_id: leadId,
        contacted_at: null,
        response_at: null,
        meeting_at: null,
        proposal_at: null,
        won_at: null,
        lost_at: null,
        notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
      };
      const updated = { ...existing, lead_id: leadId, stage, updated_at: new Date().toISOString() };
      pipelineRows.set(leadId, updated);
      return { rows: [{ ...updated }] };
    }

    if (s.startsWith('UPDATE leads SET sales_notes = $2, updated_at = NOW() WHERE id = $1')) {
      const [leadId, notes] = params;
      const existing = leadRows.get(leadId);
      if (!existing) return { rows: [] };
      const updated = { ...existing, sales_notes: notes, updated_at: new Date().toISOString() };
      leadRows.set(leadId, updated);
      return { rows: [{ ...updated }] };
    }

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls, _pipelineRows: pipelineRows, _leadRows: leadRows };
}

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const BUSINESS_ID = '22222222-2222-4222-8222-222222222222';

function lead(overrides) {
  return {
    id: LEAD_ID,
    business_id: BUSINESS_ID,
    lead_score: 53,
    priority: 'high',
    lead_status: 'new',
    estimated_opportunity: null,
    sales_notes: null,
    scoring_factors: [{ code: 'no_website', label: 'No website', points: 25, reason: 'x' }],
    scored_at: '2026-01-05T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

function business(overrides) {
  return {
    id: BUSINESS_ID,
    external_place_id: 'places-123',
    name: 'Peter Amor',
    category: 'Restaurant',
    phone: '555-0100',
    email: null,
    address: '123 Main St',
    city: 'Springfield',
    country: 'US',
    latitude: null,
    longitude: null,
    google_maps_url: 'https://maps.google.com/?cid=1',
    google_rating: '4.5',
    google_review_count: 120,
    website_url: 'https://example.com',
    website_status: 'reachable',
    website_checked_at: '2026-01-02T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// getLeadDetail: validation
// ---------------------------------------------------------------------

test('getLeadDetail: syntactically invalid id throws ValidationError before any query', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => getLeadDetail(pool, 'not-a-uuid'), ValidationError);
  assert.equal(pool.calls.length, 0, 'no query should be issued for a malformed id');
});

test('getLeadDetail: nonexistent lead throws NotFoundError', async () => {
  const pool = makeFakePool({});
  await assert.rejects(
    () => getLeadDetail(pool, '99999999-9999-4999-8999-999999999999'),
    (err) => {
      assert.ok(err instanceof NotFoundError);
      return true;
    }
  );
});

test('getLeadDetail: lead whose business row is missing throws NotFoundError rather than crashing', async () => {
  const pool = makeFakePool({ leads: [lead()] }); // no matching business row
  await assert.rejects(() => getLeadDetail(pool, LEAD_ID), NotFoundError);
});

// ---------------------------------------------------------------------
// getLeadDetail: happy path assembly
// ---------------------------------------------------------------------

test('getLeadDetail: assembles lead + business + website_analysis + ai_analysis + scoring + pipeline', async () => {
  const pool = makeFakePool({
    leads: [lead()],
    businesses: [business()],
    websiteAnalyses: [
      {
        id: 'wa-1',
        business_id: BUSINESS_ID,
        analyzed_url: 'https://example.com',
        analyzed_at: '2026-01-03T00:00:00.000Z',
        performance_score: 65,
        accessibility_score: 78,
        seo_score: 92,
        best_practices_score: 80,
        mobile_indicator: 'mobile',
        https_enabled: true,
        page_title: 'Example',
        meta_description: 'desc',
        viewport_present: true,
        http_status: 200,
        response_time_ms: 340,
        analysis_status: 'completed',
        created_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    aiAnalyses: [
      {
        id: 'ai-1',
        business_id: BUSINESS_ID,
        summary: 'Summary',
        problems: ['slow site'],
        opportunities: ['redesign'],
        recommended_service: 'website_redesign',
        reasoning: 'Because',
        sales_angle: 'Angle',
        confidence: 80,
        ai_model: 'gemini-1.5',
        status: 'completed',
        created_at: '2026-01-04T00:00:00.000Z',
      },
    ],
    pipelines: [
      {
        id: 'pipe-1',
        lead_id: LEAD_ID,
        stage: 'contacted',
        contacted_at: '2026-01-06T00:00:00.000Z',
        response_at: null,
        meeting_at: null,
        proposal_at: null,
        won_at: null,
        lost_at: null,
        notes: null,
        created_at: '2026-01-06T00:00:00.000Z',
        updated_at: '2026-01-06T00:00:00.000Z',
      },
    ],
  });

  const detail = await getLeadDetail(pool, LEAD_ID);

  assert.equal(detail.lead.id, LEAD_ID);
  assert.equal(detail.business.id, BUSINESS_ID);
  assert.equal(detail.business.name, 'Peter Amor');
  assert.equal(detail.website_analysis.performance_score, 65);
  assert.equal(detail.ai_analysis.recommended_service, 'website_redesign');
  assert.deepEqual(detail.scoring, {
    lead_score: 53,
    priority: 'high',
    scoring_factors: lead().scoring_factors,
    scored_at: '2026-01-05T00:00:00.000Z',
  });
  assert.equal(detail.pipeline.stage, 'contacted');
});

test('getLeadDetail: missing website_analysis/ai_analysis/pipeline never invents data', async () => {
  const pool = makeFakePool({
    leads: [lead({ lead_score: null, priority: 'medium', scoring_factors: null, scored_at: null })],
    businesses: [business()],
  });

  const detail = await getLeadDetail(pool, LEAD_ID);

  assert.equal(detail.website_analysis, null);
  assert.equal(detail.ai_analysis, null);
  assert.equal(detail.scoring.lead_score, null);
  assert.equal(detail.scoring.scoring_factors, null);
  // No sales_pipeline row exists yet -- a virtual default is returned
  // (stage 'new'), but nothing is written to the database for a GET.
  assert.deepEqual(detail.pipeline, virtualDefaultPipeline(LEAD_ID));
  assert.equal(
    pool.calls.some((c) => c.sql.trim().toUpperCase().startsWith('INSERT')),
    false,
    'GET must never write to the database'
  );
});

test('getLeadDetail: ignores an analysis_status/status that is not "completed"', async () => {
  const pool = makeFakePool({
    leads: [lead()],
    businesses: [business()],
    websiteAnalyses: [
      {
        id: 'wa-failed',
        business_id: BUSINESS_ID,
        analyzed_url: 'https://example.com',
        analyzed_at: '2026-01-09T00:00:00.000Z', // most recent, but failed
        performance_score: 99,
        analysis_status: 'failed',
        created_at: '2026-01-09T00:00:00.000Z',
      },
      {
        id: 'wa-completed',
        business_id: BUSINESS_ID,
        analyzed_url: 'https://example.com',
        analyzed_at: '2026-01-03T00:00:00.000Z',
        performance_score: 65,
        analysis_status: 'completed',
        created_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    aiAnalyses: [
      {
        id: 'ai-failed',
        business_id: BUSINESS_ID,
        recommended_service: 'ecommerce_website',
        status: 'failed',
        created_at: '2026-01-10T00:00:00.000Z',
      },
    ],
  });

  const detail = await getLeadDetail(pool, LEAD_ID);

  assert.equal(detail.website_analysis.id, 'wa-completed');
  assert.equal(detail.ai_analysis, null);
});

// ---------------------------------------------------------------------
// updatePipelineStage
// ---------------------------------------------------------------------

test('PIPELINE_STAGES matches the Phase 13A spec exactly, in order', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'new',
    'researched',
    'contacted',
    'responded',
    'meeting',
    'proposal',
    'won',
    'lost',
  ]);
});

test('updatePipelineStage: valid stage is persisted and returned', async () => {
  const pool = makeFakePool({ leads: [lead()] });

  const result = await updatePipelineStage(pool, LEAD_ID, 'meeting');

  assert.equal(result.stage, 'meeting');
  assert.equal(result.lead_id, LEAD_ID);
  assert.equal(pool._pipelineRows.get(LEAD_ID).stage, 'meeting');
});

test('updatePipelineStage: a second call updates the same row rather than creating a new one', async () => {
  const pool = makeFakePool({ leads: [lead()] });

  await updatePipelineStage(pool, LEAD_ID, 'contacted');
  await updatePipelineStage(pool, LEAD_ID, 'responded');

  assert.equal(pool._pipelineRows.size, 1);
  assert.equal(pool._pipelineRows.get(LEAD_ID).stage, 'responded');
});

test('updatePipelineStage: invalid stage is rejected and never persisted', async () => {
  const pool = makeFakePool({ leads: [lead()] });

  await assert.rejects(() => updatePipelineStage(pool, LEAD_ID, 'negotiation'), ValidationError);
  assert.equal(pool._pipelineRows.has(LEAD_ID), false);
});

test('updatePipelineStage: non-string stage is rejected', async () => {
  const pool = makeFakePool({ leads: [lead()] });
  await assert.rejects(() => updatePipelineStage(pool, LEAD_ID, 42), ValidationError);
});

test('updatePipelineStage: nonexistent lead throws NotFoundError before writing', async () => {
  const pool = makeFakePool({});
  await assert.rejects(
    () => updatePipelineStage(pool, '99999999-9999-4999-8999-999999999999', 'contacted'),
    NotFoundError
  );
  assert.equal(pool._pipelineRows.size, 0);
});

test('updatePipelineStage: syntactically invalid lead id throws ValidationError before any query', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => updatePipelineStage(pool, 'not-a-uuid', 'contacted'), ValidationError);
  assert.equal(pool.calls.length, 0, 'no query should be issued for a malformed id');
});

test('updatePipelineStage: request body cannot smuggle in extra fields -- only (pool, leadId, stage) are read', async () => {
  const pool = makeFakePool({ leads: [lead()] });
  // Simulate a careless caller forwarding a whole forged body as the
  // third argument; updatePipelineStage's signature only reads the
  // `stage` value it was explicitly given, so this either behaves
  // exactly like passing the object itself (fails validation) or is
  // simply ignored -- there is no path for extra fields to reach SQL.
  await assert.rejects(
    () => updatePipelineStage(pool, LEAD_ID, { stage: 'won', lead_score: 100 }),
    ValidationError
  );
});

// ---------------------------------------------------------------------
// updateSalesNotes
// ---------------------------------------------------------------------

test('updateSalesNotes: valid notes are persisted and returned', async () => {
  const pool = makeFakePool({ leads: [lead()] });

  const result = await updateSalesNotes(pool, LEAD_ID, 'Called, left voicemail.');

  assert.equal(result.sales_notes, 'Called, left voicemail.');
  assert.equal(result.id, LEAD_ID);
  assert.equal(pool._leadRows.get(LEAD_ID).sales_notes, 'Called, left voicemail.');
});

test('updateSalesNotes: never touches lead_score, priority, or scoring_factors', async () => {
  const pool = makeFakePool({ leads: [lead({ lead_score: 53, priority: 'high' })] });

  await updateSalesNotes(pool, LEAD_ID, 'New note');

  const updated = pool._leadRows.get(LEAD_ID);
  assert.equal(updated.lead_score, 53);
  assert.equal(updated.priority, 'high');
});

test('updateSalesNotes: empty string is normalized to null', async () => {
  const pool = makeFakePool({ leads: [lead({ sales_notes: 'old note' })] });

  const result = await updateSalesNotes(pool, LEAD_ID, '   ');

  assert.equal(result.sales_notes, null);
});

test('updateSalesNotes: null clears existing notes', async () => {
  const pool = makeFakePool({ leads: [lead({ sales_notes: 'old note' })] });

  const result = await updateSalesNotes(pool, LEAD_ID, null);

  assert.equal(result.sales_notes, null);
});

test('updateSalesNotes: non-string, non-null value is rejected and never persisted', async () => {
  const pool = makeFakePool({ leads: [lead({ sales_notes: 'kept' })] });

  await assert.rejects(() => updateSalesNotes(pool, LEAD_ID, 42), ValidationError);
  assert.equal(pool._leadRows.get(LEAD_ID).sales_notes, 'kept');
});

test('updateSalesNotes: nonexistent lead throws NotFoundError before writing', async () => {
  const pool = makeFakePool({});
  await assert.rejects(
    () => updateSalesNotes(pool, '99999999-9999-4999-8999-999999999999', 'hello'),
    NotFoundError
  );
});

test('updateSalesNotes: syntactically invalid lead id throws ValidationError before any query', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => updateSalesNotes(pool, 'not-a-uuid', 'hello'), ValidationError);
  assert.equal(pool.calls.length, 0, 'no query should be issued for a malformed id');
});
