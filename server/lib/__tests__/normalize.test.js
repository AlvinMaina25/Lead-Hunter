const test = require('node:test');
const assert = require('node:assert/strict');
const {
  trimToNull,
  normalizeWebsiteUrl,
  findAddressComponent,
  normalizePlace,
} = require('../normalize');

test('trimToNull trims and converts empty strings to null', () => {
  assert.equal(trimToNull('  hello  '), 'hello');
  assert.equal(trimToNull('   '), null);
  assert.equal(trimToNull(''), null);
  assert.equal(trimToNull(null), null);
  assert.equal(trimToNull(undefined), null);
  assert.equal(trimToNull(42), null);
});

test('normalizeWebsiteUrl lower-cases and strips trailing slashes', () => {
  assert.equal(normalizeWebsiteUrl('Https://Example.com/'), 'https://example.com');
  assert.equal(normalizeWebsiteUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeWebsiteUrl('https://example.com///'), 'https://example.com');
  assert.equal(normalizeWebsiteUrl('   '), null);
  assert.equal(normalizeWebsiteUrl(undefined), null);
});

test('findAddressComponent finds the component by type', () => {
  const components = [
    { longText: 'Nairobi', types: ['locality', 'political'] },
    { longText: 'Kenya', types: ['country', 'political'] },
  ];
  assert.equal(findAddressComponent(components, 'locality'), 'Nairobi');
  assert.equal(findAddressComponent(components, 'country'), 'Kenya');
  assert.equal(findAddressComponent(components, 'postal_code'), null);
  assert.equal(findAddressComponent(undefined, 'locality'), null);
  assert.equal(findAddressComponent([], 'locality'), null);
});

test('normalizePlace maps a well-formed Google place', () => {
  const place = {
    id: 'ChIJabc123',
    displayName: { text: 'Sharp Cuts Barbershop' },
    formattedAddress: '123 Kenyatta Ave, Nairobi, Kenya',
    addressComponents: [
      { longText: 'Nairobi', types: ['locality'] },
      { longText: 'Kenya', types: ['country'] },
    ],
    location: { latitude: -1.2921, longitude: 36.8219 },
    rating: 4.5,
    userRatingCount: 128,
    nationalPhoneNumber: '020 123 4567',
    websiteUri: 'https://sharpcuts.co.ke/',
    googleMapsUri: 'https://maps.google.com/?cid=123',
    primaryTypeDisplayName: { text: 'Barber shop' },
  };

  const normalized = normalizePlace(place);

  assert.deepEqual(normalized, {
    external_place_id: 'ChIJabc123',
    name: 'Sharp Cuts Barbershop',
    category: 'Barber shop',
    phone: '020 123 4567',
    address: '123 Kenyatta Ave, Nairobi, Kenya',
    city: 'Nairobi',
    country: 'Kenya',
    latitude: -1.2921,
    longitude: 36.8219,
    google_maps_url: 'https://maps.google.com/?cid=123',
    google_rating: 4.5,
    google_review_count: 128,
    website_url: 'https://sharpcuts.co.ke',
    website_status: 'unknown',
  });
});

test('normalizePlace returns null when id is missing', () => {
  assert.equal(normalizePlace({ displayName: { text: 'No Id Business' } }), null);
});

test('normalizePlace returns null when name is missing', () => {
  assert.equal(normalizePlace({ id: 'ChIJxyz' }), null);
});

test('normalizePlace sets website_status to no_website when there is no website', () => {
  const normalized = normalizePlace({ id: 'ChIJnowebsite', displayName: { text: 'Corner Store' } });
  assert.equal(normalized.website_status, 'no_website');
  assert.equal(normalized.website_url, null);
});

test('normalizePlace never invents city/country from formattedAddress alone', () => {
  const normalized = normalizePlace({
    id: 'ChIJnoaddr',
    displayName: { text: 'Mystery Business' },
    formattedAddress: '456 Some Street, Some City, Some Country',
    // no addressComponents provided
  });
  assert.equal(normalized.city, null);
  assert.equal(normalized.country, null);
});

test('normalizePlace ignores non-numeric rating/review counts', () => {
  const normalized = normalizePlace({
    id: 'ChIJbadnums',
    displayName: { text: 'Odd Data Business' },
    rating: 'not-a-number',
    userRatingCount: 4.7, // not an integer
  });
  assert.equal(normalized.google_rating, null);
  assert.equal(normalized.google_review_count, null);
});
