/**
 * Normalization of raw Google Places API (New) results into the shape
 * the `businesses` table expects (see migrations/001_init_schema.sql).
 *
 * Rules (per Phase 7 spec):
 *  - Trim whitespace; empty strings become NULL.
 *  - Never guess at missing data — if a field isn't present, store NULL.
 *  - city/country are only extracted from Google's structured
 *    addressComponents (locality / country), never parsed out of the
 *    free-text formattedAddress, so we never invent a value.
 */

function trimToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Lower-cases and strips a trailing slash so the same site stored twice
 * (e.g. "Example.com/" and "example.com") normalizes to one value. This
 * mirrors the normalize_website_url() trigger already applied at the
 * database layer (migrations/001_init_schema.sql) — doing it here too
 * means duplicate-looking URLs from different Google results collapse
 * before they ever reach SQL.
 */
function normalizeWebsiteUrl(url) {
  const trimmed = trimToNull(url);
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : null;
}

function findAddressComponent(components, type) {
  if (!Array.isArray(components)) return null;
  const match = components.find((c) => c && Array.isArray(c.types) && c.types.includes(type));
  return match ? trimToNull(match.longText) : null;
}

function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toIntOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * @param {object} place - a single entry from Google's `places[]` array
 * @returns {object|null} normalized row ready for the businesses table,
 *   or null if the place is missing something we cannot safely store
 *   without violating a NOT NULL constraint (external_place_id, name).
 */
function normalizePlace(place) {
  if (!place || typeof place !== 'object') return null;

  const externalPlaceId = trimToNull(place.id);
  const name = trimToNull(place.displayName && place.displayName.text);

  if (!externalPlaceId || !name) {
    return null;
  }

  const websiteUrl = normalizeWebsiteUrl(place.websiteUri);

  const internationalPhone = trimToNull(place.internationalPhoneNumber);

  return {
    external_place_id: externalPlaceId,
    name,
    category: trimToNull(place.primaryTypeDisplayName && place.primaryTypeDisplayName.text),
    phone: trimToNull(place.nationalPhoneNumber),
    address: trimToNull(place.formattedAddress),
    city: findAddressComponent(place.addressComponents, 'locality'),
    country: findAddressComponent(place.addressComponents, 'country'),
    latitude: toNumberOrNull(place.location && place.location.latitude),
    longitude: toNumberOrNull(place.location && place.location.longitude),
    google_maps_url: trimToNull(place.googleMapsUri),
    google_rating: toNumberOrNull(place.rating),
    google_review_count: toIntOrNull(place.userRatingCount),
    website_url: websiteUrl,
    // Schema only has 'active' | 'inactive' | 'broken' | 'no_website' | 'unknown'
    // (see migrations/001_init_schema.sql). We haven't analyzed the site yet
    // (that's a later phase), so a business with a URL is 'unknown' rather
    // than 'active' — 'active' would falsely imply an analysis happened.
    website_status: websiteUrl ? 'unknown' : 'no_website',
    // Google's own international form ("+254 20 ..."), stored as returned.
    // Never derived from the national number (that would mean guessing a
    // country code). The key is only present when Google actually sent one.
    ...(internationalPhone ? { international_phone: internationalPhone } : {}),
  };
}

module.exports = {
  trimToNull,
  normalizeWebsiteUrl,
  findAddressComponent,
  toNumberOrNull,
  toIntOrNull,
  normalizePlace,
};
