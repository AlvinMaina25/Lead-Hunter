const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANALYSIS_STATUS,
  ALLOWED_SERVICES,
  NotFoundError,
  ValidationError,
  buildVerifiedInput,
  validateStructuredOutput,
  valuesMatch,
  filterVerifiedEvidence,
  containsFabricatedContactInfo,
  applyAntiHallucinationFiltering,
  loadLatestWebsiteAnalysis,
  analyzeBusinessOpportunity,
  callGemini,
} = require('../aiOpportunityAnalysis');

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';

// -----------------------------------------------------------------------
// Fake pool
// -----------------------------------------------------------------------

function makeFakePool({ business, websiteAnalyses = [], failInsert = false } = {}) {
  const analyses = [];

  async function query(sql, params = []) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (normalizedSql.startsWith('SELECT id, name, category, phone, email, city, country')) {
      const row = business && business.id === params[0] ? { ...business } : null;
      return { rows: row ? [row] : [] };
    }

    if (normalizedSql.startsWith('SELECT performance_score, accessibility_score')) {
      const matches = websiteAnalyses
        .filter((a) => a.business_id === params[0])
        .sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));
      return { rows: matches.length > 0 ? [{ ...matches[0] }] : [] };
    }

    if (normalizedSql.startsWith('INSERT INTO ai_analysis')) {
      if (failInsert) throw new Error('simulated database failure');
      const row = {
        id: `analysis-${analyses.length + 1}`,
        business_id: params[0],
        ai_model: params[1],
        summary: params[2],
        problems: params[3] ? JSON.parse(params[3]) : null,
        opportunities: params[4] ? JSON.parse(params[4]) : null,
        recommended_service: params[5],
        reasoning: params[6],
        confidence: params[7],
        sales_angle: params[8],
        status: params[9],
        error_code: params[10],
        error_message: params[11],
        input_snapshot: params[12] ? JSON.parse(params[12]) : null,
        raw_ai_response: params[13] ? JSON.parse(params[13]) : null,
        created_at: new Date().toISOString(),
      };
      analyses.push(row);
      return { rows: [row] };
    }

    throw new Error(`FakePool: unrecognized query: ${normalizedSql}`);
  }

  return { query, _analyses: analyses };
}

function baseBusiness(overrides = {}) {
  return {
    id: BUSINESS_ID,
    name: 'Peter Amor Beauty Salons',
    category: 'Beauty Salon',
    phone: '+254700000000',
    email: null,
    city: 'Nairobi',
    country: 'Kenya',
    google_rating: 4.5,
    google_review_count: 120,
    website_url: 'https://www.petersalons.com/',
    website_status: 'reachable',
    ...overrides,
  };
}

function baseWebsiteAnalysis(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    performance_score: 65,
    accessibility_score: 94,
    seo_score: 92,
    best_practices_score: 100,
    mobile_indicator: 'mobile',
    https_enabled: true,
    page_title: 'Peter Amor Salons',
    meta_description: null,
    viewport_present: true,
    http_status: 200,
    response_time_ms: 1228,
    html_size_bytes: 2048,
    analysis_status: 'completed',
    analyzed_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

function validModelOutput(overrides = {}) {
  return {
    summary: 'Performance has measurable room for improvement.',
    problems: [
      {
        title: 'Below-average performance score',
        description: 'PageSpeed performance score is 65/100, indicating measurable room for improvement.',
        evidence: [{ field: 'analysis_performance_score', value: 65 }],
      },
    ],
    opportunities: [
      {
        title: 'Performance optimization',
        description: 'A performance score of 65 suggests optimization work could help.',
        service: 'mobile_optimization',
        evidence: [{ field: 'analysis_performance_score', value: 65 }],
      },
    ],
    recommended_service: 'mobile_optimization',
    reasoning: 'The measured performance score supports a mobile optimization opportunity.',
    confidence: 60,
    sales_angle: 'Lead with the measurable performance gap.',
    ...overrides,
  };
}

function makeCallModel(result) {
  return async () => result;
}

// -----------------------------------------------------------------------
// 1. valid business -> completed analysis
// -----------------------------------------------------------------------

test('valid business produces a completed, persisted analysis', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis()] });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: validModelOutput(), errorCode: null, errorMessage: null });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });

  assert.equal(row.status, 'completed');
  assert.equal(row.recommended_service, 'mobile_optimization');
  assert.equal(row.problems.length, 1);
  assert.equal(row.opportunities.length, 1);
  assert.equal(pool._analyses.length, 1);
});

// -----------------------------------------------------------------------
// 2. business not found
// -----------------------------------------------------------------------

test('business not found throws NotFoundError', async () => {
  const pool = makeFakePool({ business: null });
  await assert.rejects(
    () => analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel: makeCallModel({}) }),
    NotFoundError
  );
});

test('invalid uuid throws ValidationError', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  await assert.rejects(() => analyzeBusinessOpportunity(pool, 'not-a-uuid', {}), ValidationError);
});

// -----------------------------------------------------------------------
// 3. missing Gemini key
// -----------------------------------------------------------------------

test('missing Gemini key is persisted as unavailable', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.UNAVAILABLE,
    parsed: null,
    errorCode: 'MISSING_API_KEY',
    errorMessage: 'GEMINI_API_KEY is not configured.',
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });

  assert.equal(row.status, 'unavailable');
  assert.equal(row.error_code, 'MISSING_API_KEY');
  assert.equal(row.summary, null);
});

// -----------------------------------------------------------------------
// 4. Gemini API error
// -----------------------------------------------------------------------

test('Gemini API error (5xx) is persisted as unavailable', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.UNAVAILABLE,
    parsed: null,
    errorCode: 'HTTP_500',
    errorMessage: 'Gemini API request failed.',
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'unavailable');
  assert.equal(row.error_code, 'HTTP_500');
});

test('Gemini rate limiting is persisted as rate_limited', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.RATE_LIMITED,
    parsed: null,
    errorCode: 'RATE_LIMITED',
    errorMessage: 'Gemini reported rate limiting.',
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'rate_limited');
});

// -----------------------------------------------------------------------
// 5. Gemini timeout
// -----------------------------------------------------------------------

test('Gemini timeout is persisted as timeout', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.TIMEOUT,
    parsed: null,
    errorCode: 'TIMEOUT',
    errorMessage: 'Gemini request timed out after 45000ms.',
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'timeout');
});

// -----------------------------------------------------------------------
// 6. malformed JSON
// -----------------------------------------------------------------------

test('malformed model JSON is persisted as failed, not completed', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.FAILED,
    parsed: null,
    errorCode: 'MALFORMED_JSON_CONTENT',
    errorMessage: "The model's output could not be parsed as JSON.",
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'MALFORMED_JSON_CONTENT');
});

// -----------------------------------------------------------------------
// 7. invalid confidence
// -----------------------------------------------------------------------

test('validateStructuredOutput rejects out-of-range confidence', () => {
  const result = validateStructuredOutput(validModelOutput({ confidence: 150 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('confidence')));
});

test('validateStructuredOutput rejects non-integer confidence', () => {
  const result = validateStructuredOutput(validModelOutput({ confidence: 60.5 }));
  assert.equal(result.valid, false);
});

test('end-to-end: invalid confidence is rejected and persisted as failed', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis()] });
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.COMPLETED,
    parsed: validModelOutput({ confidence: 999 }),
    errorCode: null,
    errorMessage: null,
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'SCHEMA_VALIDATION_FAILED');
  assert.equal(row.summary, null);
});

// -----------------------------------------------------------------------
// 8. invalid service
// -----------------------------------------------------------------------

test('validateStructuredOutput rejects an opportunity with a disallowed service', () => {
  const output = validModelOutput();
  output.opportunities[0].service = 'build_them_a_rocket_ship';
  const result = validateStructuredOutput(output);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('service')));
});

test('validateStructuredOutput rejects a disallowed recommended_service', () => {
  const result = validateStructuredOutput(validModelOutput({ recommended_service: 'not_a_real_service' }));
  assert.equal(result.valid, false);
});

// -----------------------------------------------------------------------
// 9. fabricated evidence (unknown field)
// -----------------------------------------------------------------------

test('evidence citing a field not in the snapshot is dropped', () => {
  const snapshot = buildVerifiedInput(baseBusiness(), baseWebsiteAnalysis());
  const evidence = [{ field: 'annual_revenue', value: 500000 }];
  const kept = filterVerifiedEvidence(evidence, snapshot);
  assert.equal(kept.length, 0);
});

test('applyAntiHallucinationFiltering drops a problem whose only evidence is fabricated', () => {
  const snapshot = buildVerifiedInput(baseBusiness(), baseWebsiteAnalysis());
  const output = validModelOutput({
    problems: [
      {
        title: 'Invented claim',
        description: 'This business has 50 employees.',
        evidence: [{ field: 'employee_count', value: 50 }],
      },
    ],
  });

  const filtered = applyAntiHallucinationFiltering(output, snapshot);
  assert.equal(filtered.rejected, false);
  assert.equal(filtered.result.problems.length, 0);
});

// -----------------------------------------------------------------------
// 10. evidence value mismatch
// -----------------------------------------------------------------------

test('evidence whose value does not match the real snapshot value is dropped', () => {
  const snapshot = buildVerifiedInput(baseBusiness(), baseWebsiteAnalysis()); // performance_score = 65
  const evidence = [{ field: 'analysis_performance_score', value: 20 }];
  const kept = filterVerifiedEvidence(evidence, snapshot);
  assert.equal(kept.length, 0);
});

test('valuesMatch: numbers, booleans, strings, and nulls', () => {
  assert.equal(valuesMatch(65, 65), true);
  assert.equal(valuesMatch(65, '65'), true);
  assert.equal(valuesMatch(65, 66), false);
  assert.equal(valuesMatch(true, true), true);
  assert.equal(valuesMatch(true, false), false);
  assert.equal(valuesMatch('Nairobi', 'nairobi'), true);
  assert.equal(valuesMatch(null, false), true);
  assert.equal(valuesMatch(null, 'not detected'), true);
  assert.equal(valuesMatch(null, 'Nairobi'), false);
});

// -----------------------------------------------------------------------
// 11. valid no-website opportunity
// -----------------------------------------------------------------------

test('a business with no website supports a new_website opportunity', async () => {
  const business = baseBusiness({ website_url: null, website_status: 'no_website' });
  const pool = makeFakePool({ business, websiteAnalyses: [] });
  const output = validModelOutput({
    problems: [
      {
        title: 'No website on file',
        description: 'No website URL is on file for this business.',
        evidence: [{ field: 'business_has_website', value: false }],
      },
    ],
    opportunities: [
      {
        title: 'Build a first website',
        description: 'This business has no website on file, which supports a new website engagement.',
        service: 'new_website',
        evidence: [{ field: 'business_has_website', value: false }],
      },
    ],
    recommended_service: 'new_website',
  });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: output, errorCode: null, errorMessage: null });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'completed');
  assert.equal(row.recommended_service, 'new_website');
  assert.equal(row.opportunities.length, 1);
});

// -----------------------------------------------------------------------
// 12. valid low-performance opportunity
// -----------------------------------------------------------------------

test('a low performance score supports a mobile_optimization opportunity', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis({ performance_score: 32 })] });
  const output = validModelOutput({
    problems: [
      {
        title: 'Low performance score',
        description: 'PageSpeed performance score is 32/100.',
        evidence: [{ field: 'analysis_performance_score', value: 32 }],
      },
    ],
    opportunities: [
      {
        title: 'Optimize site performance',
        description: 'A performance score of 32 supports an optimization engagement.',
        service: 'mobile_optimization',
        evidence: [{ field: 'analysis_performance_score', value: 32 }],
      },
    ],
    recommended_service: 'mobile_optimization',
  });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: output, errorCode: null, errorMessage: null });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'completed');
  assert.equal(row.recommended_service, 'mobile_optimization');
});

// -----------------------------------------------------------------------
// 13. valid SEO opportunity
// -----------------------------------------------------------------------

test('missing meta description + low SEO score supports an seo_improvement opportunity', async () => {
  const pool = makeFakePool({
    business: baseBusiness(),
    websiteAnalyses: [baseWebsiteAnalysis({ meta_description: null, seo_score: 40 })],
  });
  const output = validModelOutput({
    problems: [
      {
        title: 'No meta description detected',
        description: 'No meta description was detected on the analyzed homepage, and the SEO score is 40/100.',
        evidence: [
          { field: 'website_meta_description', value: 'not detected' },
          { field: 'analysis_seo_score', value: 40 },
        ],
      },
    ],
    opportunities: [
      {
        title: 'SEO improvement',
        description: 'Missing meta description and a low SEO score support an SEO improvement engagement.',
        service: 'seo_improvement',
        evidence: [
          { field: 'website_meta_description', value: 'not detected' },
          { field: 'analysis_seo_score', value: 40 },
        ],
      },
    ],
    recommended_service: 'seo_improvement',
  });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: output, errorCode: null, errorMessage: null });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'completed');
  assert.equal(row.recommended_service, 'seo_improvement');
  assert.equal(row.opportunities[0].evidence.length, 2);
});

// -----------------------------------------------------------------------
// 14. insufficient evidence -> no recommendation
// -----------------------------------------------------------------------

test('insufficient evidence results in recommended_service null, not forced', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis()] });
  const output = validModelOutput({
    problems: [],
    opportunities: [],
    recommended_service: null,
    sales_angle: 'Not enough verified signal yet to pitch a specific service.',
  });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: output, errorCode: null, errorMessage: null });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(row.status, 'completed');
  assert.equal(row.recommended_service, null);
});

test('a recommended_service without a surviving supporting opportunity falls back to null', () => {
  const snapshot = buildVerifiedInput(baseBusiness(), baseWebsiteAnalysis());
  const output = validModelOutput({
    opportunities: [
      {
        title: 'Unsupported claim',
        description: 'Fabricated.',
        service: 'ecommerce_website',
        evidence: [{ field: 'has_online_store', value: true }], // not a real field
      },
    ],
    recommended_service: 'ecommerce_website',
  });

  const filtered = applyAntiHallucinationFiltering(output, snapshot);
  assert.equal(filtered.result.opportunities.length, 0);
  assert.equal(filtered.result.recommended_service, null);
});

// -----------------------------------------------------------------------
// 15. latest website analysis is used
// -----------------------------------------------------------------------

test('loadLatestWebsiteAnalysis picks the most recently analyzed row', async () => {
  const older = baseWebsiteAnalysis({ performance_score: 20, analyzed_at: '2026-01-01T00:00:00.000Z' });
  const newer = baseWebsiteAnalysis({ performance_score: 88, analyzed_at: '2026-09-20T00:00:00.000Z' });
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [older, newer] });

  const latest = await loadLatestWebsiteAnalysis(pool, BUSINESS_ID);
  assert.equal(latest.performance_score, 88);
});

// -----------------------------------------------------------------------
// 16 & 17. historical analyses preserved / never overwritten
// -----------------------------------------------------------------------

test('repeated analysis inserts new rows and preserves prior history', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis()] });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: validModelOutput(), errorCode: null, errorMessage: null });

  const first = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  const second = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });

  assert.notEqual(first.id, second.id);
  assert.equal(pool._analyses.length, 2);
  assert.ok(pool._analyses.find((a) => a.id === first.id));
  assert.ok(pool._analyses.find((a) => a.id === second.id));
});

// -----------------------------------------------------------------------
// 18. no client-supplied business facts
// -----------------------------------------------------------------------

test('the engine only ever uses business facts freshly loaded from the pool', async () => {
  const pool = makeFakePool({ business: baseBusiness({ name: 'Real DB Name' }), websiteAnalyses: [baseWebsiteAnalysis()] });
  let capturedSnapshot = null;
  const callModel = async (snapshot) => {
    capturedSnapshot = snapshot;
    return { status: ANALYSIS_STATUS.COMPLETED, parsed: validModelOutput(), errorCode: null, errorMessage: null };
  };

  // Even if a caller tried to smuggle business facts in via options, the
  // engine has no parameter that accepts them -- only pool/id/API knobs.
  await analyzeBusinessOpportunity(pool, BUSINESS_ID, {
    callModel,
    business_name: 'Attacker-Supplied Name',
    google_rating: 5,
  });

  assert.equal(capturedSnapshot.business_name, 'Real DB Name');
});

// -----------------------------------------------------------------------
// 19. API key never appears in the response
// -----------------------------------------------------------------------

test('a fake API key never leaks into the persisted row', async () => {
  const pool = makeFakePool({ business: baseBusiness() });
  const SECRET = 'AIzaSuperSecretTestKey';
  const callModel = makeCallModel({
    status: ANALYSIS_STATUS.UNAVAILABLE,
    parsed: null,
    errorCode: 'AUTH_ERROR',
    errorMessage: 'Gemini rejected the configured API key.',
  });

  const row = await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel, apiKey: SECRET });
  assert.ok(!JSON.stringify(row).includes(SECRET));
});

test('containsFabricatedContactInfo flags emails and phone numbers', () => {
  assert.equal(containsFabricatedContactInfo('contact us at sales@example.com'), true);
  assert.equal(containsFabricatedContactInfo('call +1 415-555-0100 now'), true);
  assert.equal(containsFabricatedContactInfo('the performance score is 65'), false);
});

test('a fabricated contact detail in a narrative field rejects the whole analysis', () => {
  const snapshot = buildVerifiedInput(baseBusiness(), baseWebsiteAnalysis());
  const output = validModelOutput({ reasoning: 'Reach out at owner@example.com for a quick win.' });
  const filtered = applyAntiHallucinationFiltering(output, snapshot);
  assert.equal(filtered.rejected, true);
  assert.equal(filtered.reason, 'FABRICATED_CONTACT_INFO');
});

// -----------------------------------------------------------------------
// 20. successful analysis is persisted
// -----------------------------------------------------------------------

test('a successful analysis is actually written via pool.query INSERT', async () => {
  const pool = makeFakePool({ business: baseBusiness(), websiteAnalyses: [baseWebsiteAnalysis()] });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: validModelOutput(), errorCode: null, errorMessage: null });

  assert.equal(pool._analyses.length, 0);
  await analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel });
  assert.equal(pool._analyses.length, 1);
  assert.equal(pool._analyses[0].status, 'completed');
});

// -----------------------------------------------------------------------
// Extra: database failure during persistence propagates rather than
// silently swallowing the error (no route wraps this in try/catch that
// hides it -- the route's generic error handler takes over).
// -----------------------------------------------------------------------

test('a database failure on insert propagates as an error', async () => {
  const pool = makeFakePool({ business: baseBusiness(), failInsert: true });
  const callModel = makeCallModel({ status: ANALYSIS_STATUS.COMPLETED, parsed: validModelOutput(), errorCode: null, errorMessage: null });

  await assert.rejects(() => analyzeBusinessOpportunity(pool, BUSINESS_ID, { callModel }));
});

// -----------------------------------------------------------------------
// Sanity: every allowed service constant referenced above is real.
// -----------------------------------------------------------------------

test('ALLOWED_SERVICES includes the services exercised by these tests', () => {
  for (const s of ['mobile_optimization', 'new_website', 'seo_improvement', 'ecommerce_website']) {
    assert.ok(ALLOWED_SERVICES.includes(s));
  }
});

// -----------------------------------------------------------------------
// callGemini: the HTTP-layer client itself (fake fetchImpl, no real
// network request -- these exercise the request/response handling that
// the engine-level tests above bypass via the callModel override).
// -----------------------------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** Shape of a successful Gemini Interactions API response. */
function geminiInteraction(parsedOutput, overrides = {}) {
  return {
    id: 'v1_test',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify(parsedOutput) }],
      },
    ],
    object: 'interaction',
    ...overrides,
  };
}

test('callGemini: missing key never makes a network request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const result = await callGemini({}, { apiKey: '', fetchImpl });
  assert.equal(called, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'MISSING_API_KEY');
});

test('callGemini: success parses the structured content and sends the key via x-goog-api-key', async () => {
  let capturedKeyHeader = null;
  const fetchImpl = async (url, init) => {
    capturedKeyHeader = init.headers['x-goog-api-key'];
    return jsonResponse(200, geminiInteraction(validModelOutput()));
  };

  const result = await callGemini({ business_name: 'Test' }, { apiKey: 'test-gemini-key', fetchImpl });
  assert.equal(result.status, 'completed');
  assert.equal(result.parsed.recommended_service, 'mobile_optimization');
  assert.equal(capturedKeyHeader, 'test-gemini-key');
});

test('callGemini: HTTP 429 maps to rate_limited', async () => {
  const fetchImpl = async () =>
    jsonResponse(429, { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'rate_limited');
});

test('callGemini: HTTP 403 PERMISSION_DENIED maps to unavailable/AUTH_ERROR without leaking anything about the key', async () => {
  const fetchImpl = async () =>
    jsonResponse(403, { error: { code: 403, message: 'bad key', status: 'PERMISSION_DENIED' } });
  const result = await callGemini({}, { apiKey: 'should-not-leak', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'AUTH_ERROR');
  assert.ok(!result.errorMessage.includes('should-not-leak'));
});

test('callGemini: HTTP 400 "API key not valid" also maps to AUTH_ERROR', async () => {
  const fetchImpl = async () =>
    jsonResponse(400, {
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    });
  const result = await callGemini({}, { apiKey: 'garbage', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'AUTH_ERROR');
});

test('callGemini: HTTP 500 maps to unavailable', async () => {
  const fetchImpl = async () =>
    jsonResponse(500, { error: { code: 500, message: 'server error', status: 'INTERNAL' } });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'HTTP_500');
});

test('callGemini: HTTP 404 whose message names the model maps to MODEL_NOT_FOUND with an actionable message', async () => {
  const fetchImpl = async () =>
    jsonResponse(404, {
      error: {
        code: 404,
        message: 'This model models/gemini-2.5-flash is no longer available to new users.',
        status: 'NOT_FOUND',
      },
    });
  const result = await callGemini({}, { apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'MODEL_NOT_FOUND');
  assert.ok(result.errorMessage.includes('gemini-2.5-flash'));
  assert.ok(result.errorMessage.includes('GEMINI_MODEL'));
});

test('callGemini: a generic HTTP 404 that does not mention the model falls back to HTTP_404', async () => {
  const fetchImpl = async () =>
    jsonResponse(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'HTTP_404');
});

test('callGemini: a non-JSON HTTP body is treated as failed/malformed', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'not json at all' });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MALFORMED_RESPONSE');
});

test('callGemini: a non-"completed" interaction status is persisted as failed', async () => {
  const fetchImpl = async () => jsonResponse(200, geminiInteraction(null, { status: 'failed', steps: [] }));
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MODEL_REQUEST_FAILED');
});

test('callGemini: no model_output step (empty content) is persisted as failed', async () => {
  const fetchImpl = async () => jsonResponse(200, { id: 'v1_test', status: 'completed', steps: [] });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'EMPTY_RESPONSE');
});

test('callGemini: content that is not valid JSON is persisted as failed', async () => {
  const fetchImpl = async () =>
    jsonResponse(200, {
      id: 'v1_test',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not { valid json' }] }],
    });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MALFORMED_JSON_CONTENT');
});

test('callGemini: an abort (timeout) is persisted as timeout', async () => {
  const fetchImpl = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const result = await callGemini({}, { apiKey: 'k', fetchImpl, timeoutMs: 10 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.errorCode, 'TIMEOUT');
});

test('callGemini: a generic network error is persisted as unavailable', async () => {
  const fetchImpl = async () => {
    const err = new Error('getaddrinfo ENOTFOUND');
    err.code = 'ENOTFOUND';
    throw err;
  };
  const result = await callGemini({}, { apiKey: 'k', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'ENOTFOUND');
});

test('callGemini: sends the verified snapshot as input and the schema as response_format.schema', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    return jsonResponse(200, geminiInteraction(validModelOutput()));
  };

  await callGemini({ business_name: 'Test Co' }, { apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl });
  assert.equal(capturedBody.model, 'gemini-2.5-flash');
  assert.ok(capturedBody.input.includes('Test Co'));
  assert.equal(capturedBody.response_format.mime_type, 'application/json');
  assert.equal(capturedBody.response_format.schema.type, 'object');
  assert.ok(Array.isArray(capturedBody.response_format.schema.required));
});
