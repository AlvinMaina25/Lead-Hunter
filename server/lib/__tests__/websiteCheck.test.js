const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WEBSITE_STATUS,
  NORMALIZATION_FAILURE,
  normalizeWebsiteUrlForCheck,
  determineStatusBeforeCheck,
} = require('../websiteCheck');

// ---------------------------------------------------------------------
// normalizeWebsiteUrlForCheck
// ---------------------------------------------------------------------

test('normalizeWebsiteUrlForCheck: missing URL (undefined)', () => {
  const result = normalizeWebsiteUrlForCheck(undefined);
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.MISSING });
});

test('normalizeWebsiteUrlForCheck: missing URL (null)', () => {
  const result = normalizeWebsiteUrlForCheck(null);
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.MISSING });
});

test('normalizeWebsiteUrlForCheck: empty URL', () => {
  assert.deepEqual(normalizeWebsiteUrlForCheck(''), {
    ok: false,
    reason: NORMALIZATION_FAILURE.MISSING,
  });
  assert.deepEqual(normalizeWebsiteUrlForCheck('   '), {
    ok: false,
    reason: NORMALIZATION_FAILURE.MISSING,
  });
});

test('normalizeWebsiteUrlForCheck: URL with https', () => {
  const result = normalizeWebsiteUrlForCheck('https://example.com');
  assert.deepEqual(result, { ok: true, url: 'https://example.com' });
});

test('normalizeWebsiteUrlForCheck: URL with http', () => {
  const result = normalizeWebsiteUrlForCheck('http://example.com');
  assert.deepEqual(result, { ok: true, url: 'http://example.com' });
});

test('normalizeWebsiteUrlForCheck: domain without protocol gets https:// added', () => {
  const result = normalizeWebsiteUrlForCheck('example.com');
  assert.deepEqual(result, { ok: true, url: 'https://example.com' });
});

test('normalizeWebsiteUrlForCheck: domain without protocol, with path', () => {
  const result = normalizeWebsiteUrlForCheck('example.com/pricing');
  assert.deepEqual(result, { ok: true, url: 'https://example.com/pricing' });
});

test('normalizeWebsiteUrlForCheck: trims surrounding whitespace before adding a protocol', () => {
  const result = normalizeWebsiteUrlForCheck('  example.com  ');
  assert.deepEqual(result, { ok: true, url: 'https://example.com' });
});

test('normalizeWebsiteUrlForCheck: invalid protocol is rejected, not silently fixed', () => {
  const result = normalizeWebsiteUrlForCheck('ftp://example.com');
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.INVALID_PROTOCOL });
});

test('normalizeWebsiteUrlForCheck: malformed URL (scheme with no host)', () => {
  const result = normalizeWebsiteUrlForCheck('https://');
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.MALFORMED });
});

test('normalizeWebsiteUrlForCheck: malformed URL (space inside)', () => {
  const result = normalizeWebsiteUrlForCheck('https:// example.com');
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.MALFORMED });
});

test('normalizeWebsiteUrlForCheck: malformed URL (free text, not a URL)', () => {
  const result = normalizeWebsiteUrlForCheck('not a url at all');
  assert.deepEqual(result, { ok: false, reason: NORMALIZATION_FAILURE.MALFORMED });
});

test('normalizeWebsiteUrlForCheck: never invents a URL for non-string input', () => {
  assert.deepEqual(normalizeWebsiteUrlForCheck(42), {
    ok: false,
    reason: NORMALIZATION_FAILURE.MISSING,
  });
  assert.deepEqual(normalizeWebsiteUrlForCheck({}), {
    ok: false,
    reason: NORMALIZATION_FAILURE.MISSING,
  });
});

test('normalizeWebsiteUrlForCheck: does not rewrite an already well-formed URL', () => {
  // No trailing slash should be added to a bare host that didn't have one.
  const result = normalizeWebsiteUrlForCheck('https://example.com');
  assert.equal(result.url, 'https://example.com');
});

// ---------------------------------------------------------------------
// determineStatusBeforeCheck
// ---------------------------------------------------------------------

test('determineStatusBeforeCheck: missing URL -> no_website', () => {
  assert.equal(determineStatusBeforeCheck(undefined), WEBSITE_STATUS.NO_WEBSITE);
  assert.equal(determineStatusBeforeCheck(null), WEBSITE_STATUS.NO_WEBSITE);
  assert.equal(determineStatusBeforeCheck(''), WEBSITE_STATUS.NO_WEBSITE);
  assert.equal(determineStatusBeforeCheck('   '), WEBSITE_STATUS.NO_WEBSITE);
});

test('determineStatusBeforeCheck: a present, valid URL -> unknown (not yet checked)', () => {
  assert.equal(determineStatusBeforeCheck('https://example.com'), WEBSITE_STATUS.UNKNOWN);
  assert.equal(determineStatusBeforeCheck('example.com'), WEBSITE_STATUS.UNKNOWN);
});

test('determineStatusBeforeCheck: never claims reachable/unreachable without a check', () => {
  const allInputs = [undefined, null, '', 'example.com', 'https://example.com', 'ftp://example.com', 'not a url'];
  for (const input of allInputs) {
    const status = determineStatusBeforeCheck(input);
    assert.notEqual(status, WEBSITE_STATUS.REACHABLE);
    assert.notEqual(status, WEBSITE_STATUS.UNREACHABLE);
  }
});

test('determineStatusBeforeCheck: an invalid-protocol or malformed URL -> unknown, not no_website', () => {
  // The business DOES have a stored value — we just can't check it yet.
  // Calling this "no_website" would be inaccurate.
  assert.equal(determineStatusBeforeCheck('ftp://example.com'), WEBSITE_STATUS.UNKNOWN);
  assert.equal(determineStatusBeforeCheck('not a url at all'), WEBSITE_STATUS.UNKNOWN);
});
