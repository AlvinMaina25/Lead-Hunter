/**
 * Server-side client for the Google Places API (New) — Text Search.
 *
 * SECURITY: this module is the ONLY place GOOGLE_PLACES_API_KEY is read.
 * It never runs in, or is imported by, frontend code. The key is sent
 * only as a request header to Google — it is never logged, never put
 * in a response body, and never forwarded to the browser.
 *
 * Requires Node.js 18+ for global fetch/AbortController.
 */

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACE_DETAILS_BASE_URL = 'https://places.googleapis.com/v1/places/';

// Google's Text Search (New) returns at most 20 results per request
// (PAGE_SIZE). A search may ask for more than that: textSearch follows
// `nextPageToken` and issues one extra request per additional page of
// up to 20, so MAX_RESULT_COUNT = 50 costs at most 3 requests. Google
// itself never returns more than 60 results for one query.
const PAGE_SIZE = 20;
const MAX_RESULT_COUNT = 50;

// Phase 20: Text Search (New)'s `locationBias.circle.radius` accepts
// 0.0-50000.0 metres. That is therefore the largest radius a search
// configuration may ask for (see validateSearchConfiguration).
const MAX_RADIUS_METERS = 50000;

const REQUEST_TIMEOUT_MS = 15000;

// Field mask: request only what the `businesses` table stores (see
// migrations/001_init_schema.sql and frontend/src/types/index.ts). Every
// extra field here is extra Google Places billing, so this list is kept
// deliberately minimal.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
].join(',');

class GooglePlacesError extends Error {
  constructor(message, { statusCode = 502, reason = 'UNKNOWN' } = {}) {
    super(message);
    this.name = 'GooglePlacesError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

/**
 * "barbers" + "Nairobi" (+ optional "premium") -> "premium barbers in Nairobi"
 */
function buildSearchQuery({ category, location, keyword }) {
  const subject = keyword ? `${keyword} ${category}` : category;
  return `${subject} in ${location}`;
}

/**
 * Maps a non-2xx Google Places response to a safe, specific error.
 * Never includes the API key or the raw Google response body.
 */
function mapGoogleErrorResponse(httpStatus, body) {
  const googleStatus = body && body.error && body.error.status;

  if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return new GooglePlacesError('Google Places API rate limit reached. Please try again later.', {
      statusCode: 429,
      reason: 'RATE_LIMITED',
    });
  }

  if (httpStatus === 401 || googleStatus === 'UNAUTHENTICATED') {
    return new GooglePlacesError('Google Places API key is missing or invalid.', {
      statusCode: 502,
      reason: 'INVALID_API_KEY',
    });
  }

  if (httpStatus === 403 || googleStatus === 'PERMISSION_DENIED') {
    return new GooglePlacesError(
      'Google Places API request was denied. Check that Places API (New) is enabled and billing is active for this key.',
      { statusCode: 502, reason: 'PERMISSION_DENIED' }
    );
  }

  if (httpStatus === 400 || googleStatus === 'INVALID_ARGUMENT') {
    return new GooglePlacesError('Google Places API rejected the search request.', {
      statusCode: 400,
      reason: 'INVALID_ARGUMENT',
    });
  }

  if (httpStatus >= 500) {
    return new GooglePlacesError('Google Places API is temporarily unavailable. Please try again later.', {
      statusCode: 502,
      reason: 'UPSTREAM_UNAVAILABLE',
    });
  }

  return new GooglePlacesError('Google Places API returned an unexpected error.', {
    statusCode: 502,
    reason: 'UNKNOWN',
  });
}

/**
 * Runs a Text Search (New) query, following `nextPageToken` until
 * `maxResultCount` places have been collected or Google has no more.
 * Each page is its own billed request, so at most
 * ceil(maxResultCount / PAGE_SIZE) requests are made.
 *
 * `options` is Phase 20's extension point for manual search
 * configuration; with no options it asks for a single page of
 * PAGE_SIZE results, exactly as it always has.
 *
 * @param {string} query
 * @param {{
 *   maxResultCount?: number,  // 1..MAX_RESULT_COUNT (default PAGE_SIZE)
 *   locationBias?: { latitude: number, longitude: number, radius: number }, // radius in metres, 0 < r <= MAX_RADIUS_METERS
 *   fieldMask?: string,       // override FIELD_MASK (used for the cheap location lookup)
 * }} [options]
 * @returns {Promise<Array<object>>} raw `places[]` entries (possibly empty)
 * @throws {GooglePlacesError}
 */
async function textSearch(query, options = {}) {
  const { maxResultCount = PAGE_SIZE, locationBias, fieldMask = FIELD_MASK } = options;

  if (!Number.isInteger(maxResultCount) || maxResultCount < 1 || maxResultCount > MAX_RESULT_COUNT) {
    throw new RangeError(`maxResultCount must be an integer from 1 to ${MAX_RESULT_COUNT}.`);
  }
  if (
    locationBias !== undefined &&
    !(
      Number.isFinite(locationBias.latitude) &&
      Number.isFinite(locationBias.longitude) &&
      Number.isFinite(locationBias.radius) &&
      locationBias.radius > 0 &&
      locationBias.radius <= MAX_RADIUS_METERS
    )
  ) {
    throw new RangeError(`locationBias needs a finite latitude/longitude and a radius in (0, ${MAX_RADIUS_METERS}] metres.`);
  }

  const baseBody = { textQuery: query };
  if (locationBias) {
    baseBody.locationBias = {
      circle: {
        center: { latitude: locationBias.latitude, longitude: locationBias.longitude },
        radius: locationBias.radius,
      },
    };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new GooglePlacesError(
      'Google Places API is not configured on the server (GOOGLE_PLACES_API_KEY is missing).',
      { statusCode: 503, reason: 'MISSING_API_KEY' }
    );
  }

  // nextPageToken is only requested (and only used) when more than one
  // page is wanted, so single-page searches send the same mask as before.
  const needsPaging = maxResultCount > PAGE_SIZE;
  const requestFieldMask = needsPaging ? `${fieldMask},nextPageToken` : fieldMask;

  const places = [];
  let pageToken;
  while (places.length < maxResultCount) {
    const pageSize = Math.min(PAGE_SIZE, maxResultCount - places.length);
    const page = await fetchTextSearchPage(
      { ...baseBody, pageSize, ...(pageToken ? { pageToken } : {}) },
      apiKey,
      requestFieldMask
    );
    places.push(...page.places);
    pageToken = needsPaging ? page.nextPageToken : undefined;
    if (!pageToken || page.places.length === 0) break;
  }

  return places.slice(0, maxResultCount);
}

/**
 * One Text Search (New) HTTP request.
 * @returns {Promise<{ places: object[], nextPageToken?: string }>}
 * @throws {GooglePlacesError}
 */
async function fetchTextSearchPage(requestBody, apiKey, fieldMask) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new GooglePlacesError('Timed out waiting for Google Places API. Please try again.', {
        statusCode: 504,
        reason: 'TIMEOUT',
      });
    }
    throw new GooglePlacesError('Could not reach Google Places API. Please check server network connectivity.', {
      statusCode: 502,
      reason: 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timeoutId);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new GooglePlacesError('Received an unreadable response from Google Places API.', {
      statusCode: 502,
      reason: 'MALFORMED_RESPONSE',
    });
  }

  if (!response.ok) {
    throw mapGoogleErrorResponse(response.status, body);
  }

  if (!body || !Array.isArray(body.places)) {
    return { places: [] };
  }

  return {
    places: body.places,
    nextPageToken: typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined,
  };
}

/**
 * Place Details (New) for ONE place, requesting only
 * `internationalPhoneNumber`. Used by the international-phone backfill
 * (server/lib/phoneBackfillService.js) so existing businesses can get
 * the number without re-running searches. One Details request is
 * billed per call, so callers bound how many they make.
 *
 * Note: Place Details field masks have no "places." prefix (unlike Text
 * Search).
 *
 * @param {string} placeId - a Google place id (businesses.external_place_id)
 * @param {{ fetchImpl?: typeof fetch }} [options] injectable for tests
 * @returns {Promise<{ internationalPhoneNumber: string|null }|null>} null when Google no longer knows the place (404)
 * @throws {GooglePlacesError}
 */
async function getPlaceInternationalPhone(placeId, { fetchImpl = fetch } = {}) {
  // Place ids go into a URL path, so refuse anything that isn't id-shaped.
  if (typeof placeId !== 'string' || !/^[A-Za-z0-9_-]{10,512}$/.test(placeId)) {
    throw new RangeError('placeId is not a valid Google place id.');
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new GooglePlacesError(
      'Google Places API is not configured on the server (GOOGLE_PLACES_API_KEY is missing).',
      { statusCode: 503, reason: 'MISSING_API_KEY' }
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(`${PLACE_DETAILS_BASE_URL}${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'internationalPhoneNumber',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new GooglePlacesError('Timed out waiting for Google Places API. Please try again.', {
        statusCode: 504,
        reason: 'TIMEOUT',
      });
    }
    throw new GooglePlacesError('Could not reach Google Places API. Please check server network connectivity.', {
      statusCode: 502,
      reason: 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 404) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    throw new GooglePlacesError('Received an unreadable response from Google Places API.', {
      statusCode: 502,
      reason: 'MALFORMED_RESPONSE',
    });
  }

  if (!response.ok) {
    throw mapGoogleErrorResponse(response.status, body);
  }

  const value = body && typeof body.internationalPhoneNumber === 'string' ? body.internationalPhoneNumber.trim() : '';
  return { internationalPhoneNumber: value || null };
}

/**
 * Phase 20. A search radius needs a centre point, but a search
 * configuration only carries a free-text `location`. Rather than add a
 * second Google integration (e.g. Geocoding), the centre is resolved
 * with the SAME Text Search request, asking for one result and only its
 * `location` field.
 *
 * @param {string} location
 * @param {typeof textSearch} [search] injectable for tests
 * @returns {Promise<{latitude: number, longitude: number}|null>} null when Google returns no usable coordinates
 * @throws {GooglePlacesError}
 */
async function resolveLocationCenter(location, search = textSearch) {
  const places = await search(location, { maxResultCount: 1, fieldMask: 'places.location' });
  const point = Array.isArray(places) && places[0] && places[0].location;
  if (point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) {
    return { latitude: point.latitude, longitude: point.longitude };
  }
  return null;
}

/** Great-circle (haversine) distance in metres between two lat/lng points. */
function distanceMeters(a, b) {
  const EARTH_RADIUS_M = 6371008.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = {
  textSearch,
  getPlaceInternationalPhone,
  resolveLocationCenter,
  distanceMeters,
  buildSearchQuery,
  mapGoogleErrorResponse,
  GooglePlacesError,
  FIELD_MASK,
  MAX_RESULT_COUNT,
  PAGE_SIZE,
  MAX_RADIUS_METERS,
};
