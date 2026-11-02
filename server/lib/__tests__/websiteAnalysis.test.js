const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  ANALYSIS_STATUS,
  extractTitle,
  extractMetaContent,
  hasViewportTag,
  safeFetchHomepage,
  analyzeBusinessWebsite,
  loadBusiness,
  NotFoundError,
  ValidationError,
} = require('../websiteAnalysis');
const { fetchPageSpeedInsights, PAGESPEED_STATUS } = require('../pagespeedInsights');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Builds a fake node:http/https module whose .request() is scripted. */
function makeFakeHttpModule(behavior) {
  return {
    request(_url, _options, callback) {
      const req = new EventEmitter();
      req.end = () => {
        process.nextTick(() => behavior(req, callback));
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err || new Error('socket destroyed')));
      };
      return req;
    },
  };
}

/** A fake response object compatible with the (res) callback in websiteAnalysis.js. */
function fakeResponse({ statusCode, headers = {}, bodyChunks = [] }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.setEncoding = () => {};
  res.destroy = () => {
    process.nextTick(() => res.emit('close'));
  };
  res.__emitBody = () => {
    for (const chunk of bodyChunks) res.emit('data', chunk);
    res.emit('end');
  };
  return res;
}

function htmlResponse(statusCode, html, headers = {}) {
  const module = makeFakeHttpModule((req, callback) => {
    const res = fakeResponse({ statusCode, headers, bodyChunks: [html] });
    callback(res);
    process.nextTick(() => res.__emitBody());
  });
  return { httpModule: module, httpsModule: module };
}

test('extractTitle: finds a normal <title>', () => {
  assert.equal(extractTitle('<html><head><title>Acme Bakery</title></head></html>'), 'Acme Bakery');
});

test('extractTitle: missing title -> null (measurable finding, not invented)', () => {
  assert.equal(extractTitle('<html><head></head><body>hi</body></html>'), null);
});

test('extractMetaContent: finds description regardless of attribute order', () => {
  const html = '<meta content="Fresh bread daily" name="description">';
  assert.equal(extractMetaContent(html, 'description'), 'Fresh bread daily');
});

test('extractMetaContent: missing meta description -> null', () => {
  assert.equal(extractMetaContent('<html><head></head></html>', 'description'), null);
});

test('hasViewportTag: detects a present viewport tag', () => {
  assert.equal(hasViewportTag('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
});

test('hasViewportTag: missing viewport -> false', () => {
  assert.equal(hasViewportTag('<html><head><title>x</title></head></html>'), false);
});

test('safeFetchHomepage: reachable homepage extracts all measurable signals', async () => {
  const html =
    '<html><head><title>Acme Bakery</title>' +
    '<meta name="description" content="Fresh bread daily">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '</head><body></body></html>';

  const result = await safeFetchHomepage('https://example.com', {
    lookup: publicLookup,
    ...htmlResponse(200, html),
  });

  assert.equal(result.status, ANALYSIS_STATUS.COMPLETED);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.httpsEnabled, true);
  assert.equal(result.pageTitle, 'Acme Bakery');
  assert.equal(result.metaDescription, 'Fresh bread daily');
  assert.equal(result.viewportPresent, true);
  assert.equal(result.finalUrl, 'https://example.com');
  assert.ok(Number.isFinite(result.htmlSizeBytes));
  assert.ok(Number.isFinite(result.responseTimeMs));
  assert.equal(result.errorCode, null);
});

test('safeFetchHomepage: missing <title> is recorded as null, not invented', async () => {
  const html = '<html><head><meta name="viewport" content="width=device-width"></head></html>';
  const result = await safeFetchHomepage('https://example.com', { lookup: publicLookup, ...htmlResponse(200, html) });
  assert.equal(result.status, ANALYSIS_STATUS.COMPLETED);
  assert.equal(result.pageTitle, null);
});

test('safeFetchHomepage: missing meta description is recorded as null', async () => {
  const html = '<html><head><title>Acme</title></head></html>';
  const result = await safeFetchHomepage('https://example.com', { lookup: publicLookup, ...htmlResponse(200, html) });
  assert.equal(result.status, ANALYSIS_STATUS.COMPLETED);
  assert.equal(result.metaDescription, null);
});

test('safeFetchHomepage: missing viewport tag is recorded as false', async () => {
  const html = '<html><head><title>Acme</title></head></html>';
  const result = await safeFetchHomepage('https://example.com', { lookup: publicLookup, ...htmlResponse(200, html) });
  assert.equal(result.status, ANALYSIS_STATUS.COMPLETED);
  assert.equal(result.viewportPresent, false);
});

test('safeFetchHomepage: detects HTTPS vs not', async () => {
  const html = '<html><head><title>Acme</title></head></html>';
  const httpsResult = await safeFetchHomepage('https://example.com', {
    lookup: publicLookup,
    ...htmlResponse(200, html),
  });
  assert.equal(httpsResult.httpsEnabled, true);

  const httpResult = await safeFetchHomepage('http://example.com', {
    lookup: publicLookup,
    ...htmlResponse(200, html),
  });
  assert.equal(httpResult.httpsEnabled, false);
});

test('safeFetchHomepage: timeout is classified as ANALYSIS_STATUS.TIMEOUT', async () => {
  const httpModule = makeFakeHttpModule(() => {
    /* never calls back; only 'timeout' will fire, driven below */
  });

  // Override request() to also expose the timeout hook synchronously.
  const originalRequest = httpModule.request;
  httpModule.request = (url, options, callback) => {
    const req = originalRequest(url, options, callback);
    process.nextTick(() => req.emit('timeout'));
    return req;
  };

  const result = await safeFetchHomepage('https://example.com', {
    lookup: publicLookup,
    httpModule,
    httpsModule: httpModule,
    timeoutMs: 50,
  });

  assert.equal(result.status, ANALYSIS_STATUS.TIMEOUT);
  assert.equal(result.errorCode, 'TIMEOUT');
});

test('safeFetchHomepage: blocked website (SSRF target) never opens a socket', async () => {
  let requested = false;
  const httpModule = makeFakeHttpModule(() => {
    requested = true;
  });

  const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

  const result = await safeFetchHomepage('https://internal.example.com', {
    lookup: privateLookup,
    httpModule,
    httpsModule: httpModule,
  });

  assert.equal(result.status, ANALYSIS_STATUS.BLOCKED);
  assert.equal(result.errorCode, 'SSRF_BLOCKED');
  assert.equal(requested, false, 'no request should ever be attempted against a blocked target');
});

test('safeFetchHomepage: malformed HTML still yields a measurable (completed) result', async () => {
  const brokenHtml = '<html><head><titl>Oops</titl</head><body>><meta name=viewport content=';
  const result = await safeFetchHomepage('https://example.com', {
    lookup: publicLookup,
    ...htmlResponse(200, brokenHtml),
  });
  assert.equal(result.status, ANALYSIS_STATUS.COMPLETED);
  assert.equal(result.pageTitle, null);
  assert.equal(result.viewportPresent, false);
});

test('safeFetchHomepage: a dangerous port on an otherwise-public address never opens a socket', async () => {
  let requested = false;
  const httpModule = makeFakeHttpModule(() => {
    requested = true;
  });

  const result = await safeFetchHomepage('https://example.com:5432/', {
    lookup: publicLookup,
    httpModule,
    httpsModule: httpModule,
  });

  assert.equal(result.status, ANALYSIS_STATUS.BLOCKED);
  assert.equal(result.errorCode, 'SSRF_BLOCKED');
  assert.equal(requested, false, 'no request should ever be attempted against a blocked port');
});

test('safeFetchHomepage: a redirect to a dangerous port is blocked rather than followed', async () => {
  let requestCount = 0;
  const httpModule = makeFakeHttpModule((req, callback) => {
    requestCount += 1;
    const res = fakeResponse({
      statusCode: 302,
      headers: { location: 'https://internal.example.com:6379/' },
    });
    callback(res);
  });

  const result = await safeFetchHomepage('https://example.com/', {
    lookup: publicLookup,
    httpModule,
    httpsModule: httpModule,
  });

  assert.equal(result.status, ANALYSIS_STATUS.BLOCKED);
  assert.equal(result.errorCode, 'SSRF_BLOCKED_REDIRECT');
  assert.equal(requestCount, 1, 'only the original hop should ever connect');
});

test('safeFetchHomepage: SSRF rejection also covers a schemeless private-looking host', async () => {
  const httpModule = makeFakeHttpModule(() => {
    throw new Error('should never be called');
  });
  const localhostResult = await safeFetchHomepage('localhost:8080', {
    lookup: publicLookup,
    httpModule,
    httpsModule: httpModule,
  });
  assert.equal(localhostResult.status, ANALYSIS_STATUS.BLOCKED);
});

// -----------------------------------------------------------------------
// Orchestration: analyzeBusinessWebsite
// -----------------------------------------------------------------------

function makeFakePool(initialBusinesses, initialAnalyses = []) {
  const businesses = new Map(initialBusinesses.map((b) => [b.id, { ...b }]));
  const analyses = [...initialAnalyses];

  async function query(sql, params = []) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (normalizedSql.startsWith('SELECT id, website_url, website_status FROM businesses WHERE id = $1')) {
      const row = businesses.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalizedSql.startsWith('INSERT INTO website_analysis')) {
      const row = {
        id: `analysis-${analyses.length + 1}`,
        business_id: params[0],
        analyzed_url: params[1],
        performance_score: params[2],
        accessibility_score: params[3],
        seo_score: params[4],
        best_practices_score: params[5],
        mobile_indicator: params[6],
        https_enabled: params[7],
        page_title: params[8],
        meta_description: params[9],
        viewport_present: params[10],
        html_size_bytes: params[11],
        response_time_ms: params[12],
        http_status: params[13],
        raw_analysis_response: params[14] ? JSON.parse(params[14]) : null,
        analysis_status: params[15],
        error_code: params[16],
        error_message: params[17],
      };
      analyses.push(row);
      return { rows: [row] };
    }

    throw new Error(`FakePool: unrecognized query: ${normalizedSql}`);
  }

  return { query, _analyses: analyses };
}

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';

test('analyzeBusinessWebsite: throws NotFoundError for an unknown business id', async () => {
  const pool = makeFakePool([]);
  await assert.rejects(() => analyzeBusinessWebsite(pool, BUSINESS_ID), NotFoundError);
});

test('analyzeBusinessWebsite: rejects a malformed business id without querying the DB', async () => {
  const pool = makeFakePool([]);
  await assert.rejects(() => analyzeBusinessWebsite(pool, 'not-a-uuid'), ValidationError);
});

test('analyzeBusinessWebsite: skips analysis entirely when website_status is not reachable', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'unknown' },
  ]);

  let fetchCalled = false;
  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    fetchHomepage: async () => {
      fetchCalled = true;
      return {};
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(row.analysis_status, 'unavailable');
  assert.equal(row.error_code, 'NOT_REACHABLE');
  assert.equal(row.performance_score, null);
});

test('analyzeBusinessWebsite: reachable business runs homepage + PageSpeed and persists a completed row', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' },
  ]);

  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    fetchHomepage: async () => ({
      status: ANALYSIS_STATUS.COMPLETED,
      finalUrl: 'https://example.com',
      httpStatus: 200,
      httpsEnabled: true,
      responseTimeMs: 120,
      htmlSizeBytes: 4096,
      truncated: false,
      pageTitle: 'Acme',
      metaDescription: 'Acme site',
      viewportPresent: true,
      errorCode: null,
      errorMessage: null,
    }),
    fetchPageSpeed: async () => ({
      status: 'completed',
      performanceScore: 88,
      accessibilityScore: 91,
      seoScore: 100,
      bestPracticesScore: 96,
      mobileIndicator: 'mobile',
      raw: { lighthouseResult: { categories: {} } },
      errorCode: null,
      errorMessage: null,
    }),
  });

  assert.equal(row.analysis_status, 'completed');
  assert.equal(row.performance_score, 88);
  assert.equal(row.page_title, 'Acme');
  assert.equal(row.mobile_indicator, 'mobile');
  assert.equal(row.raw_analysis_response.pagespeed.status, 'completed');
});

test('analyzeBusinessWebsite: does not call PageSpeed when the homepage fetch itself failed', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://example.com', website_status: 'reachable' },
  ]);

  let pageSpeedCalled = false;
  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    fetchHomepage: async () => ({
      status: ANALYSIS_STATUS.TIMEOUT,
      finalUrl: 'https://example.com',
      httpStatus: null,
      httpsEnabled: null,
      responseTimeMs: 10000,
      htmlSizeBytes: null,
      truncated: false,
      pageTitle: null,
      metaDescription: null,
      viewportPresent: null,
      errorCode: 'TIMEOUT',
      errorMessage: 'timed out',
    }),
    fetchPageSpeed: async () => {
      pageSpeedCalled = true;
      return {};
    },
  });

  assert.equal(pageSpeedCalled, false);
  assert.equal(row.analysis_status, 'timeout');
  assert.equal(row.performance_score, null);
});

// ---------------------------------------------------------------------
// Regression coverage added in Phase 10D.1 (PageSpeed score extraction
// debug). Unlike the two tests above, these wire the REAL
// fetchPageSpeedInsights (from ../pagespeedInsights) into
// analyzeBusinessWebsite instead of a hand-rolled mock, so they exercise
// the full path: raw PSI JSON -> extractScores -> saveWebsiteAnalysis
// columns -> the returned row. This is the path a real end-to-end
// analysis (like the Peter Amor Beauty Salons run) actually takes.
// ---------------------------------------------------------------------

const completedHomepage = (overrides = {}) => ({
  status: ANALYSIS_STATUS.COMPLETED,
  finalUrl: 'https://www.petersalons.com/',
  httpStatus: 200,
  httpsEnabled: true,
  responseTimeMs: 1441,
  htmlSizeBytes: 2048,
  truncated: false,
  pageTitle: 'Peter Amor Beauty Salons, Barber & SPA',
  metaDescription: 'Beauty salon, barber and spa services.',
  viewportPresent: true,
  errorCode: null,
  errorMessage: null,
  ...overrides,
});

test('analyzeBusinessWebsite: real fetchPageSpeedInsights + a realistic PSI payload lands all four scores and mobile_indicator in the saved row', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://www.petersalons.com/', website_status: 'reachable' },
  ]);

  const psiBody = {
    lighthouseResult: {
      configSettings: { formFactor: 'mobile' },
      categories: {
        performance: { score: 0.64 },
        accessibility: { score: 0.97 },
        seo: { score: 1 },
        'best-practices': { score: 0.92 },
      },
    },
  };

  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    fetchHomepage: async () => completedHomepage(),
    fetchPageSpeed: (url, opts) =>
      fetchPageSpeedInsights(url, { ...opts, apiKey: 'test-key', fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(psiBody);
        },
      }) }),
  });

  assert.equal(row.analysis_status, 'completed');
  assert.equal(row.performance_score, 64);
  assert.equal(row.accessibility_score, 97);
  assert.equal(row.seo_score, 100);
  assert.equal(row.best_practices_score, 92);
  assert.equal(row.mobile_indicator, 'mobile');
  assert.equal(row.raw_analysis_response.pagespeed.status, 'completed');
});

test('analyzeBusinessWebsite: matches the real Peter Amor symptom -- homepage completed, PageSpeed side fails, every score stays null (not 0, not fabricated)', async () => {
  const pool = makeFakePool([
    { id: BUSINESS_ID, website_url: 'https://www.petersalons.com/', website_status: 'reachable' },
  ]);

  // Simulates PSI itself being unreachable/erroring for this call (e.g.
  // a timed-out or failed PSI request) while the homepage fetch, which
  // is a separate independent step, succeeded fine.
  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    fetchHomepage: async () => completedHomepage(),
    fetchPageSpeed: async (url, opts) =>
      fetchPageSpeedInsights(url, {
        ...opts,
        apiKey: 'test-key',
        timeoutMs: 5,
        fetchImpl: () =>
          new Promise((_resolve, reject) => {
            // never resolves before the abort fires
            setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 10);
          }),
      }),
  });

  // The homepage half of the analysis is genuinely complete and
  // genuinely all we have -- this is Phase 10A's existing, intentional
  // design (top-level analysis_status reflects the homepage fetch), not
  // a bug introduced here. The regression this test guards is narrower:
  // that a failed PageSpeed call NEVER produces a fabricated score.
  assert.equal(row.analysis_status, 'completed');
  assert.equal(row.http_status, 200);
  assert.equal(row.page_title, 'Peter Amor Beauty Salons, Barber & SPA');
  assert.equal(row.performance_score, null);
  assert.equal(row.accessibility_score, null);
  assert.equal(row.seo_score, null);
  assert.equal(row.best_practices_score, null);
  assert.equal(row.mobile_indicator, null);
  // The actual PageSpeed-side outcome is preserved for debugging, even
  // though it isn't surfaced in the top-level analysis_status column.
  assert.equal(row.raw_analysis_response.pagespeed.status, PAGESPEED_STATUS.TIMEOUT);
  assert.equal(row.raw_analysis_response.pagespeed.errorCode, 'TIMEOUT');
});

test('loadBusiness: returns null for an unknown id', async () => {
  const pool = makeFakePool([]);
  const result = await loadBusiness(pool, BUSINESS_ID);
  assert.equal(result, null);
});
