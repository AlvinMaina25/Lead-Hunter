const test = require('node:test');
const assert = require('node:assert/strict');

const { PAGESPEED_STATUS, extractScores, fetchPageSpeedInsights } = require('../pagespeedInsights');

/**
 * A representative PSI v5 `runPagespeed` response, trimmed to the shape
 * that actually matters for extraction but otherwise matching the real
 * documented schema field-for-field (kind/id/loadingExperience siblings
 * of lighthouseResult, categories keyed by lowercase/hyphenated ids,
 * configSettings.formFactor, etc). Used so our regression tests exercise
 * the parser against something closer to a live response than a bare
 * `{ lighthouseResult: { categories: {...} } }` stub.
 */
function representativePsiResponse({ formFactorField = 'formFactor', formFactor = 'mobile' } = {}) {
  return {
    kind: 'pagespeedonline#result',
    id: 'https://www.petersalons.com/',
    loadingExperience: { id: 'https://www.petersalons.com/', metrics: {}, overall_category: 'AVERAGE' },
    originLoadingExperience: { id: 'petersalons.com', metrics: {}, overall_category: 'AVERAGE' },
    analysisUTCTimestamp: '2026-09-22T00:00:00.000Z',
    lighthouseResult: {
      requestedUrl: 'https://www.petersalons.com/',
      finalUrl: 'https://www.petersalons.com/',
      lighthouseVersion: '11.4.0',
      userAgent: 'Mozilla/5.0 (Linux; Android 11) HeadlessChrome',
      fetchTime: '2026-09-22T00:00:00.000Z',
      environment: { networkUserAgent: 'Mozilla/5.0', hostUserAgent: 'Mozilla/5.0', benchmarkIndex: 500 },
      runWarnings: [],
      configSettings: { [formFactorField]: formFactor, locale: 'en-US', channel: 'lr' },
      categories: {
        performance: { id: 'performance', title: 'Performance', score: 0.64 },
        accessibility: { id: 'accessibility', title: 'Accessibility', score: 0.97 },
        'best-practices': { id: 'best-practices', title: 'Best Practices', score: 0.92 },
        seo: { id: 'seo', title: 'SEO', score: 1 },
      },
      categoryGroups: {},
      timing: { total: 12345 },
    },
    version: { major: '11', minor: '4' },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('extractScores: pulls all four categories and the form factor when present', () => {
  const scores = extractScores({
    lighthouseResult: {
      configSettings: { formFactor: 'mobile' },
      categories: {
        performance: { score: 0.87 },
        accessibility: { score: 0.91 },
        seo: { score: 1 },
        'best-practices': { score: 0.79 },
      },
    },
  });

  assert.equal(scores.performanceScore, 87);
  assert.equal(scores.accessibilityScore, 91);
  assert.equal(scores.seoScore, 100);
  assert.equal(scores.bestPracticesScore, 79);
  assert.equal(scores.mobileIndicator, 'mobile');
});

test('extractScores: a category PSI did not return stays null, never 0', () => {
  const scores = extractScores({
    lighthouseResult: {
      configSettings: {},
      categories: {
        performance: { score: 0.5 },
        // accessibility, seo, best-practices intentionally absent
      },
    },
  });

  assert.equal(scores.performanceScore, 50);
  assert.equal(scores.accessibilityScore, null);
  assert.equal(scores.seoScore, null);
  assert.equal(scores.bestPracticesScore, null);
  assert.equal(scores.mobileIndicator, null);
});

test('fetchPageSpeedInsights: successful response extracts scores and keeps the raw payload', async () => {
  const body = {
    lighthouseResult: {
      configSettings: { formFactor: 'mobile' },
      categories: {
        performance: { score: 0.72 },
        accessibility: { score: 0.95 },
        seo: { score: 0.88 },
        'best-practices': { score: 0.83 },
      },
    },
  };

  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, body),
  });

  assert.equal(result.status, PAGESPEED_STATUS.COMPLETED);
  assert.equal(result.performanceScore, 72);
  assert.equal(result.accessibilityScore, 95);
  assert.equal(result.mobileIndicator, 'mobile');
  assert.deepEqual(result.raw, body);
  assert.equal(result.errorCode, null);
});

test('fetchPageSpeedInsights: API error response is classified and never throws', async () => {
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () =>
      jsonResponse(400, { error: { code: 400, message: 'Invalid URL', status: 'INVALID_ARGUMENT' } }),
  });

  assert.equal(result.status, PAGESPEED_STATUS.FAILED);
  assert.equal(result.errorCode, 'INVALID_ARGUMENT');
  assert.equal(result.performanceScore, null);
});

test('fetchPageSpeedInsights: HTTP 429 is classified as rate_limited', async () => {
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () =>
      jsonResponse(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }),
  });

  assert.equal(result.status, PAGESPEED_STATUS.RATE_LIMITED);
});

test('fetchPageSpeedInsights: a missing PageSpeed metric stays null rather than invented', async () => {
  const body = {
    lighthouseResult: {
      configSettings: { formFactor: 'mobile' },
      categories: {
        performance: { score: 0.6 },
        // no accessibility/seo/best-practices returned by PSI this time
      },
    },
  };

  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, body),
  });

  assert.equal(result.status, PAGESPEED_STATUS.COMPLETED);
  assert.equal(result.performanceScore, 60);
  assert.equal(result.accessibilityScore, null);
  assert.equal(result.seoScore, null);
  assert.equal(result.bestPracticesScore, null);
});

test('fetchPageSpeedInsights: missing API key -> unavailable, no request attempted', async () => {
  let called = false;
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: '',
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });

  assert.equal(called, false);
  assert.equal(result.status, PAGESPEED_STATUS.UNAVAILABLE);
  assert.equal(result.errorCode, 'MISSING_API_KEY');
});

test('fetchPageSpeedInsights: timeout is classified distinctly', async () => {
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });

  assert.equal(result.status, PAGESPEED_STATUS.TIMEOUT);
});

test('fetchPageSpeedInsights: malformed JSON body is handled without throwing', async () => {
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '{not valid json';
      },
    }),
  });

  assert.equal(result.status, PAGESPEED_STATUS.FAILED);
  assert.equal(result.errorCode, 'MALFORMED_RESPONSE');
});

test('fetchPageSpeedInsights: 200 with no lighthouseResult is treated as a measurable failure, not fake scores', async () => {
  const result = await fetchPageSpeedInsights('https://example.com', {
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, { captchaResult: 'CHALLENGE' }),
  });

  assert.equal(result.status, PAGESPEED_STATUS.FAILED);
  assert.equal(result.errorCode, 'NO_LIGHTHOUSE_RESULT');
  assert.equal(result.performanceScore, null);
});

// ---------------------------------------------------------------------
// Regression coverage added in Phase 10D.1 (PageSpeed score extraction
// debug). These use a fuller, representative PSI v5 payload (see
// representativePsiResponse above) rather than a minimal stub, so the
// parser is exercised against something closer to what a live PSI call
// for a real business (e.g. Peter Amor Beauty Salons) actually returns.
// ---------------------------------------------------------------------

test('fetchPageSpeedInsights: representative full PSI v5 response extracts all four scores + mobile form factor', async () => {
  const body = representativePsiResponse();

  const result = await fetchPageSpeedInsights('https://www.petersalons.com/', {
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, body),
  });

  assert.equal(result.status, PAGESPEED_STATUS.COMPLETED);
  assert.equal(result.performanceScore, 64);
  assert.equal(result.accessibilityScore, 97);
  assert.equal(result.seoScore, 100);
  assert.equal(result.bestPracticesScore, 92);
  assert.equal(result.mobileIndicator, 'mobile');
  assert.deepEqual(result.raw, body);
});

test('extractScores: falls back to the deprecated configSettings.emulatedFormFactor when formFactor is absent', () => {
  const body = representativePsiResponse({ formFactorField: 'emulatedFormFactor', formFactor: 'desktop' });
  const scores = extractScores(body);

  assert.equal(scores.mobileIndicator, 'desktop');
  // Category scores are unaffected by which form-factor field was used.
  assert.equal(scores.performanceScore, 64);
});

test('extractScores: neither formFactor nor emulatedFormFactor present -> mobileIndicator stays null, never inferred', () => {
  const scores = extractScores({
    lighthouseResult: {
      configSettings: { locale: 'en-US' },
      categories: { performance: { score: 0.5 } },
    },
  });

  assert.equal(scores.mobileIndicator, null);
});

test('extractScores: a runtimeError run with an empty categories object leaves every score null, not 0', () => {
  const scores = extractScores({
    lighthouseResult: {
      runtimeError: { code: 'ERRORED_DOCUMENT_REQUEST', message: 'Requested URL could not be loaded' },
      configSettings: { formFactor: 'mobile' },
      categories: {},
    },
  });

  assert.equal(scores.performanceScore, null);
  assert.equal(scores.accessibilityScore, null);
  assert.equal(scores.seoScore, null);
  assert.equal(scores.bestPracticesScore, null);
  // formFactor is still reported even when the audit itself failed --
  // that field describes the request PSI made, not the audit outcome.
  assert.equal(scores.mobileIndicator, 'mobile');
});

test('fetchPageSpeedInsights: a slow-but-successful PSI call is not mistaken for a timeout at the new default timeout', async () => {
  // Regression guard for the 25s -> 55s DEFAULT_TIMEOUT_MS change: a
  // response that resolves comfortably within the new window must still
  // be classified as completed with real scores, not timed out.
  const body = representativePsiResponse();
  let resolveFetch;
  const pending = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  const resultPromise = fetchPageSpeedInsights('https://www.petersalons.com/', {
    apiKey: 'test-key',
    timeoutMs: 55000,
    fetchImpl: async () => pending,
  });

  resolveFetch(jsonResponse(200, body));
  const result = await resultPromise;

  assert.equal(result.status, PAGESPEED_STATUS.COMPLETED);
  assert.equal(result.performanceScore, 64);
});
