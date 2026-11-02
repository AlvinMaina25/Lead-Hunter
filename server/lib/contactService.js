/**
 * Website contacts: collect -> persist -> load -> present.
 *
 * - collectWebsiteContacts / extractAndStoreContacts run during website
 *   analysis (see websiteAnalysis.js). They reuse the homepage HTML the
 *   analysis already fetched and make AT MOST ONE more request: a
 *   single same-site contact page, fetched through the SAME
 *   SSRF-guarded, size- and time-limited function the homepage uses
 *   (injected as `fetchPage`; no new HTTP client).
 *
 * - extractAndStoreContacts NEVER THROWS. Contact extraction is
 *   best-effort and must not fail or downgrade an analysis.
 *
 * - loadContacts / buildContactsSummary assemble the `contacts` block of
 *   GET /api/leads/:id.
 *
 * Nothing here guesses: stored contacts are only what was found on the
 * site, each with the page it came from and when it was found.
 */

'use strict';

const {
  MAX_EMAILS,
  MAX_SOCIAL_PER_PLATFORM,
  MAX_WHATSAPP,
  MAX_PHONES,
  normalizeEmail,
  extractContacts,
  findContactPageUrl,
} = require('./contactExtraction');
const { buildTelHref, buildWhatsAppHref, toE164Digits } = require('./phone');

const SOCIAL_TYPES = Object.freeze(['instagram', 'facebook', 'tiktok', 'x', 'linkedin', 'youtube']);

/** The contact page is a single small extra GET; keep it tighter than the homepage's budget. */
const CONTACT_PAGE_TIMEOUT_MS = 8000;
const CONTACT_PAGE_MAX_BYTES = 1024 * 1024; // 1 MB

function sameSite(urlA, urlB) {
  try {
    const strip = (u) => new URL(u).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    return strip(urlA) === strip(urlB);
  } catch {
    return false;
  }
}

function isOkHtmlResult(result) {
  return (
    result &&
    result.status === 'completed' &&
    typeof result.html === 'string' &&
    result.html.length > 0 &&
    Number.isInteger(result.httpStatus) &&
    result.httpStatus >= 200 &&
    result.httpStatus < 300
  );
}

/**
 * Builds the list of contacts to store for one business.
 *
 * @param {{
 *   homepage: { finalUrl?: string|null, html?: string|null, status?: string, httpStatus?: number|null },
 *   fetchPage: (url: string, options: object) => Promise<object>,
 *   fetchOptions?: { lookup?: Function, httpModule?: object, httpsModule?: object },
 * }} input
 * @returns {Promise<Array<{ contact_type: string, value: string, source_url: string }>>}
 */
async function collectWebsiteContacts({ homepage, fetchPage, fetchOptions = {} }) {
  if (!isOkHtmlResult(homepage) || !homepage.finalUrl) return [];

  const homepageUrl = homepage.finalUrl;
  const pages = [{ url: homepageUrl, extracted: extractContacts(homepage.html, homepageUrl) }];

  const contactPageUrl = findContactPageUrl(homepage.html, homepageUrl);
  if (contactPageUrl) {
    try {
      // Exactly one extra request, via the same guarded fetch as the homepage.
      const contactPage = await fetchPage(contactPageUrl, {
        timeoutMs: CONTACT_PAGE_TIMEOUT_MS,
        maxBytes: CONTACT_PAGE_MAX_BYTES,
        lookup: fetchOptions.lookup,
        httpModule: fetchOptions.httpModule,
        httpsModule: fetchOptions.httpsModule,
      });
      // The page must still be on the business's own site after redirects;
      // never harvest contacts from a third party's page.
      if (isOkHtmlResult(contactPage) && sameSite(contactPage.finalUrl || contactPageUrl, homepageUrl)) {
        const finalUrl = contactPage.finalUrl || contactPageUrl;
        pages.push({ url: finalUrl, extracted: extractContacts(contactPage.html, finalUrl) });
      }
    } catch {
      /* best-effort: ignore and keep what the homepage gave us */
    }
  }

  const items = [];
  const seen = new Set();
  const push = (contact_type, value, source_url) => {
    const key = `${contact_type}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ contact_type, value, source_url });
  };

  // Emails: every mailto: (homepage first) before any plain-text match.
  const emailCandidates = [];
  for (const page of pages) {
    for (const email of page.extracted.emails) emailCandidates.push({ ...email, source_url: page.url });
  }
  const orderedEmails = [
    ...emailCandidates.filter((e) => e.via === 'mailto'),
    ...emailCandidates.filter((e) => e.via !== 'mailto'),
  ];
  const emailSeen = new Set();
  let emailCount = 0;
  for (const email of orderedEmails) {
    if (emailCount >= MAX_EMAILS || emailSeen.has(email.value)) continue;
    emailSeen.add(email.value);
    emailCount += 1;
    push('email', email.value, email.source_url);
  }

  const perPlatform = {};
  let whatsappCount = 0;
  let phoneCount = 0;
  for (const page of pages) {
    for (const social of page.extracted.socials) {
      if ((perPlatform[social.type] || 0) >= MAX_SOCIAL_PER_PLATFORM) continue;
      const before = items.length;
      push(social.type, social.value, page.url);
      if (items.length > before) perPlatform[social.type] = (perPlatform[social.type] || 0) + 1;
    }
    for (const wa of page.extracted.whatsapp) {
      if (whatsappCount >= MAX_WHATSAPP) break;
      const before = items.length;
      push('whatsapp', wa, page.url);
      if (items.length > before) whatsappCount += 1;
    }
    for (const phone of page.extracted.phones) {
      if (phoneCount >= MAX_PHONES) break;
      const before = items.length;
      push('phone', phone, page.url);
      if (items.length > before) phoneCount += 1;
    }
  }

  if (contactPageUrl) push('contact_page', contactPageUrl, homepageUrl);

  return items;
}

/**
 * Upserts contacts: a re-analysis refreshes source_url/found_at on the
 * existing (business, type, value) row instead of adding a duplicate.
 * One multi-row statement; contacts no longer found are left alone.
 *
 * @param {{query: Function}} pool
 * @param {string} businessId
 * @param {Array<{ contact_type: string, value: string, source_url: string }>} items
 * @param {string} foundAtIso
 * @returns {Promise<number>} number of contacts written
 */
async function saveWebsiteContacts(pool, businessId, items, foundAtIso) {
  if (items.length === 0) return 0;

  const params = [businessId, foundAtIso];
  const tuples = items.map((item) => {
    params.push(item.contact_type, item.value, item.source_url);
    const n = params.length;
    return `($1, $${n - 2}, $${n - 1}, $${n}, $2)`;
  });

  await pool.query(
    `
      INSERT INTO business_contacts (business_id, contact_type, value, source_url, found_at)
      VALUES ${tuples.join(', ')}
      ON CONFLICT (business_id, contact_type, value)
      DO UPDATE SET source_url = EXCLUDED.source_url, found_at = EXCLUDED.found_at
    `,
    params
  );
  return items.length;
}

/**
 * Fills businesses.email ONLY when it is currently NULL; an existing
 * value is never overwritten.
 */
async function fillBusinessEmailIfEmpty(pool, businessId, email) {
  await pool.query(`UPDATE businesses SET email = $2 WHERE id = $1 AND email IS NULL`, [businessId, email]);
}

/**
 * The analysis hook. Collects, stores, and (if empty) fills
 * businesses.email. NEVER THROWS -- any failure is logged (error code
 * only) and reported in the return value.
 *
 * @returns {Promise<{ stored: number, error: string|null }>}
 */
async function extractAndStoreContacts(pool, { businessId, homepage, fetchPage, fetchOptions, now = () => new Date() }) {
  try {
    const items = await collectWebsiteContacts({ homepage, fetchPage, fetchOptions });
    if (items.length === 0) return { stored: 0, error: null };

    const stored = await saveWebsiteContacts(pool, businessId, items, now().toISOString());

    const firstEmail = items.find((i) => i.contact_type === 'email');
    if (firstEmail) await fillBusinessEmailIfEmpty(pool, businessId, firstEmail.value);

    return { stored, error: null };
  } catch (err) {
    console.warn('[contacts] extraction skipped for business', businessId, '-', err && err.code ? err.code : 'error');
    return { stored: 0, error: 'CONTACT_EXTRACTION_FAILED' };
  }
}

// ---------------------------------------------------------------------
// Reading + presenting
// ---------------------------------------------------------------------

/**
 * Loads stored contacts plus the Google international phone for one
 * business. BEST-EFFORT: if migration 009 hasn't been applied yet (or
 * the read fails), returns empty data so the lead detail still loads.
 *
 * @returns {Promise<{ rows: object[], internationalPhone: string|null }>}
 */
async function loadContacts(pool, businessId) {
  try {
    const [contacts, phone] = await Promise.all([
      pool.query(
        `
          SELECT contact_type, value, source_url, found_at
          FROM business_contacts
          WHERE business_id = $1
          ORDER BY created_at ASC, value ASC
        `,
        [businessId]
      ),
      pool.query(`SELECT international_phone FROM businesses WHERE id = $1`, [businessId]),
    ]);
    return {
      rows: contacts.rows,
      internationalPhone: phone.rows[0] ? phone.rows[0].international_phone || null : null,
    };
  } catch (err) {
    console.warn('[contacts] could not load contacts -', err && err.code ? err.code : 'error');
    return { rows: [], internationalPhone: null };
  }
}

/** Google web search links for a business we can't reach through a website. */
function buildSearchLinks(name, city) {
  const label = [name, city].filter((v) => typeof v === 'string' && v.trim()).join(' ').trim();
  if (!label) return null;
  const q = (text) => `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  return { google: q(label), instagram: q(`site:instagram.com ${label}`) };
}

/**
 * Shapes the `contacts` block of GET /api/leads/:id. Pure.
 *
 * Phone block (all businesses): Google's national number, Google's
 * international number (if fetched), a tel: link, and a wa.me link that
 * exists ONLY when we have an international number. The wa.me link is
 * "try it" -- we can't know the number is on WhatsApp.
 *
 * @param {{ phone?: string|null, email?: string|null, name?: string|null, city?: string|null, website_url?: string|null }} business
 * @param {{ rows: object[], internationalPhone: string|null }} loaded
 */
function buildContactsSummary(business, loaded) {
  const rows = (loaded && loaded.rows) || [];
  const internationalPhone = (loaded && loaded.internationalPhone) || null;
  const of = (type) => rows.filter((r) => r.contact_type === type);
  const meta = (r) => ({ source_url: r.source_url, found_at: r.found_at });

  const nationalPhone = business.phone || null;
  const telSource = internationalPhone && toE164Digits(internationalPhone) ? internationalPhone : nationalPhone;
  const phone =
    nationalPhone || internationalPhone
      ? {
          national: nationalPhone,
          international: internationalPhone,
          tel_href: buildTelHref(telSource),
          whatsapp_href: buildWhatsAppHref(internationalPhone), // null without an international number
        }
      : null;

  const emails = of('email').map((r) => ({ value: r.value, href: `mailto:${r.value}`, ...meta(r) }));
  const businessEmail = normalizeEmail(business.email);
  if (businessEmail && !emails.some((e) => e.value === businessEmail)) {
    emails.unshift({ value: businessEmail, href: `mailto:${businessEmail}`, source_url: null, found_at: null });
  }

  const socials = rows
    .filter((r) => SOCIAL_TYPES.includes(r.contact_type))
    .map((r) => ({ platform: r.contact_type, url: r.value, ...meta(r) }));
  const whatsapp = of('whatsapp').map((r) => ({ url: r.value, ...meta(r) }));
  const phones = of('phone').map((r) => ({ value: r.value, href: `tel:${r.value}`, ...meta(r) }));
  const contactPageRow = of('contact_page')[0];

  return {
    phone,
    emails,
    phones,
    whatsapp,
    socials,
    contact_page: contactPageRow ? { url: contactPageRow.value, ...meta(contactPageRow) } : null,
    search_links: business.website_url ? null : buildSearchLinks(business.name, business.city),
    summary: {
      has_phone: Boolean(phone) || phones.length > 0,
      has_email: emails.length > 0,
      has_social: socials.length > 0,
      has_whatsapp: whatsapp.length > 0,
    },
  };
}

module.exports = {
  SOCIAL_TYPES,
  CONTACT_PAGE_TIMEOUT_MS,
  CONTACT_PAGE_MAX_BYTES,
  collectWebsiteContacts,
  saveWebsiteContacts,
  fillBusinessEmailIfEmpty,
  extractAndStoreContacts,
  loadContacts,
  buildSearchLinks,
  buildContactsSummary,
};
