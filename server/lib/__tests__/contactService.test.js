const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { safeFetchHomepage, analyzeBusinessWebsite } = require('../websiteAnalysis');
const {
  collectWebsiteContacts,
  extractAndStoreContacts,
  loadContacts,
  buildContactsSummary,
  buildSearchLinks,
} = require('../contactService');

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE = [{ address: '10.0.0.5', family: 4 }];

// ---------------------------------------------------------------------
// Fake network: scripted node:http(s) that records every request made.
// ---------------------------------------------------------------------

function fakeResponse({ statusCode = 200, headers = {}, body = '' }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.setEncoding = () => {};
  res.destroy = () => process.nextTick(() => res.emit('close'));
  res.__emitBody = () => {
    if (body) res.emit('data', body);
    res.emit('end');
  };
  return res;
}

/** routes: { [url]: { statusCode?, headers?, body? } }. Unknown URLs -> 404. */
function makeNetwork(routes) {
  const requested = [];
  const module = {
    request(url, _options, callback) {
      requested.push(String(url));
      const req = new EventEmitter();
      req.end = () =>
        process.nextTick(() => {
          const res = fakeResponse(routes[url] || { statusCode: 404, body: 'not found' });
          callback(res);
          process.nextTick(() => res.__emitBody());
        });
      req.destroy = (err) => process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      return req;
    },
  };
  return { requested, httpModule: module, httpsModule: module };
}

const HOME_HTML = `<html><head><title>Shop</title></head><body>
  <a href="/contact">Contact</a>
  <a href="mailto:hello@shop.co.ke">Email</a>
  <a href="https://www.instagram.com/shopke/">IG</a>
</body></html>`;
const CONTACT_HTML = `<html><body>
  <a href="mailto:sales@shop.co.ke">Sales</a>
  <a href="https://wa.me/254712345678">WhatsApp</a>
  <a href="tel:+254201234567">Call</a>
</body></html>`;

// ---------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------

function makeFakePool({ email = null, failContacts = false, website_status = 'reachable' } = {}) {
  const business = { id: BUSINESS_ID, website_url: 'https://shop.co.ke/', website_status, email };
  const contacts = new Map(); // `${type}|${value}` -> row
  const analyses = [];

  return {
    business,
    contacts,
    analyses,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('SELECT id, website_url, website_status FROM businesses WHERE id = $1')) {
        return { rows: [{ ...business }] };
      }
      if (s.startsWith('INSERT INTO website_analysis')) {
        const row = { id: `a${analyses.length + 1}`, analysis_status: params[15], analyzed_url: params[1] };
        analyses.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('INSERT INTO business_contacts')) {
        if (failContacts) throw new Error('simulated contacts failure');
        assert.ok(s.includes('ON CONFLICT (business_id, contact_type, value) DO UPDATE'), 'must upsert, not blindly insert');
        const [businessId, foundAt, ...rest] = params;
        for (let i = 0; i < rest.length; i += 3) {
          const [type, value, source] = rest.slice(i, i + 3);
          const key = `${type}|${value}`;
          const existing = contacts.get(key);
          contacts.set(key, { business_id: businessId, contact_type: type, value, source_url: source, found_at: foundAt, id: existing ? existing.id : `c${contacts.size + 1}` });
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE businesses SET email = $2 WHERE id = $1 AND email IS NULL')) {
        if (business.email === null) business.email = params[1];
        return { rows: [] };
      }
      throw new Error(`FakePool: unrecognized query: ${s}`);
    },
  };
}

const typeOf = (pool, type) => [...pool.contacts.values()].filter((c) => c.contact_type === type);

// ---------------------------------------------------------------------
// collectWebsiteContacts
// ---------------------------------------------------------------------

test('collect: reuses the homepage HTML and fetches exactly ONE extra page (the contact page)', async () => {
  const fetched = [];
  const items = await collectWebsiteContacts({
    homepage: { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: HOME_HTML },
    fetchPage: async (url, options) => {
      fetched.push({ url, options });
      return { status: 'completed', httpStatus: 200, finalUrl: url, html: CONTACT_HTML };
    },
  });

  assert.deepEqual(fetched.map((f) => f.url), ['https://shop.co.ke/contact']);
  assert.ok(fetched[0].options.maxBytes <= 1024 * 1024 && fetched[0].options.timeoutMs <= 10000, 'size/time-limited');

  const byType = (t) => items.filter((i) => i.contact_type === t);
  assert.deepEqual(byType('email').map((i) => [i.value, i.source_url]), [
    ['hello@shop.co.ke', 'https://shop.co.ke/'],
    ['sales@shop.co.ke', 'https://shop.co.ke/contact'],
  ]);
  assert.deepEqual(byType('whatsapp').map((i) => [i.value, i.source_url]), [['https://wa.me/254712345678', 'https://shop.co.ke/contact']]);
  assert.deepEqual(byType('phone').map((i) => i.value), ['+254201234567']);
  assert.deepEqual(byType('instagram').map((i) => i.value), ['https://www.instagram.com/shopke/']);
  assert.deepEqual(byType('contact_page').map((i) => [i.value, i.source_url]), [['https://shop.co.ke/contact', 'https://shop.co.ke/']]);
});

test('collect: no contact link -> no second request at all', async () => {
  let fetches = 0;
  const items = await collectWebsiteContacts({
    homepage: { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: '<p>hi <a href="mailto:a@shop.co.ke">a</a></p>' },
    fetchPage: async () => {
      fetches += 1;
      return {};
    },
  });
  assert.equal(fetches, 0);
  assert.equal(items.length, 1);
});

test('collect: a contact page that redirected to another site is ignored (never harvest a third party)', async () => {
  const items = await collectWebsiteContacts({
    homepage: { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: HOME_HTML },
    fetchPage: async () => ({ status: 'completed', httpStatus: 200, finalUrl: 'https://evil.example/landing', html: '<a href="mailto:spam@evil.example">x</a>' }),
  });
  assert.ok(!items.some((i) => i.value === 'spam@evil.example'));
  assert.ok(items.some((i) => i.value === 'hello@shop.co.ke'), 'homepage contacts are still kept');
});

test('collect: failing / non-2xx / throwing contact page fetches never lose homepage contacts', async () => {
  for (const fetchPage of [
    async () => ({ status: 'blocked', html: null }),
    async () => ({ status: 'completed', httpStatus: 404, finalUrl: 'https://shop.co.ke/contact', html: '<a href="mailto:x@shop.co.ke">x</a>' }),
    async () => {
      throw new Error('boom');
    },
  ]) {
    const items = await collectWebsiteContacts({
      homepage: { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: HOME_HTML },
      fetchPage,
    });
    assert.deepEqual(items.filter((i) => i.contact_type === 'email').map((i) => i.value), ['hello@shop.co.ke']);
  }
});

test('collect: skips entirely when there is no usable homepage HTML', async () => {
  for (const homepage of [
    { status: 'failed', html: null },
    { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/' },
    { status: 'completed', httpStatus: 503, finalUrl: 'https://shop.co.ke/', html: HOME_HTML },
  ]) {
    assert.deepEqual(await collectWebsiteContacts({ homepage, fetchPage: async () => assert.fail('no fetch') }), []);
  }
});

test('collect: total emails capped at 5 across both pages, mailto before text', async () => {
  const text = Array.from({ length: 6 }, (_, i) => `t${i}@shop.co.ke`).join(' ');
  const items = await collectWebsiteContacts({
    homepage: { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: `<a href="/contact">c</a><p>${text}</p>` },
    fetchPage: async (url) => ({ status: 'completed', httpStatus: 200, finalUrl: url, html: '<a href="mailto:m@shop.co.ke">m</a>' }),
  });
  const emails = items.filter((i) => i.contact_type === 'email').map((i) => i.value);
  assert.equal(emails.length, 5);
  assert.equal(emails[0], 'm@shop.co.ke', 'the mailto: found on the contact page outranks homepage plain text');
});

// ---------------------------------------------------------------------
// SSRF guard on the contact page fetch (real safeFetchHomepage, fake sockets)
// ---------------------------------------------------------------------

function analyzeWith(network, lookup, pool = makeFakePool()) {
  return analyzeBusinessWebsite(pool, BUSINESS_ID, {
    skipPageSpeed: true,
    lookup,
    httpModule: network.httpModule,
    httpsModule: network.httpsModule,
  }).then((row) => ({ row, pool }));
}

test('ssrf: end to end, homepage + one contact page via the guarded fetch; contacts stored with source and time', async () => {
  const net = makeNetwork({
    'https://shop.co.ke/': { body: HOME_HTML },
    'https://shop.co.ke/contact': { body: CONTACT_HTML },
  });
  const { row, pool } = await analyzeWith(net, async () => PUBLIC);

  assert.equal(row.analysis_status, 'completed');
  assert.deepEqual(net.requested, ['https://shop.co.ke/', 'https://shop.co.ke/contact'], 'exactly two requests, never more');
  assert.deepEqual(typeOf(pool, 'email').map((c) => c.value).sort(), ['hello@shop.co.ke', 'sales@shop.co.ke']);
  for (const c of pool.contacts.values()) {
    assert.ok(c.source_url.startsWith('https://shop.co.ke'), 'source_url recorded');
    assert.ok(!Number.isNaN(Date.parse(c.found_at)), 'found_at recorded');
  }
});

test('ssrf: the contact page host re-resolving to a private address (DNS rebinding) is blocked', async () => {
  const net = makeNetwork({
    'https://shop.co.ke/': { body: HOME_HTML },
    'https://shop.co.ke/contact': { body: '<a href="mailto:leak@shop.co.ke">x</a>' },
  });
  let lookups = 0;
  const { row, pool } = await analyzeWith(net, async () => (++lookups === 1 ? PUBLIC : PRIVATE));

  assert.equal(row.analysis_status, 'completed', 'the homepage analysis itself is unaffected');
  assert.deepEqual(net.requested, ['https://shop.co.ke/'], 'no socket was opened to the private address');
  assert.ok(!typeOf(pool, 'email').some((c) => c.value === 'leak@shop.co.ke'));
  assert.ok(typeOf(pool, 'email').some((c) => c.value === 'hello@shop.co.ke'));
});

test('ssrf: a contact page redirecting to a metadata/internal address is blocked before any request to it', async () => {
  const net = makeNetwork({
    'https://shop.co.ke/': { body: HOME_HTML },
    'https://shop.co.ke/contact': { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
  });
  const { row, pool } = await analyzeWith(net, async () => PUBLIC);

  assert.equal(row.analysis_status, 'completed');
  assert.ok(!net.requested.some((u) => u.includes('169.254.169.254')), 'the internal redirect target is never requested');
  assert.equal(net.requested.length, 2);
  assert.ok(typeOf(pool, 'email').some((c) => c.value === 'hello@shop.co.ke'));
});

test('ssrf: a same-site contact link pointing at a blocked port is never requested', async () => {
  const net = makeNetwork({
    'https://shop.co.ke/': { body: '<a href="https://shop.co.ke:5432/contact">Contact</a><a href="mailto:hello@shop.co.ke">m</a>' },
  });
  const { pool } = await analyzeWith(net, async () => PUBLIC);
  assert.deepEqual(net.requested, ['https://shop.co.ke/']);
  assert.ok(typeOf(pool, 'email').length === 1);
});

test('ssrf: off-site contact links are not fetched', async () => {
  const net = makeNetwork({ 'https://shop.co.ke/': { body: '<a href="https://other.example/contact">Contact</a>' } });
  await analyzeWith(net, async () => PUBLIC);
  assert.deepEqual(net.requested, ['https://shop.co.ke/']);
});

test('safeFetchHomepage: exposes the body as `html` (in memory) and caps it at maxBytes', async () => {
  const net = makeNetwork({ 'https://shop.co.ke/': { body: '<p>' + 'x'.repeat(5000) + '</p>' } });
  const result = await safeFetchHomepage('https://shop.co.ke', { lookup: async () => PUBLIC, maxBytes: 100, ...net });
  assert.equal(result.status, 'completed');
  assert.equal(typeof result.html, 'string');
  assert.ok(result.html.length <= 100);
});

// ---------------------------------------------------------------------
// Persistence: upsert, businesses.email, best-effort
// ---------------------------------------------------------------------

const HOMEPAGE = { status: 'completed', httpStatus: 200, finalUrl: 'https://shop.co.ke/', html: '<a href="mailto:a@shop.co.ke">a</a><a href="https://instagram.com/shopke">ig</a>' };

test('persist: re-analysis updates found_at/source_url instead of duplicating rows', async () => {
  const pool = makeFakePool();
  const run = (iso) => extractAndStoreContacts(pool, { businessId: BUSINESS_ID, homepage: HOMEPAGE, fetchPage: async () => ({}), now: () => new Date(iso) });

  await run('2026-01-01T00:00:00.000Z');
  const idsAfterFirst = [...pool.contacts.values()].map((c) => c.id).sort();
  await run('2026-02-02T00:00:00.000Z');

  assert.equal(pool.contacts.size, 2, 'no duplicates');
  assert.deepEqual([...pool.contacts.values()].map((c) => c.id).sort(), idsAfterFirst);
  for (const c of pool.contacts.values()) assert.equal(c.found_at, '2026-02-02T00:00:00.000Z');
});

test('persist: businesses.email is filled only when NULL, never overwritten', async () => {
  const empty = makeFakePool({ email: null });
  await extractAndStoreContacts(empty, { businessId: BUSINESS_ID, homepage: HOMEPAGE, fetchPage: async () => ({}) });
  assert.equal(empty.business.email, 'a@shop.co.ke');

  const filled = makeFakePool({ email: 'owner@manual.example' });
  await extractAndStoreContacts(filled, { businessId: BUSINESS_ID, homepage: HOMEPAGE, fetchPage: async () => ({}) });
  assert.equal(filled.business.email, 'owner@manual.example');
  assert.equal(filled.contacts.size, 2, 'contacts are still stored');
});

test('best-effort: a database failure in extraction never throws', async () => {
  const pool = makeFakePool({ failContacts: true });
  const result = await extractAndStoreContacts(pool, { businessId: BUSINESS_ID, homepage: HOMEPAGE, fetchPage: async () => ({}) });
  assert.deepEqual(result, { stored: 0, error: 'CONTACT_EXTRACTION_FAILED' });
});

test('best-effort: contact failure cannot fail or downgrade the analysis', async () => {
  const net = makeNetwork({ 'https://shop.co.ke/': { body: HOME_HTML }, 'https://shop.co.ke/contact': { body: CONTACT_HTML } });
  const { row, pool } = await analyzeWith(net, async () => PUBLIC, makeFakePool({ failContacts: true }));

  assert.equal(row.analysis_status, 'completed');
  assert.equal(pool.analyses.length, 1, 'the analysis row was saved exactly once');
  assert.equal(pool.contacts.size, 0);
});

test('best-effort: analysis with no html (stubbed homepage) touches no contact tables', async () => {
  const pool = makeFakePool();
  const row = await analyzeBusinessWebsite(pool, BUSINESS_ID, {
    skipPageSpeed: true,
    fetchHomepage: async () => ({ status: 'completed', finalUrl: 'https://shop.co.ke/', httpStatus: 200, httpsEnabled: true, responseTimeMs: 1, htmlSizeBytes: 1, truncated: false, pageTitle: null, metaDescription: null, viewportPresent: true, errorCode: null, errorMessage: null }),
  });
  assert.equal(row.analysis_status, 'completed');
  assert.equal(pool.contacts.size, 0);
});

test('analysis: a homepage that was not fetched successfully stores no contacts', async () => {
  const net = makeNetwork({ 'https://shop.co.ke/': { statusCode: 500, body: '<a href="mailto:a@shop.co.ke">a</a>' } });
  const { pool } = await analyzeWith(net, async () => PUBLIC);
  assert.equal(pool.contacts.size, 0);
});

// ---------------------------------------------------------------------
// Reading + presenting (GET /api/leads/:id `contacts`)
// ---------------------------------------------------------------------

test('loadContacts: best-effort -- a missing table (unmigrated DB) yields empty data, not an error', async () => {
  const pool = { query: async () => Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })) };
  assert.deepEqual(await loadContacts(pool, BUSINESS_ID), { rows: [], internationalPhone: null });
});

test('summary: phone block -- tel always, wa.me ONLY with an international number', () => {
  const noIntl = buildContactsSummary({ phone: '020 123 4567', website_url: 'https://x.co', name: 'X' }, { rows: [], internationalPhone: null });
  assert.equal(noIntl.phone.tel_href, 'tel:0201234567');
  assert.equal(noIntl.phone.whatsapp_href, null, 'never guess a country code');

  const withIntl = buildContactsSummary({ phone: '020 123 4567', website_url: 'https://x.co', name: 'X' }, { rows: [], internationalPhone: '+254 20 123 4567' });
  assert.equal(withIntl.phone.tel_href, 'tel:+254201234567');
  assert.equal(withIntl.phone.whatsapp_href, 'https://wa.me/254201234567');

  assert.equal(buildContactsSummary({ website_url: 'https://x.co' }, { rows: [], internationalPhone: null }).phone, null);
});

test('summary: no website -> Google + Instagram search helpers built from name and city; with a website -> none', () => {
  const noSite = buildContactsSummary({ phone: '020 123 4567', name: 'Sharp Cuts', city: 'Nairobi', website_url: null }, { rows: [], internationalPhone: null });
  assert.equal(noSite.search_links.google, 'https://www.google.com/search?q=Sharp%20Cuts%20Nairobi');
  assert.equal(noSite.search_links.instagram, 'https://www.google.com/search?q=site%3Ainstagram.com%20Sharp%20Cuts%20Nairobi');

  assert.equal(buildContactsSummary({ name: 'Sharp Cuts', website_url: 'https://x.co' }, { rows: [], internationalPhone: null }).search_links, null);
  assert.equal(buildSearchLinks('', ''), null);
  assert.ok(!buildSearchLinks('A&B "x" <y>', 'Z').google.includes('<'), 'name is URL-encoded');
});

test('summary: groups stored rows by kind and sets the has_* flags', () => {
  const meta = { source_url: 'https://shop.co.ke/', found_at: '2026-01-01T00:00:00.000Z' };
  const rows = [
    { contact_type: 'email', value: 'a@shop.co.ke', ...meta },
    { contact_type: 'instagram', value: 'https://www.instagram.com/shopke/', ...meta },
    { contact_type: 'whatsapp', value: 'https://wa.me/254712345678', ...meta },
    { contact_type: 'phone', value: '+254201234567', ...meta },
    { contact_type: 'contact_page', value: 'https://shop.co.ke/contact', ...meta },
  ];
  const s = buildContactsSummary({ phone: null, email: null, name: 'Shop', website_url: 'https://shop.co.ke' }, { rows, internationalPhone: null });

  assert.deepEqual(s.emails, [{ value: 'a@shop.co.ke', href: 'mailto:a@shop.co.ke', ...meta }]);
  assert.deepEqual(s.socials, [{ platform: 'instagram', url: 'https://www.instagram.com/shopke/', ...meta }]);
  assert.deepEqual(s.whatsapp, [{ url: 'https://wa.me/254712345678', ...meta }]);
  assert.deepEqual(s.phones, [{ value: '+254201234567', href: 'tel:+254201234567', ...meta }]);
  assert.deepEqual(s.contact_page, { url: 'https://shop.co.ke/contact', ...meta });
  assert.deepEqual(s.summary, { has_phone: true, has_email: true, has_social: true, has_whatsapp: true });
});

test('summary: a manually stored business email is listed (without source) unless it is junk or a duplicate', () => {
  const s = buildContactsSummary({ email: 'Owner@Shop.co.ke', website_url: 'https://x.co' }, { rows: [], internationalPhone: null });
  assert.deepEqual(s.emails, [{ value: 'owner@shop.co.ke', href: 'mailto:owner@shop.co.ke', source_url: null, found_at: null }]);
  assert.deepEqual(buildContactsSummary({ email: 'logo@2x.png', website_url: 'https://x.co' }, { rows: [], internationalPhone: null }).emails, []);
});
