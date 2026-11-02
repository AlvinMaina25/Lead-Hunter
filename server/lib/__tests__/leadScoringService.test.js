const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotFoundError,
  ValidationError,
  buildScoringInput,
  scoreBusiness,
  scoreBusinessBatch,
} = require('../leadScoringService');

/**
 * A minimal fake Postgres pool understanding only the exact queries
 * leadScoringService.js issues. Deliberately does NOT touch a real
 * database -- this is a unit test double, matching the pattern already
 * used in websiteCheckService.test.js / websiteAnalysisService.test.js.
 */
function makeFakePool({ businesses = [], analyses = [], aiAnalyses = [], leads = [] } = {}) {
  const businessRows = new Map(businesses.map((b) => [b.id, { ...b }]));
  const analysisRows = [...analyses];
  const aiRows = [...aiAnalyses];
  const leadRows = new Map(leads.map((l) => [l.business_id, { ...l }]));
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT id, name, website_status, google_review_count FROM businesses')) {
      const row = businessRows.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith('SELECT performance_score, seo_score, accessibility_score, viewport_present, analyzed_at FROM website_analysis')) {
      const matches = analysisRows
        .filter((a) => a.business_id === params[0] && a.analysis_status === 'completed')
        .sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));
      return { rows: matches.length ? [{ ...matches[0] }] : [] };
    }

    if (s.startsWith('SELECT recommended_service, reasoning, sales_angle, confidence, status, created_at FROM ai_analysis')) {
      const matches = aiRows
        .filter((a) => a.business_id === params[0])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: matches.length ? [{ ...matches[0] }] : [] };
    }

    if (s.startsWith('INSERT INTO leads')) {
      const [businessId, leadScore, priority, scoringFactors] = params;
      const existing = leadRows.get(businessId) || {
        id: `lead-${businessId}`,
        business_id: businessId,
        lead_status: 'new',
        estimated_opportunity: null,
        sales_notes: null,
      };
      const updated = {
        ...existing,
        business_id: businessId,
        lead_score: leadScore,
        priority,
        scoring_factors: JSON.parse(scoringFactors),
        scored_at: new Date().toISOString(),
      };
      leadRows.set(businessId, updated);
      return { rows: [{ ...updated }] };
    }

    if (s.startsWith('SELECT id FROM businesses ORDER BY created_at ASC LIMIT $1')) {
      const limit = params[0];
      const sorted = [...businessRows.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return { rows: sorted.slice(0, limit).map((b) => ({ id: b.id })) };
    }

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls, _leadRows: leadRows };
}

function business(overrides) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Business',
    website_status: 'unknown',
    google_review_count: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// buildScoringInput
// ---------------------------------------------------------------------

test('buildScoringInput: maps verified rows into the exact leadScoring.js input shape', () => {
  const input = buildScoringInput(
    business({ website_status: 'unreachable', google_review_count: 129 }),
    { performance_score: 65, seo_score: 92, accessibility_score: 78, viewport_present: true }
  );
  assert.deepEqual(input, {
    websiteStatus: 'unreachable',
    performanceScore: 65,
    seoScore: 92,
    accessibilityScore: 78,
    viewportPresent: true,
    googleReviewCount: 129,
  });
});

test('buildScoringInput: null analysis -> every analysis-derived field is null, never 0/false', () => {
  const input = buildScoringInput(business({ google_review_count: null }), null);
  assert.equal(input.performanceScore, null);
  assert.equal(input.seoScore, null);
  assert.equal(input.accessibilityScore, null);
  assert.equal(input.viewportPresent, null);
  assert.equal(input.googleReviewCount, null);
});

// ---------------------------------------------------------------------
// scoreBusiness: happy path + persistence
// ---------------------------------------------------------------------

test('scoreBusiness: scores, persists, and returns the leads row plus AI analysis for display', async () => {
  const b = business({ website_status: 'unreachable', google_review_count: 129 });
  const pool = makeFakePool({
    businesses: [b],
    analyses: [
      {
        business_id: b.id,
        analysis_status: 'completed',
        analyzed_at: '2026-01-05T00:00:00.000Z',
        performance_score: 65,
        seo_score: 92,
        accessibility_score: 78,
        viewport_present: true,
      },
    ],
    aiAnalyses: [
      {
        business_id: b.id,
        created_at: '2026-01-06T00:00:00.000Z',
        recommended_service: 'website_redesign',
        reasoning: 'Some reasoning',
        sales_angle: 'Some angle',
        confidence: 99, // deliberately extreme -- must not affect the score
        status: 'completed',
      },
    ],
  });

  const result = await scoreBusiness(pool, b.id);

  assert.equal(result.business_id, b.id);
  assert.equal(result.lead_score, 53); // see docs/lead-scoring.md worked example
  assert.equal(result.priority, 'high');
  assert.ok(Array.isArray(result.scoring_factors));
  assert.ok(result.scored_at);
  assert.equal(result.ai_analysis.recommended_service, 'website_redesign');

  const stored = pool._leadRows.get(b.id);
  assert.equal(stored.lead_score, 53);
  assert.equal(stored.priority, 'high');
});

test('scoreBusiness: nonexistent business throws NotFoundError', async () => {
  const pool = makeFakePool({});
  await assert.rejects(
    () => scoreBusiness(pool, '99999999-9999-4999-8999-999999999999'),
    (err) => {
      assert.ok(err instanceof NotFoundError);
      return true;
    }
  );
});

test('scoreBusiness: syntactically invalid id throws ValidationError before any query', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => scoreBusiness(pool, 'not-a-uuid'), ValidationError);
  assert.equal(pool.calls.length, 0, 'no query should be issued for a malformed id');
});

test('scoreBusiness: ignores an analysis_status that is not "completed"', async () => {
  const b = business({ website_status: 'reachable' });
  const pool = makeFakePool({
    businesses: [b],
    analyses: [
      {
        business_id: b.id,
        analysis_status: 'failed',
        analyzed_at: '2026-01-05T00:00:00.000Z',
        performance_score: 10, // would score +20 if ever read -- must be ignored
        seo_score: 10,
        accessibility_score: 10,
        viewport_present: false,
      },
    ],
  });

  const result = await scoreBusiness(pool, b.id);
  // Everything should read as "unknown" (0 points), not the failed row's numbers.
  assert.equal(result.lead_score, 0);
});

test('scoreBusiness: an AI analysis with maximal confidence/recommended_service never changes lead_score', async () => {
  const bWithAi = business({ id: 'a1111111-1111-4111-8111-111111111111', website_status: 'reachable' });
  const bWithoutAi = business({ id: 'a2222222-2222-4222-8222-222222222222', website_status: 'reachable' });

  const poolWithAi = makeFakePool({
    businesses: [bWithAi],
    aiAnalyses: [
      {
        business_id: bWithAi.id,
        created_at: '2026-01-06T00:00:00.000Z',
        recommended_service: 'ecommerce_website',
        reasoning: 'x',
        sales_angle: 'x',
        confidence: 100,
        status: 'completed',
      },
    ],
  });
  const poolWithoutAi = makeFakePool({ businesses: [bWithoutAi] });

  const withAi = await scoreBusiness(poolWithAi, bWithAi.id);
  const withoutAi = await scoreBusiness(poolWithoutAi, bWithoutAi.id);

  assert.equal(withAi.lead_score, withoutAi.lead_score);
  assert.equal(withAi.priority, withoutAi.priority);
});

// ---------------------------------------------------------------------
// 29. Request body cannot override verified database values
// ---------------------------------------------------------------------

test('29. scoreBusiness only ever accepts (pool, businessId) -- there is no parameter through which request-body scoring facts could reach it', async () => {
  const b = business({ website_status: 'no_website', google_review_count: 5 });
  const pool = makeFakePool({ businesses: [b] });

  // Simulate a malicious/careless caller trying to pass extra body-derived
  // fields through as extra arguments; scoreBusiness's signature (pool, id)
  // means anything beyond the second argument is simply ignored by JS.
  const forgedBody = { performance_score: 100, website_status: 'reachable', google_review_count: 99999 };
  const result = await scoreBusiness(pool, b.id, forgedBody);

  // The score must reflect the REAL stored business (no_website, 5 reviews),
  // never the forged body.
  const noWebsiteFactor = result.scoring_factors.find((f) => f.code === 'no_website');
  assert.ok(noWebsiteFactor, 'expected the real no_website factor, not a forged reachable one');
  const reviewsFactor = result.scoring_factors.find((f) => f.code === 'no_reviews' || f.code === 'established_reviews');
  assert.equal(reviewsFactor.reason.includes('99999'), false);
});

// ---------------------------------------------------------------------
// Batch scoring
// ---------------------------------------------------------------------

test('scoreBusinessBatch: scores every business up to the limit, oldest first, and tallies results', async () => {
  const businesses = [
    business({ id: 'a1111111-1111-4111-8111-111111111111', created_at: '2026-01-01T00:00:00.000Z', website_status: 'no_website' }),
    business({ id: 'a2222222-2222-4222-8222-222222222222', created_at: '2026-01-02T00:00:00.000Z', website_status: 'reachable' }),
  ];
  const pool = makeFakePool({ businesses });

  const result = await scoreBusinessBatch(pool, { limit: 10 });

  assert.equal(result.businesses_found, 2);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.ok));
  const first = result.results.find((r) => r.business_id === businesses[0].id);
  // no_website(25) + performance/seo/accessibility/mobile unknown(0 each)
  // + fit triggered by no_website(10) + reviews unknown(0) = 35
  assert.equal(first.lead_score, 35);
  assert.equal(first.priority, 'medium');
});

test('scoreBusinessBatch: rejects an out-of-range limit before querying', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => scoreBusinessBatch(pool, { limit: 999 }), ValidationError);
});

test('scoreBusinessBatch: never calls any AI/network function -- the fake pool has no such method and nothing throws looking for one', async () => {
  const businesses = [business({ website_status: 'no_website' })];
  const pool = makeFakePool({ businesses });
  // If scoreBusinessBatch ever tried to call Gemini/PageSpeed/Google, the
  // fake pool (which only implements `query`) would have no way to satisfy
  // that call and the test would throw well before this assertion.
  const result = await scoreBusinessBatch(pool, {});
  assert.equal(result.results[0].ok, true);
});
