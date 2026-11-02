const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toE164Digits,
  buildInternationalTelHref,
  buildTelHref,
  buildWhatsAppHref,
} = require('../phone');
const { normalizePlace } = require('../normalize');
const { FIELD_MASK, getPlaceInternationalPhone, GooglePlacesError } = require('../googlePlaces');

// ---------------------------------------------------------------------
// toE164Digits
// ---------------------------------------------------------------------

test('toE164Digits: turns Google international formats into digits-only E.164', () => {
  assert.equal(toE164Digits('+254 20 123 4567'), '254201234567');
  assert.equal(toE164Digits('+1 (415) 555-0132'), '14155550132');
  assert.equal(toE164Digits('+44 20 7946 0958'), '442079460958');
  assert.equal(toE164Digits('  +254712345678  '), '254712345678');
  assert.equal(toE164Digits('+254.712.345.678'), '254712345678');
});

test('toE164Digits: NEVER guesses a country code -- a number without "+" is rejected', () => {
  assert.equal(toE164Digits('020 123 4567'), null);
  assert.equal(toE164Digits('0712345678'), null);
  assert.equal(toE164Digits('254712345678'), null);
  assert.equal(toE164Digits('00254712345678'), null);
});

test('toE164Digits: rejects junk, letters, extensions, and out-of-range lengths', () => {
  assert.equal(toE164Digits(null), null);
  assert.equal(toE164Digits(undefined), null);
  assert.equal(toE164Digits(254712345678), null);
  assert.equal(toE164Digits(''), null);
  assert.equal(toE164Digits('+'), null);
  assert.equal(toE164Digits('+254 712 345 678 ext 5'), null);
  assert.equal(toE164Digits('+254-CALL-NOW'), null);
  assert.equal(toE164Digits('+1234567'), null, 'too short (7 digits)');
  assert.equal(toE164Digits('+1234567890123456'), null, 'too long (16 digits)');
  assert.equal(toE164Digits('+0712345678'), null, 'a country code never starts with 0');
});

test('link builders: tel and wa.me come only from valid international numbers', () => {
  assert.equal(buildInternationalTelHref('+254 20 123 4567'), 'tel:+254201234567');
  assert.equal(buildWhatsAppHref('+254 20 123 4567'), 'https://wa.me/254201234567');
  assert.equal(buildWhatsAppHref('020 123 4567'), null, 'no wa.me link without an international number');
  assert.equal(buildInternationalTelHref('020 123 4567'), null);
});

test('buildTelHref: a national number still gets a tel: link (dialled as typed), without inventing a prefix', () => {
  assert.equal(buildTelHref('020 123 4567'), 'tel:0201234567');
  assert.equal(buildTelHref('+254 20 123 4567'), 'tel:+254201234567');
  assert.equal(buildTelHref('call us'), null);
  assert.equal(buildTelHref('javascript:alert(1)'), null);
  assert.equal(buildTelHref(null), null);
});

// ---------------------------------------------------------------------
// normalizePlace + field mask
// ---------------------------------------------------------------------

const BASE_PLACE = { id: 'ChIJabc123', displayName: { text: 'Sharp Cuts' }, nationalPhoneNumber: '020 123 4567' };

test('normalizePlace: stores Google\'s internationalPhoneNumber exactly as returned (trimmed)', () => {
  const normalized = normalizePlace({ ...BASE_PLACE, internationalPhoneNumber: '  +254 20 123 4567 ' });
  assert.equal(normalized.international_phone, '+254 20 123 4567');
  assert.equal(normalized.phone, '020 123 4567', 'the national phone is untouched');
});

test('normalizePlace: never derives an international number from the national one', () => {
  const normalized = normalizePlace(BASE_PLACE);
  assert.equal('international_phone' in normalized, false);
  const blank = normalizePlace({ ...BASE_PLACE, internationalPhoneNumber: '   ' });
  assert.equal('international_phone' in blank, false);
});

test('FIELD_MASK requests places.internationalPhoneNumber alongside the national number', () => {
  const fields = FIELD_MASK.split(',');
  assert.ok(fields.includes('places.internationalPhoneNumber'));
  assert.ok(fields.includes('places.nationalPhoneNumber'));
});

// ---------------------------------------------------------------------
// getPlaceInternationalPhone (Place Details)
// ---------------------------------------------------------------------

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

test('getPlaceInternationalPhone: GET with a details-style field mask, key in header only', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { impl, calls } = fakeFetch({
    ok: true,
    status: 200,
    json: async () => ({ internationalPhoneNumber: '+254 20 123 4567' }),
  });

  const result = await getPlaceInternationalPhone('ChIJabc123_-XYZ', { fetchImpl: impl });

  assert.deepEqual(result, { internationalPhoneNumber: '+254 20 123 4567' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places/ChIJabc123_-XYZ');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Goog-FieldMask'], 'internationalPhoneNumber');
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key');
  assert.ok(!calls[0].url.includes('test-key'), 'the API key must never be in the URL');
});

test('getPlaceInternationalPhone: no number -> null number; unknown place (404) -> null', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const none = await getPlaceInternationalPhone('ChIJabc123_-XYZ', {
    fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({}) }).impl,
  });
  assert.deepEqual(none, { internationalPhoneNumber: null });

  const gone = await getPlaceInternationalPhone('ChIJabc123_-XYZ', {
    fetchImpl: fakeFetch({ ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) }).impl,
  });
  assert.equal(gone, null);
});

test('getPlaceInternationalPhone: refuses a non-id-shaped place id before any request', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const { impl, calls } = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
  for (const bad of ['../../etc/passwd', 'abc', 'id with space/ChIJ', '', null, 'ChIJ?x=1&y=2abcdef']) {
    await assert.rejects(() => getPlaceInternationalPhone(bad, { fetchImpl: impl }), RangeError);
  }
  assert.equal(calls.length, 0);
});

test('getPlaceInternationalPhone: maps Google errors to safe GooglePlacesErrors', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  await assert.rejects(
    () =>
      getPlaceInternationalPhone('ChIJabc123_-XYZ', {
        fetchImpl: fakeFetch({ ok: false, status: 429, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED' } }) }).impl,
      }),
    (err) => err instanceof GooglePlacesError && err.reason === 'RATE_LIMITED'
  );

  delete process.env.GOOGLE_PLACES_API_KEY;
  await assert.rejects(
    () => getPlaceInternationalPhone('ChIJabc123_-XYZ', { fetchImpl: fakeFetch({}).impl }),
    (err) => err instanceof GooglePlacesError && err.reason === 'MISSING_API_KEY'
  );
});
