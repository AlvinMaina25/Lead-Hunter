/**
 * Website analysis engine (Phase 10A).
 *
 * For a single business whose `website_status` is already 'reachable'
 * (as determined by Phase 9's checkWebsiteReachability), this module:
 *
 *   1. Loads the business from Neon and re-reads its stored
 *      `website_url` — it NEVER accepts a URL from a caller/route.
 *   2. Re-runs Phase 9's URL normalization
 *      (server/lib/websiteCheck.js#normalizeWebsiteUrlForCheck) and
 *      Phase 9's SSRF guard (server/lib/ssrfGuard.js) before opening
 *      any socket, exactly like server/lib/httpChecker.js does. This
 *      module does not modify or duplicate httpChecker.js — it reuses
 *      the same underlying SSRF primitives directly.
 *   3. Makes exactly ONE homepage GET request (following ordinary
 *      redirects, each of which is re-validated by the SSRF guard —
 *      never an unvalidated redirect), bounded by a byte cap and a
 *      timeout. It never crawls links and never downloads more than
 *      MAX_HTML_BYTES of the response body.
 *   4. Extracts only measurable facts from the response: HTTP status,
 *      response time, bytes read, final URL, HTTPS-ness, <title>,
 *      meta description, and whether a viewport meta tag is present.
 *      A missing tag is recorded as `null`/`false` — a real finding,
 *      never invented content.
 *   5. Optionally layers in Google PageSpeed Insights scores via
 *      server/lib/pagespeedInsights.js (only when the homepage fetch
 *      itself succeeded — no point spending a PSI call on a URL we
 *      already know is down).
 *   6. Persists exactly one row to `website_analysis`
 *      (migrations/003_website_analysis_results.sql).
 *   7. Best-effort contact extraction (contactService.js): from the
 *      homepage HTML already fetched in step 3, plus at most ONE more
 *      same-site page (a contact page) fetched through the same
 *      SSRF-guarded safeFetchHomepage. Runs AFTER the row in step 6 is
 *      saved and can never throw, so it cannot fail or downgrade an
 *      analysis.
 *
 * No LLM/AI is used anywhere in this module to generate or guess at a
 * metric. Every stored field is either read directly off the wire or
 * left null when it wasn't observed.
 */

'use strict';

const nodeHttp = require('node:http');
const nodeHttps = require('node:https');

const { normalizeWebsiteUrlForCheck, WEBSITE_STATUS } = require('./websiteCheck');
const {
  ALLOWED_PROTOCOLS,
  SSRF_REASON,
  hasBlockedScheme,
  isBlockedPort,
  resolvePublicAddresses,
  makePinnedLookup,
} = require('./ssrfGuard');
const { fetchPageSpeedInsights } = require('./pagespeedInsights');
const { extractAndStoreContacts } = require('./contactService');

/** The complete, DB-enforced vocabulary for website_analysis.analysis_status. */
const ANALYSIS_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'blocked',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
});

/** Homepage fetch timeout — reasonable for a single-page GET. */
const DEFAULT_TIMEOUT_MS = 10000;

/** Never read more than this many bytes of homepage HTML (no large-resource downloads). */
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB

/** Same bound as Phase 9's httpChecker — a redirect chain this long is treated as a dead end. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS_CODES = new Set([300, 301, 302, 303, 307, 308]);

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown only for programmer error (e.g. a bad businessId type), not for ordinary analysis outcomes. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------
// HTML extraction — regex-based on purpose: homepage HTML from
// arbitrary third-party sites is not assumed to be well-formed, so we
// look for the specific tags we need rather than fully parsing the
// document. Anything not found comes back as null/false.
// ---------------------------------------------------------------------

/**
 * @param {string} html
 * @returns {string|null} the decoded, trimmed contents of the first
 *   <title> tag, or null if there isn't one (or it's empty).
 */
function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const collapsed = match[1].replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Finds a `<meta ...>` tag whose `name` attribute matches (case
 * insensitively) and returns its `content` attribute value, regardless
 * of attribute order. Returns null if no such tag, or no content
 * attribute, is found.
 *
 * @param {string} html
 * @param {string} name - e.g. 'description' or 'viewport'
 * @returns {string|null}
 */
function extractMetaContent(html, name) {
  const metaTagPattern = /<meta\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = metaTagPattern.exec(html)) !== null) {
    const tag = tagMatch[0];
    const nameMatch = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!nameMatch || nameMatch[1].trim().toLowerCase() !== name) continue;
    const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!contentMatch) return null;
    const trimmed = contentMatch[1].trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * @param {string} html
 * @returns {boolean} true if a <meta name="viewport"> tag is present at all.
 */
function hasViewportTag(html) {
  const metaTagPattern = /<meta\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = metaTagPattern.exec(html)) !== null) {
    const nameMatch = /\bname\s*=\s*["']([^"']*)["']/i.exec(tagMatch[0]);
    if (nameMatch && nameMatch[1].trim().toLowerCase() === 'viewport') return true;
  }
  return false;
}

/**
 * Extracts every measurable homepage signal this module stores, from
 * whatever HTML was actually read (possibly truncated at the byte cap
 * — that's fine, we only need the <head>).
 *
 * @param {string} html
 * @returns {{ pageTitle: string|null, metaDescription: string|null, viewportPresent: boolean }}
 */
function extractHomepageSignals(html) {
  return {
    pageTitle: extractTitle(html),
    metaDescription: extractMetaContent(html, 'description'),
    viewportPresent: hasViewportTag(html),
  };
}

// ---------------------------------------------------------------------
// SSRF gate — thin composition of ssrfGuard's exported primitives.
// Mirrors httpChecker.js's internal gateUrl() so a redirect target is
// never held to a lower bar than the original URL, without importing
// or modifying httpChecker.js itself.
// ---------------------------------------------------------------------

/**
 * @param {string} candidateUrl - an already-absolute URL
 * @param {Function} [lookup] - injectable DNS resolver (tests only)
 * @returns {Promise<
 *   | { ok: true, url: string, protocol: string, addresses: Array<{address: string, family: number}> }
 *   | { ok: false, kind: 'blocked' }
 *   | { ok: false, kind: 'dns_failure', error: Error }
 * >}
 */
async function gateUrl(candidateUrl, lookup) {
  if (hasBlockedScheme(candidateUrl)) {
    return { ok: false, kind: 'blocked' };
  }

  let parsed;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return { ok: false, kind: 'blocked' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, kind: 'blocked' };
  }

  if (isBlockedPort(parsed.port)) {
    return { ok: false, kind: 'blocked' };
  }

  const resolution = await resolvePublicAddresses(parsed.hostname, lookup);
  if (!resolution.ok) {
    if (resolution.reason === SSRF_REASON.DNS_FAILURE) {
      return { ok: false, kind: 'dns_failure', error: resolution.error };
    }
    return { ok: false, kind: 'blocked' };
  }

  return { ok: true, url: candidateUrl, protocol: parsed.protocol, addresses: resolution.addresses };
}

/**
 * Classifies a low-level request/socket error into an ANALYSIS_STATUS
 * value. Anything unrecognized is 'failed' rather than guessed at.
 *
 * @param {Error & { code?: string }} err
 */
function classifyRequestError(err) {
  if (!err) return ANALYSIS_STATUS.FAILED;
  if (err.__isTimeout) return ANALYSIS_STATUS.TIMEOUT;
  const code = typeof err.code === 'string' ? err.code : '';
  if (DNS_ERROR_CODES.has(code)) return ANALYSIS_STATUS.UNAVAILABLE;
  if (CONNECTION_ERROR_CODES.has(code)) return ANALYSIS_STATUS.UNAVAILABLE;
  if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS')) return ANALYSIS_STATUS.UNAVAILABLE;
  return ANALYSIS_STATUS.FAILED;
}

/**
 * Makes one GET request to `targetUrl` via already-pinned `addresses`.
 * For a redirect response, the body is never read (we don't need it —
 * we're not crawling). For a final (non-redirect) response, the body
 * is read up to `maxBytes` and then the socket is closed early — we
 * never download more than that regardless of Content-Length.
 *
 * @returns {Promise<
 *   | { type: 'redirect', statusCode: number, location: string }
 *   | { type: 'final', statusCode: number, body: string, bytesRead: number, truncated: boolean, elapsedMs: number }
 *   | { type: 'error', error: Error, elapsedMs: number }
 * >}
 */
function requestOnce(targetUrl, protocol, addresses, { timeoutMs, maxBytes, httpModule, httpsModule }) {
  const client = protocol === 'https:' ? httpsModule : httpModule;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = client.request(
        targetUrl,
        {
          method: 'GET',
          timeout: timeoutMs,
          lookup: makePinnedLookup(addresses),
          headers: {
            'User-Agent': 'AlvinLeadHunter-WebsiteAnalyzer/1.0',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          },
        },
        (res) => {
          const statusCode = res.statusCode;
          const headers = res.headers || {};
          const location = headers.location || headers.Location;
          const isRedirect =
            REDIRECT_STATUS_CODES.has(statusCode) && typeof location === 'string' && location.length > 0;

          if (isRedirect) {
            // No need to read a redirect's body at all.
            res.destroy();
            finish({ type: 'redirect', statusCode, location });
            return;
          }

          let body = '';
          let bytesRead = 0;
          let truncated = false;
          res.setEncoding('utf8');

          res.on('data', (chunk) => {
            if (truncated) return; // already stopped accepting data
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            if (bytesRead + chunkBytes > maxBytes) {
              const allowed = Math.max(0, maxBytes - bytesRead);
              body += chunk.slice(0, allowed);
              bytesRead += allowed;
              truncated = true;
              res.destroy(); // stop downloading — cap enforced
              return;
            }
            body += chunk;
            bytesRead += chunkBytes;
          });

          const finalize = () =>
            finish({ type: 'final', statusCode, body, bytesRead, truncated, elapsedMs: Date.now() - startedAt });

          res.on('end', finalize);
          // Destroying after hitting the cap ends the stream without
          // an 'end' event on some Node versions — 'close' always fires.
          res.on('close', finalize);
          res.on('error', (err) => finish({ type: 'error', error: err, elapsedMs: Date.now() - startedAt }));
        }
      );
    } catch (err) {
      finish({ type: 'error', error: err, elapsedMs: Date.now() - startedAt });
      return;
    }

    req.on('timeout', () => {
      const timeoutError = new Error(`Homepage analysis request timed out after ${timeoutMs}ms`);
      timeoutError.__isTimeout = true;
      req.destroy(timeoutError);
    });

    req.on('error', (err) => finish({ type: 'error', error: err, elapsedMs: Date.now() - startedAt }));

    req.end();
  });
}

/**
 * Safely fetches a single business homepage: SSRF-gates the URL (and
 * every redirect hop), makes the request, and returns a fully
 * classified, measurable-only result. Never throws.
 *
 * @param {string} rawUrl - businesses.website_url, as stored (may be schemeless)
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {Function} [options.lookup] - injectable DNS resolver (tests only)
 * @param {object} [options.httpModule] - injectable replacement for node:http (tests only)
 * @param {object} [options.httpsModule] - injectable replacement for node:https (tests only)
 * @returns {Promise<{
 *   status: string,
 *   finalUrl: string|null,
 *   httpStatus: number|null,
 *   httpsEnabled: boolean|null,
 *   responseTimeMs: number|null,
 *   htmlSizeBytes: number|null,
 *   truncated: boolean,
 *   pageTitle: string|null,
 *   metaDescription: string|null,
 *   viewportPresent: boolean|null,
 *   html: string|null,   // the (possibly truncated) body, in memory only -- never persisted
 *   errorCode: string|null,
 *   errorMessage: string|null,
 * }>}
 */
async function safeFetchHomepage(rawUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_HTML_BYTES;
  const httpModule = options.httpModule || nodeHttp;
  const httpsModule = options.httpsModule || nodeHttps;
  const lookup = options.lookup;

  const blankResult = {
    finalUrl: null,
    httpStatus: null,
    httpsEnabled: null,
    responseTimeMs: null,
    htmlSizeBytes: null,
    truncated: false,
    pageTitle: null,
    metaDescription: null,
    viewportPresent: null,
    html: null,
  };

  if (typeof rawUrl === 'string' && hasBlockedScheme(rawUrl)) {
    return {
      ...blankResult,
      status: ANALYSIS_STATUS.BLOCKED,
      errorCode: 'BLOCKED_SCHEME',
      errorMessage: 'The stored URL uses a scheme that is never analyzed.',
    };
  }

  const normalized = normalizeWebsiteUrlForCheck(rawUrl);
  if (!normalized.ok) {
    return {
      ...blankResult,
      status: ANALYSIS_STATUS.UNAVAILABLE,
      errorCode: 'URL_UNUSABLE',
      errorMessage: 'The stored website_url could not be normalized into a checkable URL.',
    };
  }

  let gated = await gateUrl(normalized.url, lookup);
  if (!gated.ok) {
    if (gated.kind === 'dns_failure') {
      return {
        ...blankResult,
        finalUrl: normalized.url,
        status: ANALYSIS_STATUS.UNAVAILABLE,
        errorCode: (gated.error && gated.error.code) || 'DNS_FAILURE',
        errorMessage: 'DNS resolution failed for the stored website_url.',
      };
    }
    return {
      ...blankResult,
      finalUrl: normalized.url,
      status: ANALYSIS_STATUS.BLOCKED,
      errorCode: 'SSRF_BLOCKED',
      errorMessage: 'The target address is not permitted for analysis.',
    };
  }

  let currentUrl = gated.url;
  let hops = 0;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await requestOnce(currentUrl, gated.protocol, gated.addresses, {
      timeoutMs,
      maxBytes,
      httpModule,
      httpsModule,
    });

    if (outcome.type === 'error') {
      return {
        ...blankResult,
        finalUrl: currentUrl,
        responseTimeMs: outcome.elapsedMs,
        status: classifyRequestError(outcome.error),
        errorCode: (outcome.error && outcome.error.code) || (outcome.error && outcome.error.__isTimeout ? 'TIMEOUT' : 'REQUEST_ERROR'),
        errorMessage: (outcome.error && outcome.error.message) || 'The homepage request failed.',
      };
    }

    if (outcome.type === 'redirect') {
      if (hops >= MAX_REDIRECTS) {
        return {
          ...blankResult,
          finalUrl: currentUrl,
          httpStatus: outcome.statusCode,
          status: ANALYSIS_STATUS.UNAVAILABLE,
          errorCode: 'TOO_MANY_REDIRECTS',
          errorMessage: `Exceeded ${MAX_REDIRECTS} redirects while trying to reach the homepage.`,
        };
      }
      hops += 1;

      let nextAbsolute;
      try {
        nextAbsolute = new URL(outcome.location, currentUrl).toString();
      } catch {
        return {
          ...blankResult,
          finalUrl: currentUrl,
          httpStatus: outcome.statusCode,
          status: ANALYSIS_STATUS.UNAVAILABLE,
          errorCode: 'MALFORMED_REDIRECT',
          errorMessage: 'The server sent a redirect with an unusable Location header.',
        };
      }

      // eslint-disable-next-line no-await-in-loop
      gated = await gateUrl(nextAbsolute, lookup);
      if (!gated.ok) {
        if (gated.kind === 'dns_failure') {
          return {
            ...blankResult,
            finalUrl: nextAbsolute,
            status: ANALYSIS_STATUS.UNAVAILABLE,
            errorCode: (gated.error && gated.error.code) || 'DNS_FAILURE',
            errorMessage: 'DNS resolution failed for a redirect target.',
          };
        }
        return {
          ...blankResult,
          finalUrl: nextAbsolute,
          status: ANALYSIS_STATUS.BLOCKED,
          errorCode: 'SSRF_BLOCKED_REDIRECT',
          errorMessage: 'A redirect target is not permitted for analysis.',
        };
      }

      currentUrl = gated.url;
      continue;
    }

    // outcome.type === 'final'
    const signals = extractHomepageSignals(outcome.body);
    let finalProtocol = gated.protocol;
    try {
      finalProtocol = new URL(currentUrl).protocol;
    } catch {
      /* keep gated.protocol */
    }

    return {
      finalUrl: currentUrl,
      httpStatus: outcome.statusCode,
      httpsEnabled: finalProtocol === 'https:',
      responseTimeMs: outcome.elapsedMs,
      htmlSizeBytes: outcome.bytesRead,
      truncated: outcome.truncated,
      pageTitle: signals.pageTitle,
      metaDescription: signals.metaDescription,
      viewportPresent: signals.viewportPresent,
      // Kept so contact extraction can reuse this response instead of
      // fetching the homepage a second time. Not written to the DB.
      html: outcome.body,
      status: ANALYSIS_STATUS.COMPLETED,
      errorCode: null,
      errorMessage: null,
    };
  }
}

// ---------------------------------------------------------------------
// Orchestration: load business -> analyze -> persist
// ---------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @returns {Promise<{id: string, website_url: string|null, website_status: string}|null>}
 */
async function loadBusiness(pool, businessId) {
  const { rows } = await pool.query(
    `SELECT id, website_url, website_status FROM businesses WHERE id = $1`,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * Inserts one row into website_analysis and returns it.
 *
 * @param {{query: Function}} pool
 * @param {object} result - see buildResultRow's return shape
 */
async function saveWebsiteAnalysis(pool, result) {
  const { rows } = await pool.query(
    `
      INSERT INTO website_analysis (
        business_id, analyzed_url, analyzed_at,
        performance_score, accessibility_score, seo_score, best_practices_score, mobile_indicator,
        https_enabled, page_title, meta_description, viewport_present,
        html_size_bytes, response_time_ms, http_status,
        raw_analysis_response, analysis_status, error_code, error_message
      ) VALUES (
        $1, $2, now(),
        $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17, $18
      )
      RETURNING *
    `,
    [
      result.businessId,
      result.analyzedUrl,
      result.performanceScore,
      result.accessibilityScore,
      result.seoScore,
      result.bestPracticesScore,
      result.mobileIndicator,
      result.httpsEnabled,
      result.pageTitle,
      result.metaDescription,
      result.viewportPresent,
      result.htmlSizeBytes,
      result.responseTimeMs,
      result.httpStatus,
      result.rawAnalysisResponse ? JSON.stringify(result.rawAnalysisResponse) : null,
      result.analysisStatus,
      result.errorCode,
      result.errorMessage,
    ]
  );
  return rows[0];
}

/**
 * Runs the full Phase 10A analysis for one business and persists the
 * result. Only ever analyzes businesses whose `website_status` is
 * already 'reachable'; every other case is recorded as 'unavailable'
 * without any network request being made.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @param {{
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   lookup?: Function,
 *   httpModule?: object,
 *   httpsModule?: object,
 *   fetchHomepage?: Function,
 *   fetchPageSpeed?: Function,
 *   skipPageSpeed?: boolean,
 *   pageSpeedOptions?: object,
 *   skipContacts?: boolean,
 * }} [options]
 * @returns {Promise<object>} the inserted website_analysis row
 * @throws {NotFoundError} if no business has that id
 * @throws {ValidationError} if businessId isn't a syntactically valid UUID
 */
async function analyzeBusinessWebsite(pool, businessId, options = {}) {
  if (!UUID_PATTERN.test(String(businessId))) {
    throw new ValidationError('businessId must be a valid UUID.');
  }

  const business = await loadBusiness(pool, businessId);
  if (!business) {
    throw new NotFoundError(`No business found with id ${businessId}`);
  }

  const fetchHomepage = options.fetchHomepage || safeFetchHomepage;
  const fetchPageSpeed = options.fetchPageSpeed || fetchPageSpeedInsights;

  // Only businesses already marked 'reachable' by Phase 9 are eligible.
  // No network request is made otherwise.
  if (business.website_status !== WEBSITE_STATUS.REACHABLE) {
    return saveWebsiteAnalysis(pool, {
      businessId: business.id,
      analyzedUrl: business.website_url || '',
      performanceScore: null,
      accessibilityScore: null,
      seoScore: null,
      bestPracticesScore: null,
      mobileIndicator: null,
      httpsEnabled: null,
      pageTitle: null,
      metaDescription: null,
      viewportPresent: null,
      htmlSizeBytes: null,
      responseTimeMs: null,
      httpStatus: null,
      rawAnalysisResponse: null,
      analysisStatus: ANALYSIS_STATUS.UNAVAILABLE,
      errorCode: 'NOT_REACHABLE',
      errorMessage: `Business website_status is '${business.website_status}', not 'reachable'; skipping analysis.`,
    });
  }

  const homepage = await fetchHomepage(business.website_url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    lookup: options.lookup,
    httpModule: options.httpModule,
    httpsModule: options.httpsModule,
  });

  let pageSpeed = null;
  if (!options.skipPageSpeed && homepage.status === ANALYSIS_STATUS.COMPLETED) {
    pageSpeed = await fetchPageSpeed(homepage.finalUrl || business.website_url, options.pageSpeedOptions || {});
  }

  const rawAnalysisResponse = {
    homepage: {
      finalUrl: homepage.finalUrl,
      httpStatus: homepage.httpStatus,
      truncated: homepage.truncated,
      errorCode: homepage.errorCode,
      errorMessage: homepage.errorMessage,
    },
    pagespeed: pageSpeed
      ? {
          status: pageSpeed.status,
          errorCode: pageSpeed.errorCode,
          errorMessage: pageSpeed.errorMessage,
          raw: pageSpeed.raw,
        }
      : null,
  };

  const savedRow = await saveWebsiteAnalysis(pool, {
    businessId: business.id,
    analyzedUrl: homepage.finalUrl || normalizeWebsiteUrlForCheck(business.website_url).url || business.website_url,
    performanceScore: pageSpeed ? pageSpeed.performanceScore : null,
    accessibilityScore: pageSpeed ? pageSpeed.accessibilityScore : null,
    seoScore: pageSpeed ? pageSpeed.seoScore : null,
    bestPracticesScore: pageSpeed ? pageSpeed.bestPracticesScore : null,
    mobileIndicator: pageSpeed ? pageSpeed.mobileIndicator : null,
    httpsEnabled: homepage.httpsEnabled,
    pageTitle: homepage.pageTitle,
    metaDescription: homepage.metaDescription,
    viewportPresent: homepage.viewportPresent,
    htmlSizeBytes: homepage.htmlSizeBytes,
    responseTimeMs: homepage.responseTimeMs,
    httpStatus: homepage.httpStatus,
    rawAnalysisResponse,
    analysisStatus: homepage.status,
    errorCode: homepage.errorCode,
    errorMessage: homepage.errorMessage,
  });

  // Step 7: best-effort contacts. extractAndStoreContacts never throws,
  // and the analysis row is already saved, so nothing here can fail or
  // downgrade the analysis. Only runs when real homepage HTML exists.
  if (!options.skipContacts && homepage.status === ANALYSIS_STATUS.COMPLETED && typeof homepage.html === 'string') {
    await extractAndStoreContacts(pool, {
      businessId: business.id,
      homepage,
      fetchPage: fetchHomepage,
      fetchOptions: { lookup: options.lookup, httpModule: options.httpModule, httpsModule: options.httpsModule },
    });
  }

  return savedRow;
}

module.exports = {
  ANALYSIS_STATUS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_HTML_BYTES,
  MAX_REDIRECTS,
  NotFoundError,
  ValidationError,
  extractTitle,
  extractMetaContent,
  hasViewportTag,
  extractHomepageSignals,
  safeFetchHomepage,
  loadBusiness,
  saveWebsiteAnalysis,
  analyzeBusinessWebsite,
};
