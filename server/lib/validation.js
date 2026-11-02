/**
 * Input validation for POST /api/searches.
 *
 * Deliberately framework-free (no Express req/res here) so it can be
 * unit tested in isolation and reused if another entry point ever
 * needs the same rules.
 */

const { MAX_RESULT_COUNT, PAGE_SIZE, MAX_RADIUS_METERS } = require('./googlePlaces');

const MAX_FIELD_LENGTH = 100;

// Phase 20 search-configuration limits. Both come straight from what
// Google Places Text Search (New) accepts (see googlePlaces.js), so a
// configuration that passes validation can always be sent to Google.
const MAX_RESULTS_LIMIT = MAX_RESULT_COUNT; // 50: up to 3 Google pages of 20
const DEFAULT_MAX_RESULTS = PAGE_SIZE; // 20: one Google page, what POST /api/searches always requested before Phase 20
const MAX_RADIUS_METERS_LIMIT = MAX_RADIUS_METERS;
const ANALYSIS_OPTION_KEYS = ['website_analysis', 'ai_analysis'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function cleanString(value, fieldName, { required }) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`"${fieldName}" is required.`);
    return '';
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`"${fieldName}" must be a string.`);
  }

  const trimmed = value.trim();

  if (required && trimmed.length === 0) {
    throw new ValidationError(`"${fieldName}" is required.`);
  }

  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new ValidationError(`"${fieldName}" must be ${MAX_FIELD_LENGTH} characters or fewer.`);
  }

  return trimmed;
}

/**
 * Validates and normalizes the body of a POST /api/searches request.
 *
 * @param {unknown} body
 * @returns {{ category: string, location: string, keyword: string }}
 * @throws {ValidationError}
 */
function validateSearchInput(body) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const category = cleanString(body.category, 'category', { required: true });
  const location = cleanString(body.location, 'location', { required: true });
  const keyword = cleanString(body.keyword, 'keyword', { required: false });

  return { category, location, keyword };
}

/**
 * radius_meters: omitted or null -> null (no radius; the search behaves
 * exactly as it did before Phase 20). Otherwise it must be a JSON
 * number, 0 < r <= MAX_RADIUS_METERS. Numeric strings are rejected, not
 * coerced.
 */
function validateRadius(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('"radius_meters" must be a number.');
  }
  if (value <= 0 || value > MAX_RADIUS_METERS_LIMIT) {
    throw new ValidationError(`"radius_meters" must be greater than 0 and at most ${MAX_RADIUS_METERS_LIMIT}.`);
  }
  return value;
}

/**
 * max_results: omitted -> DEFAULT_MAX_RESULTS. Otherwise an integer
 * 1..MAX_RESULTS_LIMIT. null is rejected (omit the field for the default).
 */
function validateMaxResults(value) {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('"max_results" must be an integer.');
  }
  if (value < 1 || value > MAX_RESULTS_LIMIT) {
    throw new ValidationError(`"max_results" must be between 1 and ${MAX_RESULTS_LIMIT}.`);
  }
  return value;
}

/**
 * analysis_options: omitted -> both off. Otherwise a plain object whose
 * only allowed keys are website_analysis / ai_analysis, each a real
 * boolean (omitted -> false). Unknown keys and non-boolean values are
 * rejected rather than ignored.
 */
function validateAnalysisOptions(value) {
  const result = { website_analysis: false, ai_analysis: false };
  if (value === undefined) return result;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('"analysis_options" must be an object.');
  }

  for (const key of Object.keys(value)) {
    if (!ANALYSIS_OPTION_KEYS.includes(key)) {
      throw new ValidationError(
        `"analysis_options.${key}" is not a supported option. Supported: ${ANALYSIS_OPTION_KEYS.join(', ')}.`
      );
    }
  }

  for (const key of ANALYSIS_OPTION_KEYS) {
    const option = value[key];
    if (option === undefined) continue;
    if (typeof option !== 'boolean') {
      throw new ValidationError(`"analysis_options.${key}" must be true or false.`);
    }
    result[key] = option;
  }

  return result;
}

/**
 * only_without_website: omitted -> false. Otherwise a real boolean.
 * When true, the search keeps only businesses Google lists with no website.
 */
function validateOnlyWithoutWebsite(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new ValidationError('"only_without_website" must be true or false.');
  }
  return value;
}

/**
 * Phase 20: validates and normalizes a manual search configuration.
 * A superset of validateSearchInput (category / location / keyword keep
 * their existing rules), so a Phase 7-era body such as
 * { category, location } is still valid and gets the defaults.
 *
 * @param {unknown} body
 * @returns {{
 *   category: string,
 *   location: string,
 *   keyword: string,
 *   radius_meters: number|null,
 *   max_results: number,
 *   analysis_options: { website_analysis: boolean, ai_analysis: boolean },
 * }}
 * @throws {ValidationError}
 */
function validateSearchConfiguration(body) {
  const { category, location, keyword } = validateSearchInput(body);

  return {
    category,
    location,
    keyword,
    radius_meters: validateRadius(body.radius_meters),
    max_results: validateMaxResults(body.max_results),
    analysis_options: validateAnalysisOptions(body.analysis_options),
    only_without_website: validateOnlyWithoutWebsite(body.only_without_website),
  };
}

module.exports = {
  ValidationError,
  validateSearchInput,
  validateSearchConfiguration,
  MAX_FIELD_LENGTH,
  MAX_RESULTS_LIMIT,
  DEFAULT_MAX_RESULTS,
  MAX_RADIUS_METERS_LIMIT,
};
