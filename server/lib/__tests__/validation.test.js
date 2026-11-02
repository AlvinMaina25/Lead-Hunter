const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSearchInput, ValidationError } = require('../validation');

test('accepts a minimal valid request', () => {
  const result = validateSearchInput({ category: 'barbers', location: 'Nairobi' });
  assert.deepEqual(result, { category: 'barbers', location: 'Nairobi', keyword: '' });
});

test('trims whitespace on all fields', () => {
  const result = validateSearchInput({ category: '  barbers  ', location: '  Nairobi ', keyword: ' premium ' });
  assert.deepEqual(result, { category: 'barbers', location: 'Nairobi', keyword: 'premium' });
});

test('defaults keyword to empty string when omitted', () => {
  const result = validateSearchInput({ category: 'restaurants', location: 'Westlands' });
  assert.equal(result.keyword, '');
});

test('rejects a missing category', () => {
  assert.throws(() => validateSearchInput({ location: 'Nairobi' }), ValidationError);
});

test('rejects a missing location', () => {
  assert.throws(() => validateSearchInput({ category: 'barbers' }), ValidationError);
});

test('rejects an empty-string category', () => {
  assert.throws(() => validateSearchInput({ category: '   ', location: 'Nairobi' }), ValidationError);
});

test('rejects a non-string category', () => {
  assert.throws(() => validateSearchInput({ category: 123, location: 'Nairobi' }), ValidationError);
});

test('rejects a category over the max length', () => {
  assert.throws(
    () => validateSearchInput({ category: 'a'.repeat(101), location: 'Nairobi' }),
    ValidationError
  );
});

test('rejects a non-object body', () => {
  assert.throws(() => validateSearchInput(null), ValidationError);
  assert.throws(() => validateSearchInput('barbers'), ValidationError);
  assert.throws(() => validateSearchInput(['barbers']), ValidationError);
});

test('rejects a non-string keyword', () => {
  assert.throws(
    () => validateSearchInput({ category: 'barbers', location: 'Nairobi', keyword: 5 }),
    ValidationError
  );
});

// ---------------------------------------------------------------------
// Phase 20: validateSearchConfiguration
// ---------------------------------------------------------------------

const {
  validateSearchConfiguration,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  MAX_RADIUS_METERS_LIMIT,
} = require('../validation');

const BASE = { category: 'barbers', location: 'Nairobi' };

function assertRejects(body, messagePattern) {
  assert.throws(
    () => validateSearchConfiguration(body),
    (err) => err instanceof ValidationError && messagePattern.test(err.message)
  );
}

test('config: a full valid configuration is accepted and normalized', () => {
  const result = validateSearchConfiguration({
    category: '  barbers ',
    location: ' Nairobi ',
    keyword: ' premium ',
    radius_meters: 5000,
    max_results: 10,
    analysis_options: { website_analysis: true, ai_analysis: false },
  });
  assert.deepEqual(result, {
    category: 'barbers',
    location: 'Nairobi',
    keyword: 'premium',
    radius_meters: 5000,
    max_results: 10,
    analysis_options: { website_analysis: true, ai_analysis: false },
    only_without_website: false,
  });
});

test('config: a legacy { category, location } body is still valid and gets the defaults', () => {
  assert.deepEqual(validateSearchConfiguration(BASE), {
    category: 'barbers',
    location: 'Nairobi',
    keyword: '',
    radius_meters: null,
    max_results: DEFAULT_MAX_RESULTS,
    analysis_options: { website_analysis: false, ai_analysis: false },
    only_without_website: false,
  });
});

test('config: only_without_website defaults to false, accepts booleans, rejects everything else', () => {
  assert.equal(validateSearchConfiguration(BASE).only_without_website, false);
  assert.equal(validateSearchConfiguration({ ...BASE, only_without_website: true }).only_without_website, true);
  assertRejects({ ...BASE, only_without_website: 'true' }, /"only_without_website" must be true or false/);
  assertRejects({ ...BASE, only_without_website: null }, /"only_without_website" must be true or false/);
});

test('config: the limits are the Google Places Text Search (New) limits', () => {
  assert.equal(MAX_RESULTS_LIMIT, 50);
  assert.equal(DEFAULT_MAX_RESULTS, 20);
  assert.equal(MAX_RADIUS_METERS_LIMIT, 50000);
});

test('config: missing or empty category is rejected', () => {
  assertRejects({ location: 'Nairobi' }, /"category" is required/);
  assertRejects({ category: '   ', location: 'Nairobi' }, /"category" is required/);
});

test('config: missing or empty location is rejected', () => {
  assertRejects({ category: 'barbers' }, /"location" is required/);
  assertRejects({ category: 'barbers', location: '' }, /"location" is required/);
});

test('config: a non-object body is rejected', () => {
  assertRejects(null, /JSON object/);
  assertRejects([], /JSON object/);
  assertRejects('barbers', /JSON object/);
});

test('config: radius_meters omitted or null means no radius', () => {
  assert.equal(validateSearchConfiguration(BASE).radius_meters, null);
  assert.equal(validateSearchConfiguration({ ...BASE, radius_meters: null }).radius_meters, null);
});

test('config: radius_meters accepts the inclusive upper bound and small positive decimals', () => {
  assert.equal(validateSearchConfiguration({ ...BASE, radius_meters: 50000 }).radius_meters, 50000);
  assert.equal(validateSearchConfiguration({ ...BASE, radius_meters: 0.5 }).radius_meters, 0.5);
});

test('config: invalid radius_meters values are rejected, not coerced', () => {
  assertRejects({ ...BASE, radius_meters: 0 }, /"radius_meters" must be greater than 0/);
  assertRejects({ ...BASE, radius_meters: -100 }, /"radius_meters" must be greater than 0/);
  assertRejects({ ...BASE, radius_meters: 50001 }, /at most 50000/);
  assertRejects({ ...BASE, radius_meters: '5000' }, /"radius_meters" must be a number/);
  assertRejects({ ...BASE, radius_meters: true }, /"radius_meters" must be a number/);
  assertRejects({ ...BASE, radius_meters: {} }, /"radius_meters" must be a number/);
  assertRejects({ ...BASE, radius_meters: Infinity }, /"radius_meters" must be a number/);
  assertRejects({ ...BASE, radius_meters: NaN }, /"radius_meters" must be a number/);
});

test('config: max_results defaults to 20 and accepts 1..50', () => {
  assert.equal(validateSearchConfiguration(BASE).max_results, 20);
  assert.equal(validateSearchConfiguration({ ...BASE, max_results: 1 }).max_results, 1);
  assert.equal(validateSearchConfiguration({ ...BASE, max_results: 20 }).max_results, 20);
  assert.equal(validateSearchConfiguration({ ...BASE, max_results: 50 }).max_results, 50);
});

test('config: invalid max_results values are rejected, not coerced', () => {
  assertRejects({ ...BASE, max_results: 0 }, /"max_results" must be between 1 and 50/);
  assertRejects({ ...BASE, max_results: -5 }, /"max_results" must be between 1 and 50/);
  assertRejects({ ...BASE, max_results: 51 }, /"max_results" must be between 1 and 50/);
  assertRejects({ ...BASE, max_results: 2.5 }, /"max_results" must be an integer/);
  assertRejects({ ...BASE, max_results: '10' }, /"max_results" must be an integer/);
  assertRejects({ ...BASE, max_results: null }, /"max_results" must be an integer/);
  assertRejects({ ...BASE, max_results: NaN }, /"max_results" must be an integer/);
});

test('config: analysis_options defaults both flags to false, and a partial object fills the rest with false', () => {
  assert.deepEqual(validateSearchConfiguration(BASE).analysis_options, { website_analysis: false, ai_analysis: false });
  assert.deepEqual(validateSearchConfiguration({ ...BASE, analysis_options: {} }).analysis_options, {
    website_analysis: false,
    ai_analysis: false,
  });
  assert.deepEqual(
    validateSearchConfiguration({ ...BASE, analysis_options: { ai_analysis: true } }).analysis_options,
    { website_analysis: false, ai_analysis: true }
  );
});

test('config: invalid analysis_options are rejected', () => {
  assertRejects({ ...BASE, analysis_options: null }, /"analysis_options" must be an object/);
  assertRejects({ ...BASE, analysis_options: 'website' }, /"analysis_options" must be an object/);
  assertRejects({ ...BASE, analysis_options: [true, false] }, /"analysis_options" must be an object/);
  assertRejects({ ...BASE, analysis_options: { website_analysis: 'true' } }, /"analysis_options.website_analysis" must be true or false/);
  assertRejects({ ...BASE, analysis_options: { ai_analysis: 1 } }, /"analysis_options.ai_analysis" must be true or false/);
  assertRejects({ ...BASE, analysis_options: { ai_analysis: null } }, /"analysis_options.ai_analysis" must be true or false/);
  assertRejects({ ...BASE, analysis_options: { lead_scoring: true } }, /"analysis_options.lead_scoring" is not a supported option/);
});

test('config: validateSearchInput itself is unchanged (still returns only category/location/keyword)', () => {
  assert.deepEqual(
    validateSearchInput({ ...BASE, radius_meters: 500, max_results: 3, analysis_options: { ai_analysis: true } }),
    { category: 'barbers', location: 'Nairobi', keyword: '' }
  );
});
