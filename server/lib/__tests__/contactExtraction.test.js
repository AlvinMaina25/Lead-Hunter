const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EMAILS,
  decodeEntities,
  normalizeEmail,
  parseTelHref,
  normalizeWhatsAppLink,
  classifySocialUrl,
  findContactPageUrl,
  extractContacts,
} = require('../contactExtraction');

const BASE = 'https://shop.co.ke/';
const emailValues = (html) => extractContacts(html, BASE).emails.map((e) => e.value);

// ---------------------------------------------------------------------
// Emails: priority, normalization, caps
// ---------------------------------------------------------------------

test('emails: mailto first, then plain text; lowercased and deduped', () => {
  const html = `
    <p>Write to Hello@Shop.co.ke or sales@shop.co.ke</p>
    <a href="mailto:Sales@Shop.co.ke?subject=Hi%20there">Email us</a>
    <a href="mailto:Owner@shop.co.ke">Owner</a>`;
  const result = extractContacts(html, BASE).emails;

  assert.deepEqual(result, [
    { value: 'sales@shop.co.ke', via: 'mailto' },
    { value: 'owner@shop.co.ke', via: 'mailto' },
    { value: 'hello@shop.co.ke', via: 'text' },
  ]);
});

test('emails: capped at 5', () => {
  const html = Array.from({ length: 9 }, (_, i) => `<p>person${i}@shop.co.ke</p>`).join('');
  assert.equal(extractContacts(html, BASE).emails.length, MAX_EMAILS);
  assert.equal(MAX_EMAILS, 5);
});

test('emails: mailto with several recipients, %40 encoding and entity-obfuscated @', () => {
  assert.deepEqual(emailValues('<a href="mailto:a@shop.co.ke,b@shop.co.ke">x</a>'), ['a@shop.co.ke', 'b@shop.co.ke']);
  assert.deepEqual(emailValues('<a href="mailto:info%40shop.co.ke">x</a>'), ['info@shop.co.ke']);
  assert.deepEqual(emailValues('<p>info&#64;shop.co.ke and sales&commat;shop.co.ke</p>'), ['info@shop.co.ke', 'sales@shop.co.ke']);
});

test('emails: reads JSON-LD, but not minified scripts, styles or comments', () => {
  const html = `
    <script>var dsn = 'abc@sentry.io'; var x = 'leak@shop.co.ke';</script>
    <style>@media print { a { content: "css@shop.co.ke" } }</style>
    <!-- commented@shop.co.ke -->
    <script type="application/ld+json">{"@type":"LocalBusiness","email":"real@shop.co.ke"}</script>`;
  assert.deepEqual(emailValues(html), ['real@shop.co.ke']);
});

// ---------------------------------------------------------------------
// Emails: junk filtering
// ---------------------------------------------------------------------

test('junk: image/asset filenames that look like addresses (name@2x.png) are dropped', () => {
  for (const junk of ['logo@2x.png', 'hero@3x.jpg', 'icon@2x.webp', 'sprite@1x.svg', 'bundle@2.js', 'font@v2.woff2', 'a@b.css']) {
    assert.equal(normalizeEmail(junk), null, junk);
  }
  assert.deepEqual(emailValues('<img src="/img/logo@2x.png" srcset="/img/hero@2x.jpg 2x"> <p>real@shop.co.ke</p>'), ['real@shop.co.ke']);
});

test('junk: placeholder and example domains are dropped', () => {
  for (const junk of [
    'name@example.com', 'someone@example.org', 'info@domain.com', 'you@yourdomain.com', 'me@email.com',
    'contact@yoursite.com', 'x@mysite.com', 'a@test.com', 'user@company.com', 'info@website.com',
    'a@b.invalid', 'a@host.test', 'a@thing.localhost', 'a@thing.local',
  ]) {
    assert.equal(normalizeEmail(junk), null, junk);
  }
});

test('junk: placeholder local parts and no-reply addresses are dropped', () => {
  for (const junk of ['yourname@gmail.com', 'your-email@gmail.com', 'john.doe@gmail.com', 'username@gmail.com', 'noreply@shop.co.ke', 'no-reply@shop.co.ke', 'do-not-reply@shop.co.ke', 'mailer-daemon@shop.co.ke']) {
    assert.equal(normalizeEmail(junk), null, junk);
  }
});

test('junk: tracking / error-reporting addresses are dropped', () => {
  for (const junk of [
    'abcdef0123456789abcdef0123456789@sentry.io',
    'abcdef0123456789abcdef0123@o4504.ingest.sentry.io',
    'a1b2c3@sentry-next.wixpress.com',
    'user@sentry.wixpress.com',
    'abcdef0123456789abcdef0123456789@shop.co.ke', // long hex id on an ordinary domain
  ]) {
    assert.equal(normalizeEmail(junk), null, junk);
  }
});

test('junk: malformed addresses are dropped', () => {
  for (const junk of ['', '   ', 'plainaddress', '@shop.co.ke', 'a@', 'a b@shop.co.ke', '.a@shop.co.ke', 'a.@shop.co.ke', 'a..b@shop.co.ke', 'a@shop', 'a@-shop.com', 'a@shop..com', 'a@1.2.3.4', null, undefined, 42]) {
    assert.equal(normalizeEmail(junk), null, String(junk));
  }
});

test('junk: real addresses survive normalization (case, trailing punctuation, plus tags)', () => {
  assert.equal(normalizeEmail('Info@Shop.CO.KE'), 'info@shop.co.ke');
  assert.equal(normalizeEmail('info@shop.co.ke.'), 'info@shop.co.ke');
  assert.equal(normalizeEmail('<info@shop.co.ke>'), 'info@shop.co.ke');
  assert.equal(normalizeEmail('sales+web@shop.co.ke'), 'sales+web@shop.co.ke');
  assert.equal(normalizeEmail('info@gmail.com'), 'info@gmail.com');
});

test('never guesses: a page with no address yields no emails, not info@domain', () => {
  assert.deepEqual(extractContacts('<html><body><h1>Shop</h1><p>Call us on 020 123 4567</p></body></html>', BASE).emails, []);
});

// ---------------------------------------------------------------------
// Social links
// ---------------------------------------------------------------------

test('socials: profile URLs are accepted and rebuilt canonically (tracking params dropped)', () => {
  assert.deepEqual(classifySocialUrl('https://www.instagram.com/shopke/?hl=en&utm_source=x'), { type: 'instagram', value: 'https://www.instagram.com/shopke/' });
  assert.deepEqual(classifySocialUrl('https://instagram.com/shop.ke'), { type: 'instagram', value: 'https://www.instagram.com/shop.ke/' });
  assert.deepEqual(classifySocialUrl('https://facebook.com/ShopKE?ref=x'), { type: 'facebook', value: 'https://www.facebook.com/ShopKE' });
  assert.deepEqual(classifySocialUrl('https://www.facebook.com/profile.php?id=100012345678901'), { type: 'facebook', value: 'https://www.facebook.com/profile.php?id=100012345678901' });
  assert.deepEqual(classifySocialUrl('https://www.facebook.com/pages/Shop-KE/123456789'), { type: 'facebook', value: 'https://www.facebook.com/pages/Shop-KE/123456789' });
  assert.deepEqual(classifySocialUrl('https://www.tiktok.com/@shop.ke?lang=en'), { type: 'tiktok', value: 'https://www.tiktok.com/@shop.ke' });
  assert.deepEqual(classifySocialUrl('https://twitter.com/shopke'), { type: 'x', value: 'https://x.com/shopke' });
  assert.deepEqual(classifySocialUrl('https://x.com/shopke'), { type: 'x', value: 'https://x.com/shopke' });
  assert.deepEqual(classifySocialUrl('https://ke.linkedin.com/company/shop-ke'), { type: 'linkedin', value: 'https://www.linkedin.com/company/shop-ke/' });
  assert.deepEqual(classifySocialUrl('https://www.linkedin.com/in/jane-doe-123/'), { type: 'linkedin', value: 'https://www.linkedin.com/in/jane-doe-123/' });
  assert.deepEqual(classifySocialUrl('https://www.youtube.com/@shopke'), { type: 'youtube', value: 'https://www.youtube.com/@shopke' });
  assert.deepEqual(classifySocialUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), { type: 'youtube', value: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv' });
});

test('socials: share / embed / post / login links are NOT profiles', () => {
  for (const link of [
    'https://www.facebook.com/sharer/sharer.php?u=https://shop.co.ke',
    'https://www.facebook.com/sharer.php?u=x',
    'https://www.facebook.com/dialog/share?app_id=1',
    'https://www.facebook.com/plugins/like.php?href=x',
    'https://www.facebook.com/tr?id=123&ev=PageView',
    'https://www.facebook.com/groups/12345',
    'https://www.facebook.com/events/12345',
    'https://www.facebook.com/profile.php',
    'https://www.facebook.com/',
    'https://www.instagram.com/p/CxYz123/',
    'https://www.instagram.com/reel/CxYz123/',
    'https://www.instagram.com/explore/tags/nairobi/',
    'https://www.instagram.com/accounts/login/',
    'https://www.instagram.com/',
    'https://www.tiktok.com/share?url=x',
    'https://www.tiktok.com/embed/123',
    'https://www.tiktok.com/@shop/video/123456',
    'https://twitter.com/someone/status/123456789',
    'https://www.instagram.com/someone/p/CxYz123/',
    'https://www.facebook.com/SomePage/posts/123456',
    'https://www.facebook.com/SomePage/photos/a.123/456',
    'https://www.youtube.com/@someone/videos',
    'https://www.linkedin.com/company/shop-ke/posts/',
    'https://twitter.com/intent/tweet?text=hello',
    'https://twitter.com/share?url=x',
    'https://x.com/home',
    'https://x.com/i/status/123',
    'https://www.linkedin.com/shareArticle?mini=true&url=x',
    'https://www.linkedin.com/sharing/share-offsite/?url=x',
    'https://www.linkedin.com/feed/',
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://www.youtube.com/embed/abcdefghijk',
    'https://www.youtube.com/shorts/abcdefghijk',
    'https://www.youtube.com/playlist?list=PL123',
    'https://youtu.be/abcdefghijk',
  ]) {
    assert.equal(classifySocialUrl(link), null, link);
  }
});

test('socials: look-alike hosts, credentials and non-http schemes are rejected', () => {
  for (const link of [
    'https://facebook.com.evil.example/shopke',
    'https://notfacebook.com/shopke',
    'https://instagram.com@evil.example/shopke',
    'https://user:pw@instagram.com/shopke',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://instagram.com/shopke',
    'https://evil.example/instagram.com/shopke',
    'https://www.instagram.com/<script>/',
    'https://www.instagram.com/' + 'a'.repeat(200) + '/',
  ]) {
    assert.equal(classifySocialUrl(link), null, link);
  }
});

test('socials: relative and protocol-relative links resolve against the page', () => {
  assert.equal(classifySocialUrl('//www.instagram.com/shopke', BASE).value, 'https://www.instagram.com/shopke/');
});

test('socials: extractContacts keeps at most 2 per platform and dedupes', () => {
  const html = ['a', 'b', 'c', 'a'].map((h) => `<a href="https://instagram.com/${h}">x</a>`).join('')
    + '<a href="https://www.instagram.com/A/">dup, different case</a>';
  const instagram = extractContacts(html, BASE).socials.filter((s) => s.type === 'instagram');
  assert.deepEqual(instagram.map((s) => s.value), ['https://www.instagram.com/a/', 'https://www.instagram.com/b/']);
});

// ---------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------

test('whatsapp: wa.me and api.whatsapp.com number links normalize to wa.me/<digits>', () => {
  assert.equal(normalizeWhatsAppLink('https://wa.me/254712345678'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://wa.me/254712345678?text=Hello%20there'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://wa.me/+254712345678'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://api.whatsapp.com/send?phone=254712345678&text=Hi'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://api.whatsapp.com/send/?phone=%2B254712345678'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://web.whatsapp.com/send?phone=254712345678'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('whatsapp://send?phone=254712345678'), 'https://wa.me/254712345678');
  assert.equal(normalizeWhatsAppLink('https://wa.me/message/ABCDEF123456'), 'https://wa.me/message/ABCDEF123456');
});

test('whatsapp: share links, group invites and numbers without a country code are rejected', () => {
  for (const link of [
    'https://wa.me/?text=check%20this%20out',
    'https://wa.me/',
    'https://api.whatsapp.com/send?text=check%20this',
    'https://api.whatsapp.com/send',
    'https://chat.whatsapp.com/InviteCode123',
    'https://wa.me/0712345678',          // national format: would need a guessed country code
    'https://wa.me/00254712345678',      // "00" prefix is not E.164 either
    'https://wa.me/12345',               // too short
    'https://wa.me/1234567890123456789', // too long
    'https://wa.me.evil.example/254712345678',
    'https://evilwa.me/254712345678',
    'javascript:alert(1)',
  ]) {
    assert.equal(normalizeWhatsAppLink(link), null, link);
  }
});

// ---------------------------------------------------------------------
// tel:
// ---------------------------------------------------------------------

test('tel: parsed to digits with an optional leading + (nothing invented)', () => {
  assert.equal(parseTelHref('tel:+254 20 123 4567'), '+254201234567');
  assert.equal(parseTelHref('tel:+254-20-123-4567'), '+254201234567');
  assert.equal(parseTelHref('tel:020%20123%204567'), '0201234567', 'national format is kept as-is, no country code added');
  assert.equal(parseTelHref('TEL:(020) 123-4567'), '0201234567');
  assert.equal(parseTelHref('tel:+254201234567;ext=12'), '+254201234567');
});

test('tel: rejects junk', () => {
  for (const href of ['tel:', 'tel:abc', 'tel:12345', 'tel:0000000', 'tel:1234567890123456', 'tel:javascript:alert(1)', 'tel:12+3456789', 'mailto:a@b.com', 'https://x.com/tel:123456789']) {
    assert.equal(parseTelHref(href), null, href);
  }
});

test('extractContacts: whatsapp and tel numbers are returned separately and capped', () => {
  const html = `
    <a href="https://wa.me/254712345678">WhatsApp</a>
    <a href="tel:+254201234567">Call</a>
    <a href="tel:+254201234568">Call</a><a href="tel:+254201234569">Call</a><a href="tel:+254201234560">Call</a>`;
  const result = extractContacts(html, BASE);
  assert.deepEqual(result.whatsapp, ['https://wa.me/254712345678']);
  assert.equal(result.phones.length, 3);
  assert.equal(result.phones[0], '+254201234567');
});

// ---------------------------------------------------------------------
// Contact page discovery
// ---------------------------------------------------------------------

test('findContactPageUrl: prefers /contact paths, then link text "contact", then /about', () => {
  assert.equal(
    findContactPageUrl('<a href="/about">About</a><a href="/get-in-touch">Contact us</a><a href="/contact-us/">Reach us</a>', BASE),
    'https://shop.co.ke/contact-us/'
  );
  assert.equal(findContactPageUrl('<a href="/about">About</a><a href="/get-in-touch">Contact us</a>', BASE), 'https://shop.co.ke/get-in-touch');
  assert.equal(findContactPageUrl('<a href="/about-us">Our story</a>', BASE), 'https://shop.co.ke/about-us');
  assert.equal(findContactPageUrl('<a href="/products">Products</a>', BASE), null);
});

test('findContactPageUrl: returns at most one URL, same site only (www-insensitive)', () => {
  assert.equal(findContactPageUrl('<a href="https://other.example/contact">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="https://www.shop.co.ke/contact">Contact</a>', BASE), 'https://www.shop.co.ke/contact');
  assert.equal(findContactPageUrl('<a href="https://shop.co.ke.evil.example/contact">Contact</a>', BASE), null);
  assert.equal(typeof findContactPageUrl('<a href="/contact">c</a><a href="/contact-us">c</a>', BASE), 'string');
});

test('findContactPageUrl: skips non-pages, non-http schemes and the page itself', () => {
  assert.equal(findContactPageUrl('<a href="/contact.pdf">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="mailto:contact@shop.co.ke">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="javascript:void(0)">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="tel:+254201234567">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="#contact">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="/">Contact</a>', BASE), null);
  assert.equal(findContactPageUrl('<a href="/contact#form">Contact</a>', 'https://shop.co.ke/contact'), null);
});

test('findContactPageUrl: strips fragments and handles .html/.php page extensions', () => {
  assert.equal(findContactPageUrl('<a href="/contact.html#map">x</a>', BASE), 'https://shop.co.ke/contact.html');
  assert.equal(findContactPageUrl('<a href="contact-us.php">x</a>', 'https://shop.co.ke/en/'), 'https://shop.co.ke/en/contact-us.php');
});

// ---------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------

test('robustness: garbage input never throws', () => {
  for (const input of [null, undefined, 42, {}, '', '<', '<a', '<a href', '<a href="', '\u0000\u0001', '<<<<>>>>', '&#;&;&#x;&#xZZ;']) {
    assert.doesNotThrow(() => extractContacts(input, BASE));
    assert.doesNotThrow(() => findContactPageUrl(input, BASE));
  }
  assert.deepEqual(extractContacts(null, BASE), { emails: [], socials: [], whatsapp: [], phones: [] });
});

test('robustness: control characters in values are rejected, not stored', () => {
  assert.equal(normalizeEmail('a\nb@shop.co.ke'), null);
  assert.equal(classifySocialUrl('https://instagram.com/sho\npke'), null);
  assert.equal(normalizeWhatsAppLink('https://wa.me/2547123\n45678'), null);
});

test('robustness: pathological markup is processed in bounded time (no quadratic regexes)', () => {
  const started = Date.now();
  const hostile = [
    '<script>'.repeat(50000),
    '<a href="x">'.repeat(50000),
    '<!--'.repeat(50000),
    '<style>'.repeat(50000),
    'a'.repeat(1_000_000) + '@',
    ('a@' + 'b'.repeat(70) + '.').repeat(10000),
  ];
  for (const html of hostile) {
    extractContacts(html, BASE);
    findContactPageUrl(html, BASE);
  }
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('decodeEntities: decodes the entities that matter and leaves the rest alone', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('info&#64;x.com'), 'info@x.com');
  assert.equal(decodeEntities('info&#x40;x.com'), 'info@x.com');
  assert.equal(decodeEntities('x&unknown;y'), 'x&unknown;y');
  assert.equal(decodeEntities('&#0;&#1;'), '&#0;&#1;', 'control-code entities are not decoded');
});
