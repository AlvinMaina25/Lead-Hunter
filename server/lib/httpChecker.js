/**
 * Website reachability checker (Phase 9B1).
 *
 * Makes a single lightweight HTTP/HTTPS request to a business's website
 * URL and classifies the outcome. This module does NOT crawl the site,
 * does NOT follow links, and does NOT download response bodies — it
 * only needs the status line, so the response stream is destroyed the
 * instant headers arrive.
 *
 * Reuses `normalizeWebsiteUrlForCheck` from Phase 9A (server/lib/websiteCheck.js)
 * so URL handling stays in one place; this module is only responsible
 * for the network request and outcome classification.
 *
 * SSRF protection (Phase 9B2): before any socket is opened the URL's
 * protocol is verified, its hostname is resolved, and every resolved
 * address must be public (see ssrfGuard.js). The connection is then
 * pinned to the validated address so a second DNS answer can't redirect
 * it.
 *
 * Redirect handling (Phase 9B3): ordinary HTTP/HTTPS redirects (3xx with
 * a Location header) are now followed, up to MAX_REDIRECTS hops. EVERY
 * redirect destination goes through the exact same SSRF gate as the
 * original URL before it is ever connected to — blocked scheme, blocked
 * hostname, or a resolved address that isn't public all stop the chain
 * immediately (a site cannot bounce the checker to 127.0.0.1, a private
 * IP, or any other internal target by redirecting to it). Exceeding
 * MAX_REDIRECTS is treated as unreachable rather than followed further.
 */

'use strict';

const nodeHttp = require('node:http');
const nodeHttps = require('node:https');
const { normalizeWebsiteUrlForCheck } = require('./websiteCheck');
const {
  ALLOWED_PROTOCOLS,
  SSRF_REASON,
  hasBlockedScheme,
  isBlockedPort,
  resolvePublicAddresses,
  makePinnedLookup,
} = require('./ssrfGuard');

/** Default socket/response timeout for the reachability check. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Maximum number of redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

/** Status codes treated as a redirect when a Location header is present. */
const REDIRECT_STATUS_CODES = new Set([300, 301, 302, 303, 307, 308]);

/**
 * The three outcomes this checker can report. Intentionally the same
 * vocabulary as the subset of WEBSITE_STATUS in websiteCheck.js that a
 * network check can actually produce (it never returns NO_WEBSITE —
 * that's decided before a check is ever attempted).
 */
const CHECK_STATUS = Object.freeze({
  REACHABLE: 'reachable',
  UNREACHABLE: 'unreachable',
  UNKNOWN: 'unknown',
});

/** DNS resolution failures -> unreachable. */
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);

/** Connection-level failures -> unreachable. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'ETIMEDOUT', // low-level connect timeout surfaced as an error code
]);

/** TLS/certificate failures -> unreachable. */
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * Classifies a request/socket error into one of the three check
 * statuses. Anything we don't specifically recognize is left as
 * 'unknown' rather than guessed at as unreachable, per the "unable to
 * safely determine" rule.
 *
 * @param {Error & { code?: string }} err
 * @returns {string} one of CHECK_STATUS's values
 */
function classifyError(err) {
  if (!err) return CHECK_STATUS.UNKNOWN;

  const code = typeof err.code === 'string' ? err.code : '';

  if (err.__isTimeout) return CHECK_STATUS.UNREACHABLE;
  if (DNS_ERROR_CODES.has(code)) return CHECK_STATUS.UNREACHABLE;
  if (CONNECTION_ERROR_CODES.has(code)) return CHECK_STATUS.UNREACHABLE;
  if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS')) {
    return CHECK_STATUS.UNREACHABLE;
  }

  return CHECK_STATUS.UNKNOWN;
}

/**
 * Bounds a promise by `ms`. On expiry resolves to a DNS_FAILURE-shaped
 * result carrying a timeout error, which classifyError maps to
 * 'unreachable' (same as a request timeout).
 *
 * @param {Promise<object>} promise
 * @param {number} ms
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const error = new Error(`DNS resolution timed out after ${ms}ms`);
      error.__isTimeout = true;
      resolve({ ok: false, reason: SSRF_REASON.DNS_FAILURE, error });
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Makes exactly one GET request to `targetUrl` via already-pinned
 * `addresses` and resolves with the outcome — never rejects. Never
 * reads or returns the response body; the stream is destroyed the
 * instant headers/status arrive.
 *
 * @param {string} targetUrl
 * @param {string} protocol - 'http:' or 'https:'
 * @param {Array<{address: string, family: number}>} addresses
 * @param {{ timeoutMs: number, httpModule: object, httpsModule: object }} opts
 * @returns {Promise<
 *   | { type: 'response', statusCode: number, headers: object }
 *   | { type: 'error', error: Error }
 * >}
 */
function requestOnce(targetUrl, protocol, addresses, { timeoutMs, httpModule, httpsModule }) {
  const client = protocol === 'https:' ? httpsModule : httpModule;

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
          // Connect only to the address(es) validated for THIS hop.
          lookup: makePinnedLookup(addresses),
          headers: {
            'User-Agent': 'AlvinLeadHunter-WebsiteChecker/1.0',
          },
        },
        (res) => {
          const statusCode = res.statusCode;
          const headers = res.headers || {};
          // Never download the body — destroy the stream the moment
          // headers/status are available.
          res.destroy();
          finish({ type: 'response', statusCode, headers });
        }
      );
    } catch (err) {
      finish({ type: 'error', error: err });
      return;
    }

    req.on('timeout', () => {
      const timeoutError = new Error(`Website check timed out after ${timeoutMs}ms`);
      timeoutError.__isTimeout = true;
      // Destroying triggers the 'error' handler below, which resolves the promise.
      req.destroy(timeoutError);
    });

    req.on('error', (err) => {
      finish({ type: 'error', error: err });
    });

    req.end();
  });
}

/**
 * Runs the full SSRF gate (blocked scheme -> normalize/parse -> allowed
 * protocol -> DNS resolution -> every address public) against a single
 * candidate URL. Used identically for the original URL and for every
 * redirect hop, so a redirect target is never held to a lower bar than
 * the URL that was actually stored.
 *
 * @param {string} candidateUrl - an already-absolute URL
 * @param {Function} [lookup] - injectable DNS resolver
 * @param {number} timeoutMs
 * @returns {Promise<
 *   | { ok: true, url: string, protocol: string, addresses: Array<{address: string, family: number}> }
 *   | { ok: false, kind: 'blocked' }
 *   | { ok: false, kind: 'dns_failure', error: Error }
 * >}
 */
async function gateUrl(candidateUrl, lookup, timeoutMs) {
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

  const resolution = await withTimeout(resolvePublicAddresses(parsed.hostname, lookup), timeoutMs);
  if (!resolution.ok) {
    if (resolution.reason === SSRF_REASON.DNS_FAILURE) {
      return { ok: false, kind: 'dns_failure', error: resolution.error };
    }
    // Localhost / private / internal / reserved target: never connect.
    return { ok: false, kind: 'blocked' };
  }

  // Return the candidate exactly as given (not `parsed.toString()`), so a
  // well-formed input URL isn't silently reserialized (e.g. gaining a
  // trailing "/"). Redirect targets passed in here are already absolute,
  // freshly-built URLs, so this preserves their form too.
  return { ok: true, url: candidateUrl, protocol: parsed.protocol, addresses: resolution.addresses };
}

/**
 * Checks whether a website is reachable by making a GET request and
 * looking only at whether/how the server responded, following ordinary
 * HTTP/HTTPS redirects up to MAX_REDIRECTS hops along the way. Never
 * reads or returns any response body.
 *
 * Every redirect destination — including ones reached after several
 * hops — is passed back through the full SSRF gate (protocol,
 * hostname, resolved addresses) before it is connected to, exactly as
 * the original URL is. A chain that redirects to a blocked target never
 * reaches it; a chain longer than MAX_REDIRECTS is abandoned rather
 * than followed further.
 *
 * Status rules:
 *  - reachable:   the final response in the chain is a non-redirect
 *                 HTTP response (200, 403, 404, 500, a redirect with no
 *                 Location header, etc.) — the server is up and
 *                 answering.
 *  - unreachable: DNS failure, connection failure, timeout, TLS
 *                 failure, or MAX_REDIRECTS was exceeded, at any hop.
 *  - unknown:     the URL (original or a redirect target) couldn't
 *                 safely be checked at all — missing, malformed, a
 *                 non-http(s) protocol, or a localhost / private /
 *                 internal / reserved target blocked by the SSRF guard
 *                 — or an unrecognized low-level error occurred.
 *
 * @param {unknown} rawUrl - a website URL, as stored (may be schemeless)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - request timeout in ms (default 8000), applied per hop
 * @param {object} [options.httpModule] - injectable replacement for node:http (tests only)
 * @param {object} [options.httpsModule] - injectable replacement for node:https (tests only)
 * @param {Function} [options.lookup] - injectable async DNS resolver returning [{address, family}] (tests only)
 * @returns {Promise<{ status: string, httpStatus: number|null, finalUrl: string|null }>}
 */
async function checkWebsiteReachability(rawUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const httpModule = options.httpModule || nodeHttp;
  const httpsModule = options.httpsModule || nodeHttps;
  const lookup = options.lookup;

  const blocked = { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null };

  // Reject file:, ftp:, javascript:, data:, etc. before anything else.
  if (typeof rawUrl === 'string' && hasBlockedScheme(rawUrl)) {
    return blocked;
  }

  const normalized = normalizeWebsiteUrlForCheck(rawUrl);
  if (!normalized.ok) {
    // Missing, invalid-protocol, or malformed: we cannot safely attempt
    // a network request at all.
    return blocked;
  }

  let gated = await gateUrl(normalized.url, lookup, timeoutMs);
  if (!gated.ok) {
    if (gated.kind === 'dns_failure') {
      return { status: classifyError(gated.error), httpStatus: null, finalUrl: normalized.url };
    }
    return blocked;
  }

  let currentUrl = gated.url;
  let hops = 0;

  for (;;) {
    const outcome = await requestOnce(currentUrl, gated.protocol, gated.addresses, {
      timeoutMs,
      httpModule,
      httpsModule,
    });

    if (outcome.type === 'error') {
      return { status: classifyError(outcome.error), httpStatus: null, finalUrl: currentUrl };
    }

    const { statusCode, headers } = outcome;
    const location = headers && (headers.location || headers.Location);
    const isRedirect = REDIRECT_STATUS_CODES.has(statusCode) && typeof location === 'string' && location.length > 0;

    if (!isRedirect) {
      return { status: CHECK_STATUS.REACHABLE, httpStatus: statusCode, finalUrl: currentUrl };
    }

    if (hops >= MAX_REDIRECTS) {
      // Too many redirects: give up rather than follow indefinitely.
      return { status: CHECK_STATUS.UNREACHABLE, httpStatus: statusCode, finalUrl: currentUrl };
    }
    hops += 1;

    let nextAbsolute;
    try {
      nextAbsolute = new URL(location, currentUrl).toString();
    } catch {
      // Malformed Location header: can't safely determine where this leads.
      return blocked;
    }

    // eslint-disable-next-line no-await-in-loop
    gated = await gateUrl(nextAbsolute, lookup, timeoutMs);
    if (!gated.ok) {
      if (gated.kind === 'dns_failure') {
        return { status: classifyError(gated.error), httpStatus: null, finalUrl: nextAbsolute };
      }
      // Redirect target is localhost / private / internal / reserved,
      // has a blocked scheme, or has an invalid protocol: never connect.
      return blocked;
    }

    currentUrl = gated.url;
  }
}

module.exports = {
  CHECK_STATUS,
  DEFAULT_TIMEOUT_MS,
  classifyError,
  checkWebsiteReachability,
};
