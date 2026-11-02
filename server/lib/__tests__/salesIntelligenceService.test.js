const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotFoundError,
  ValidationError,
  buildVerifiedObservations,
  buildAiInterpretation,
  bucketConfidence,
  buildServiceMatch,
  buildRelevanceSummary,
  getSalesIntelligence,
} = require('../salesIntelligenceService');
const { buildVerifiedInput } = require('../aiOpportunityAnalysis');

/**
 * A minimal fake Postgres pool understanding only the exact queries
 * leadDetailService.js issues (getSalesIntelligence delegates all
 * reads to leadDetailService.getLeadDetail and issues no queries of
 * its own). Mirrors the fake pool in leadDetailService.test.js.
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

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls };
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
    scoring_factors: null,
    scored_at: null,
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
    website_url: null,
    website_status: 'no_website',
    website_checked_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function websiteAnalysisRow(overrides) {
  return {
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
    ...overrides,
  };
}

function aiAnalysisRow(overrides) {
  return {
    id: 'ai-1',
    business_id: BUSINESS_ID,
    summary: 'The business has no website.',
    problems: [
      {
        title: 'No website',
        description: 'This business has no website on file.',
        evidence: [{ field: 'business_has_website', value: false }],
      },
    ],
    opportunities: [
      {
        title: 'Build a website',
        description: 'A new website could help this business be found online.',
        service: 'new_website',
        evidence: [{ field: 'business_has_website', value: false }],
      },
    ],
    recommended_service: 'new_website',
    reasoning: 'No website is on file, so a new website is the clearest fit.',
    sales_angle: 'They are invisible online -- easy first conversation.',
    confidence: 82,
    ai_model: 'gemini-3.8-flash',
    status: 'completed',
    created_at: '2026-01-04T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// buildVerifiedObservations
// ---------------------------------------------------------------------

test('buildVerifiedObservations: includes always-fields even when falsy/null-state, skips other nulls', () => {
  const snapshot = buildVerifiedInput(business(), null);
  const observations = buildVerifiedObservations(snapshot);

  // Always-included fields are present regardless of value.
  assert.ok(observations.some((o) => o.fact === 'No phone number is on file.' || o.fact === 'A phone number is on file.'));
  assert.ok(observations.some((o) => o.fact.includes('Website status is "no_website"')));
  assert.ok(observations.some((o) => o.fact === 'Business has no website on file.'));

  // Fields that are null in the snapshot (no website_analysis row, no website_url) must not appear.
  assert.ok(!observations.some((o) => o.fact.startsWith('Website URL is')));
  assert.ok(!observations.some((o) => o.fact.startsWith('PageSpeed')));
});

test('buildVerifiedObservations: only ever uses "business_record" or "website_analyzer" as source', () => {
  const snapshot = buildVerifiedInput(business({ website_url: 'https://x.com', website_status: 'active' }), websiteAnalysisRow());
  const observations = buildVerifiedObservations(snapshot);
  assert.ok(observations.length > 0);
  for (const o of observations) {
    assert.ok(['business_record', 'website_analyzer'].includes(o.source));
  }
});

test('buildVerifiedObservations: website_analyzer facts only appear when a website_analysis row exists', () => {
  const withAnalysis = buildVerifiedObservations(buildVerifiedInput(business(), websiteAnalysisRow()));
  const withoutAnalysis = buildVerifiedObservations(buildVerifiedInput(business(), null));

  assert.ok(withAnalysis.some((o) => o.source === 'website_analyzer'));
  assert.ok(!withoutAnalysis.some((o) => o.source === 'website_analyzer'));
});

test('buildVerifiedObservations: never invents booking/WhatsApp/contact-form/social-link facts', () => {
  const observations = buildVerifiedObservations(buildVerifiedInput(business(), websiteAnalysisRow()));
  const text = JSON.stringify(observations).toLowerCase();
  assert.ok(!text.includes('booking'));
  assert.ok(!text.includes('whatsapp'));
  assert.ok(!text.includes('contact form'));
  assert.ok(!text.includes('social'));
});

// ---------------------------------------------------------------------
// buildAiInterpretation
// ---------------------------------------------------------------------

test('buildAiInterpretation: null ai_analysis produces an empty array', () => {
  assert.deepEqual(buildAiInterpretation(null), []);
});

test('buildAiInterpretation: labels problems and opportunities distinctly and carries evidence through', () => {
  const items = buildAiInterpretation(aiAnalysisRow());
  assert.equal(items.length, 2);

  const problem = items.find((i) => i.type === 'problem');
  assert.ok(problem);
  assert.equal(problem.service, null);
  assert.ok(problem.interpretation.includes('No website'));
  assert.deepEqual(problem.evidence, [{ field: 'business_has_website', value: false }]);

  const opportunity = items.find((i) => i.type === 'opportunity');
  assert.ok(opportunity);
  assert.equal(opportunity.service, 'new_website');
  assert.ok(opportunity.interpretation.includes('Build a website'));
});

// Regression: the Sales Intelligence panel showed "Possible problem /
// undefined: undefined". buildAiInterpretation interpolated
// `${p.title}: ${p.description}` unconditionally, so any stored
// entry that was not a { title, description } object (e.g. a legacy
// plain string, which the lead-detail AI-analysis panel already
// renders) came out as the literal text "undefined: undefined".
test('buildAiInterpretation: legacy plain-string entries use the stored text, never "undefined: undefined"', () => {
  const items = buildAiInterpretation({
    problems: ['No online ordering', 'Slow mobile load time'],
    opportunities: ['Add e-commerce'],
  });

  assert.deepEqual(items, [
    { type: 'problem', interpretation: 'No online ordering', service: null, evidence: [] },
    { type: 'problem', interpretation: 'Slow mobile load time', service: null, evidence: [] },
    { type: 'opportunity', interpretation: 'Add e-commerce', service: null, evidence: [] },
  ]);
});

test('buildAiInterpretation: object entries still render as "title: description" with evidence and service carried through', () => {
  const items = buildAiInterpretation(aiAnalysisRow());
  assert.equal(items[0].interpretation, 'No website: This business has no website on file.');
  assert.equal(items[1].interpretation, 'Build a website: A new website could help this business be found online.');
  assert.equal(items[1].service, 'new_website');
  assert.deepEqual(items[1].evidence, [{ field: 'business_has_website', value: false }]);
});

test('buildAiInterpretation: an object with only a title or only a description uses just that text', () => {
  const items = buildAiInterpretation({
    problems: [{ title: 'Only a title' }, { description: 'Only a description' }],
    opportunities: [],
  });
  assert.deepEqual(
    items.map((i) => i.interpretation),
    ['Only a title', 'Only a description']
  );
});

test('buildAiInterpretation: entries with no usable text are skipped rather than rendered as "undefined"', () => {
  const items = buildAiInterpretation({
    problems: [{}, { title: '  ', description: '' }, null, 42, '', '   ', { unrelated: 'x' }],
    opportunities: [{ service: 'new_website', evidence: [] }, undefined],
  });
  assert.deepEqual(items, []);
});

test('buildAiInterpretation: no interpretation string ever contains "undefined" or "null", whatever shape is stored', () => {
  const items = buildAiInterpretation({
    problems: ['legacy', { title: 'T', description: 'D' }, { title: 'T only' }, {}, null],
    opportunities: ['legacy opp', { title: 'T', description: 'D', service: 'new_website' }, {}, undefined],
  });
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(typeof item.interpretation, 'string');
    assert.ok(!/undefined|null/.test(item.interpretation), item.interpretation);
  }
});

// ---------------------------------------------------------------------
// bucketConfidence / buildServiceMatch
// ---------------------------------------------------------------------

test('bucketConfidence: buckets 0-100 into high/medium/low, null passes through', () => {
  assert.equal(bucketConfidence(null), null);
  assert.equal(bucketConfidence(0), 'low');
  assert.equal(bucketConfidence(39), 'low');
  assert.equal(bucketConfidence(40), 'medium');
  assert.equal(bucketConfidence(69), 'medium');
  assert.equal(bucketConfidence(70), 'high');
  assert.equal(bucketConfidence(100), 'high');
});

test('buildServiceMatch: null ai_analysis yields null (no section at all)', () => {
  assert.equal(buildServiceMatch(null), null);
});

test('buildServiceMatch: with a recommended_service, returns service/reason/confidence', () => {
  const match = buildServiceMatch(aiAnalysisRow());
  assert.equal(match.service, 'new_website');
  assert.equal(match.reason, 'No website is on file, so a new website is the clearest fit.');
  assert.equal(match.confidence, 'high');
});

test('buildServiceMatch: no forced recommendation -- null service still returns an explanatory reason, never throws', () => {
  const match = buildServiceMatch(
    aiAnalysisRow({ recommended_service: null, reasoning: null, confidence: 20 })
  );
  assert.equal(match.service, null);
  assert.equal(
    match.reason,
    'The verified evidence does not clearly support recommending a specific Alvin Solutions service.'
  );
  assert.equal(match.confidence, 'low');
});

// ---------------------------------------------------------------------
// buildRelevanceSummary
// ---------------------------------------------------------------------

test('buildRelevanceSummary: prefers sales_angle, falls back to summary, null when no analysis', () => {
  assert.equal(buildRelevanceSummary(null), null);
  assert.equal(buildRelevanceSummary(aiAnalysisRow()), 'They are invisible online -- easy first conversation.');
  assert.equal(
    buildRelevanceSummary(aiAnalysisRow({ sales_angle: null })),
    'The business has no website.'
  );
});

// ---------------------------------------------------------------------
// getSalesIntelligence: validation / not-found (mirrors getLeadDetail)
// ---------------------------------------------------------------------

test('getSalesIntelligence: syntactically invalid id throws ValidationError before any query', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => getSalesIntelligence(pool, 'not-a-uuid'), ValidationError);
  assert.equal(pool.calls.length, 0);
});

test('getSalesIntelligence: nonexistent lead throws NotFoundError', async () => {
  const pool = makeFakePool({});
  await assert.rejects(
    () => getSalesIntelligence(pool, '99999999-9999-4999-8999-999999999999'),
    NotFoundError
  );
});

// ---------------------------------------------------------------------
// getSalesIntelligence: end-to-end assembly
// ---------------------------------------------------------------------

test('getSalesIntelligence: a lead with no website/AI analysis yet returns empty/null sections, not an error', async () => {
  const pool = makeFakePool({ leads: [lead()], businesses: [business()] });
  const result = await getSalesIntelligence(pool, LEAD_ID);

  assert.equal(result.lead_id, LEAD_ID);
  assert.equal(result.business_id, BUSINESS_ID);
  assert.equal(result.has_analysis, false);
  assert.ok(result.verified_observations.length > 0); // still has business-record facts
  assert.deepEqual(result.ai_interpretation, []);
  assert.equal(result.service_match, null);
  assert.equal(result.relevance_summary, null);
  assert.equal(result.ai_model, null);
  assert.equal(result.analyzed_at, null);
});

test('getSalesIntelligence: full assembly keeps verified_observations, ai_interpretation, and service_match separate', async () => {
  const pool = makeFakePool({
    leads: [lead()],
    businesses: [business({ website_url: 'https://example.com', website_status: 'active' })],
    websiteAnalyses: [websiteAnalysisRow()],
    aiAnalyses: [aiAnalysisRow()],
  });

  const result = await getSalesIntelligence(pool, LEAD_ID);

  assert.equal(result.has_analysis, true);
  assert.ok(result.verified_observations.length > 0);
  assert.ok(result.verified_observations.every((o) => typeof o.fact === 'string' && o.fact.length > 0));

  assert.equal(result.ai_interpretation.length, 2);
  assert.ok(result.ai_interpretation.every((i) => i.type === 'problem' || i.type === 'opportunity'));

  assert.deepEqual(result.service_match, {
    service: 'new_website',
    reason: 'No website is on file, so a new website is the clearest fit.',
    confidence: 'high',
  });

  assert.equal(result.relevance_summary, 'They are invisible online -- easy first conversation.');
  assert.equal(result.ai_model, 'gemini-3.8-flash');
  assert.equal(result.analyzed_at, '2026-01-04T00:00:00.000Z');

  // AI interpretation must never leak into verified_observations, and
  // vice versa -- no shared object identity or fact/interpretation text.
  const observationFacts = new Set(result.verified_observations.map((o) => o.fact));
  for (const item of result.ai_interpretation) {
    assert.ok(!observationFacts.has(item.interpretation));
  }
});

test('getSalesIntelligence: legacy plain-string problems/opportunities come through as real text in ai_interpretation', async () => {
  const pool = makeFakePool({
    leads: [lead()],
    businesses: [business()],
    aiAnalyses: [
      aiAnalysisRow({
        problems: ['No online ordering', 'Slow mobile load time', 'No booking system'],
        opportunities: ['Add e-commerce', 'Improve SEO', 'Add WhatsApp ordering'],
      }),
    ],
  });

  const result = await getSalesIntelligence(pool, LEAD_ID);

  assert.deepEqual(
    result.ai_interpretation.map((i) => [i.type, i.interpretation]),
    [
      ['problem', 'No online ordering'],
      ['problem', 'Slow mobile load time'],
      ['problem', 'No booking system'],
      ['opportunity', 'Add e-commerce'],
      ['opportunity', 'Improve SEO'],
      ['opportunity', 'Add WhatsApp ordering'],
    ]
  );
  assert.ok(!JSON.stringify(result).includes('undefined'));
});

test('getSalesIntelligence: business with a website but no completed website_analysis yet still returns business-record facts only', async () => {
  const pool = makeFakePool({
    leads: [lead()],
    businesses: [business({ website_url: 'https://example.com', website_status: 'unknown' })],
  });

  const result = await getSalesIntelligence(pool, LEAD_ID);
  assert.ok(result.verified_observations.some((o) => o.source === 'business_record'));
  assert.ok(!result.verified_observations.some((o) => o.source === 'website_analyzer'));
});
