/**
 * Foundation for website detection (Phase 9A).
 *
 * This module is deliberately synchronous and side-effect free: it
 * prepares a business's stored `website_url` for a future reachability
 * check, and decides the one `website_status` value we can determine
 * without making a network request. It never performs HTTP requests
 * itself (that lands in a later phase) and never invents a URL that
 * wasn't already stored on the business.
 */

/**
 * The complete set of values `businesses.website_status` may hold,
 * matching the CHECK constraint added in
 * migrations/002_add_website_checked_at.sql.
 */
const WEBSITE_STATUS = Object.freeze({
  NO_WEBSITE: 'no_website',   // no URL stored at all
  REACHABLE: 'reachable',     // a check ran and the site responded
  UNREACHABLE: 'unreachable', // a check ran and the site did not respond
  UNKNOWN: 'unknown',         // not yet checked, or the URL can't be checked
});

const WEBSITE_STATUS_VALUES = Object.freeze(Object.values(WEBSITE_STATUS));

/** Only these two schemes are ever accepted for a checkable URL. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Matches an explicit "<scheme>://" prefix, e.g. "https://" or "ftp://". */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

/**
 * Reasons `normalizeWebsiteUrlForCheck` can fail with. Kept as plain
 * strings (not an Error subclass) because callers treat "can't check
 * this" as an expected, ordinary outcome, not an exceptional one.
 */
const NORMALIZATION_FAILURE = Object.freeze({
  MISSING: 'missing',                   // no URL stored, or blank
  INVALID_PROTOCOL: 'invalid_protocol', // e.g. ftp://, mailto:
  MALFORMED: 'malformed',               // not a parseable URL at all
});

/**
 * Prepares a business's stored `website_url` for a future reachability
 * check.
 *
 * - Missing/empty input -> not ok, reason "missing".
 * - A bare domain (no "scheme://") has "https://" added, since that's
 *   filling in an omitted protocol on a value we already have — never
 *   guessing at a domain that wasn't stored.
 * - Only http:// and https:// are accepted; anything else (ftp://,
 *   mailto:, etc.) -> not ok, reason "invalid_protocol".
 * - Anything that still isn't a parseable URL -> not ok, reason
 *   "malformed".
 *
 * Does NOT perform an HTTP request and does NOT reserialize/rewrite a
 * URL that was already well-formed (e.g. it won't add a trailing
 * slash), so the returned string stays as close as possible to what
 * was actually stored.
 *
 * Known limitation: a schemeless value that happens to contain its own
 * "word:" prefix (e.g. "mailto:someone@example.com") gets "https://"
 * prepended like any other bare domain and can parse as a syntactically
 * valid (if meaningless) URL rather than being rejected. Values like
 * this aren't expected in `website_url` — Google Places only ever
 * supplies real http(s) site URLs — so this is left as-is rather than
 * adding speculative scheme-detection logic for a case that shouldn't
 * occur in practice.
 *
 * @param {unknown} rawUrl - businesses.website_url as read from the DB
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
function normalizeWebsiteUrlForCheck(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, reason: NORMALIZATION_FAILURE.MISSING };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: NORMALIZATION_FAILURE.MISSING };
  }

  const hasScheme = SCHEME_PATTERN.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: NORMALIZATION_FAILURE.MALFORMED };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: NORMALIZATION_FAILURE.INVALID_PROTOCOL };
  }

  return { ok: true, url: candidate };
}

/**
 * Determines `website_status` for a business BEFORE any reachability
 * check has run. This only implements the one case that's safe to
 * decide without a network request: no usable URL at all -> the
 * business genuinely has no website. Every other case — a URL is
 * present, whether or not it will turn out to be reachable — stays
 * 'unknown' rather than being guessed at. A later phase is responsible
 * for turning 'unknown' into 'reachable' or 'unreachable' once it has
 * actually attempted the check.
 *
 * @param {unknown} rawUrl - businesses.website_url as read from the DB
 * @returns {string} one of WEBSITE_STATUS's values
 */
function determineStatusBeforeCheck(rawUrl) {
  const normalized = normalizeWebsiteUrlForCheck(rawUrl);
  if (!normalized.ok && normalized.reason === NORMALIZATION_FAILURE.MISSING) {
    return WEBSITE_STATUS.NO_WEBSITE;
  }
  return WEBSITE_STATUS.UNKNOWN;
}

module.exports = {
  WEBSITE_STATUS,
  WEBSITE_STATUS_VALUES,
  NORMALIZATION_FAILURE,
  normalizeWebsiteUrlForCheck,
  determineStatusBeforeCheck,
};
