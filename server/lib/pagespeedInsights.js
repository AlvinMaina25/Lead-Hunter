/**
 * Server-side client for the Google PageSpeed Insights (PSI) API
 * (Phase 10A).
 *
 * SECURITY: this module is the ONLY place PAGESPEED_API_KEY is read. It
 * never runs in, or is imported by, frontend code, and the key is never
 * put in a response body or forwarded to the browser (mirrors the
 * pattern already used for GOOGLE_PLACES_API_KEY in googlePlaces.js).
 *
 * This module ONLY talks to Google's PSI API for a single already-
 * validated URL passed in by the caller. It performs no SSRF checks
 * itself and makes no decision about which businesses are eligible —
 * that's server/lib/websiteAnalysis.js's job. It never invents a score:
 * a Lighthouse category PSI didn't return comes back as `null`, not 0
 * or any other placeholder.
 *
 * Requires Node.js 18+ for global fetch/AbortController.
 */

'use strict';

const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * PSI can be slow — it runs a full headless-Chrome Lighthouse pass, not a
 * simple HTTP GET. Google's own client library examples set client-side
 * timeouts of 60s for this endpoint, and a run auditing four categories
 * (performance + accessibility + SEO + best-practices, as we request)
 * routinely takes well past 25s for real-world pages. A too-short timeout
 * here does not corrupt anything (fetchPageSpeedInsights below always
 * classifies it as PAGESPEED_STATUS.TIMEOUT rather than faking a score),
 * but it silently turns a slow-but-working PSI call into permanently-null
 * scores on every analysis. 55s leaves headroom under a 60s run timeout.
 */
const DEFAULT_TIMEOUT_MS = 55000;

/** Lighthouse categories we ask PSI to compute. */
const CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'SEO', 'BEST_PRACTICES'];

/** Mirrors website_analysis.analysis_status's vocabulary so both modules speak the same language. */
const PAGESPEED_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'blocked',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
});

/**
 * Builds the request URL. Kept as its own function so tests can assert
 * on exactly what gets sent without performing a real fetch.
 *
 * @param {string} targetUrl - already-validated absolute http(s) URL
 * @param {{ apiKey: string, strategy: string }} opts
 */
function buildRequestUrl(targetUrl, { apiKey, strategy }) {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  params.set('key', apiKey);
  params.set('strategy', strategy);
  for (const category of CATEGORIES) params.append('category', category);
  return `${PAGESPEED_ENDPOINT}?${params.toString()}`;
}

/**
 * Pulls only the measurable fields we care about out of a parsed PSI
 * response. Any category PSI omits is left `null` — never defaulted to
 * 0, which would misrepresent "not measured" as "measured and failing".
 *
 * @param {unknown} json - parsed PSI response body
 * @returns {{
 *   performanceScore: number|null,
 *   accessibilityScore: number|null,
 *   seoScore: number|null,
 *   bestPracticesScore: number|null,
 *   mobileIndicator: string|null,
 * }}
 */
function extractScores(json) {
  const categories = json && json.lighthouseResult && json.lighthouseResult.categories;

  const scoreOf = (category) => {
    const entry = categories && categories[category];
    const raw = entry && typeof entry.score === 'number' ? entry.score : null;
    return raw === null ? null : Math.round(raw * 100);
  };

  // PSI's ConfigSettings has carried the form factor under two different
  // field names across Lighthouse versions: `formFactor` is current, and
  // `emulatedFormFactor` is the older/deprecated name some Lighthouse
  // versions still populate instead of (or alongside) `formFactor`. We
  // prefer the current field but fall back to the deprecated one so a
  // response from either generation still yields the real reported value
  // rather than null. Never falls back to the `strategy` we *requested*
  // -- only ever reports what PSI actually returned.
  const configSettings =
    (json && json.lighthouseResult && json.lighthouseResult.configSettings) || null;
  const formFactor =
    (configSettings && (configSettings.formFactor || configSettings.emulatedFormFactor)) || null;

  return {
    performanceScore: scoreOf('performance'),
    accessibilityScore: scoreOf('accessibility'),
    seoScore: scoreOf('seo'),
    bestPracticesScore: scoreOf('best-practices'),
    mobileIndicator: typeof formFactor === 'string' ? formFactor : null,
  };
}

/**
 * Maps a non-2xx PSI HTTP response to one of PAGESPEED_STATUS's values.
 * PSI reports its own errors as `{ error: { code, message, status } }`.
 *
 * @param {number} httpStatus
 * @param {unknown} parsedBody - parsed JSON body, if it parsed at all
 */
function classifyHttpError(httpStatus, parsedBody) {
  const googleStatus = parsedBody && parsedBody.error && parsedBody.error.status;
  const errorCode = (googleStatus || `HTTP_${httpStatus}`).toString();
  const errorMessage =
    (parsedBody && parsedBody.error && parsedBody.error.message) ||
    `PageSpeed Insights request failed with HTTP ${httpStatus}.`;

  if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return { status: PAGESPEED_STATUS.RATE_LIMITED, errorCode, errorMessage };
  }
  if (httpStatus === 403 || googleStatus === 'PERMISSION_DENIED') {
    return { status: PAGESPEED_STATUS.BLOCKED, errorCode, errorMessage };
  }
  if (httpStatus >= 500) {
    return { status: PAGESPEED_STATUS.UNAVAILABLE, errorCode, errorMessage };
  }
  return { status: PAGESPEED_STATUS.FAILED, errorCode, errorMessage };
}

/**
 * Runs a PageSpeed Insights analysis for a single URL. Never throws —
 * every outcome (success, timeout, HTTP error, rate limit, malformed
 * response, missing API key) comes back as a normal return value so
 * callers can decide how to fold it into an overall analysis result.
 *
 * @param {string} targetUrl - an already-validated, absolute http(s) URL
 * @param {object} [options]
 * @param {string} [options.apiKey] - defaults to process.env.PAGESPEED_API_KEY
 * @param {string} [options.strategy] - 'mobile' (default) or 'desktop'
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @returns {Promise<{
 *   status: string,
 *   performanceScore: number|null,
 *   accessibilityScore: number|null,
 *   seoScore: number|null,
 *   bestPracticesScore: number|null,
 *   mobileIndicator: string|null,
 *   raw: unknown|null,
 *   errorCode: string|null,
 *   errorMessage: string|null,
 * }>}
 */
async function fetchPageSpeedInsights(targetUrl, options = {}) {
  const apiKey = options.apiKey || process.env.PAGESPEED_API_KEY;
  const strategy = options.strategy || 'mobile';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;

  const empty = {
    performanceScore: null,
    accessibilityScore: null,
    seoScore: null,
    bestPracticesScore: null,
    mobileIndicator: null,
    raw: null,
  };

  if (!apiKey) {
    return {
      ...empty,
      status: PAGESPEED_STATUS.UNAVAILABLE,
      errorCode: 'MISSING_API_KEY',
      errorMessage: 'PAGESPEED_API_KEY is not configured.',
    };
  }

  if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
    return {
      ...empty,
      status: PAGESPEED_STATUS.FAILED,
      errorCode: 'MISSING_URL',
      errorMessage: 'No URL was provided to analyze.',
    };
  }

  const requestUrl = buildRequestUrl(targetUrl, { apiKey, strategy });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(requestUrl, { method: 'GET', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return {
        ...empty,
        status: PAGESPEED_STATUS.TIMEOUT,
        errorCode: 'TIMEOUT',
        errorMessage: `PageSpeed Insights request timed out after ${timeoutMs}ms.`,
      };
    }
    return {
      ...empty,
      status: PAGESPEED_STATUS.UNAVAILABLE,
      errorCode: (err && err.code) || 'NETWORK_ERROR',
      errorMessage: (err && err.message) || 'Could not reach the PageSpeed Insights API.',
    };
  }
  clearTimeout(timer);

  const bodyText = await response.text();
  let parsed = null;
  let parseFailed = false;
  try {
    parsed = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    const classified = classifyHttpError(response.status, parseFailed ? null : parsed);
    return { ...empty, raw: parseFailed ? null : parsed, ...classified };
  }

  if (parseFailed || !parsed || typeof parsed !== 'object') {
    return {
      ...empty,
      status: PAGESPEED_STATUS.FAILED,
      errorCode: 'MALFORMED_RESPONSE',
      errorMessage: 'PageSpeed Insights returned a response that could not be parsed as JSON.',
    };
  }

  if (!parsed.lighthouseResult) {
    // PSI returned 200 with a body, but no lighthouseResult — e.g. the
    // target could not be loaded/rendered by PSI's own crawler. We
    // still have a raw body worth keeping for debugging, but there are
    // no scores to extract, so every score stays null rather than 0.
    return {
      ...empty,
      raw: parsed,
      status: PAGESPEED_STATUS.FAILED,
      errorCode: 'NO_LIGHTHOUSE_RESULT',
      errorMessage: 'PageSpeed Insights did not return a Lighthouse result for this URL.',
    };
  }

  return {
    ...extractScores(parsed),
    raw: parsed,
    status: PAGESPEED_STATUS.COMPLETED,
    errorCode: null,
    errorMessage: null,
  };
}

module.exports = {
  PAGESPEED_STATUS,
  DEFAULT_TIMEOUT_MS,
  buildRequestUrl,
  extractScores,
  classifyHttpError,
  fetchPageSpeedInsights,
};
