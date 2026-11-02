/**
 * Contact extraction from a business's own website HTML.
 *
 * PURE: no network, no database. Given the HTML text of a page (and the
 * URL it was fetched from, to resolve relative links) this finds:
 *
 *   - email addresses   (mailto: links first, then plain text)
 *   - social profiles   (Instagram, Facebook, TikTok, X, LinkedIn,
 *                        YouTube -- profile URLs only, never share /
 *                        embed / post links)
 *   - WhatsApp links    (wa.me, api.whatsapp.com, web.whatsapp.com)
 *   - tel: numbers
 *   - one candidate "contact page" link on the same site
 *
 * RULES
 *   - NEVER GUESS. Only values literally present in the HTML are
 *     returned. There are no info@domain patterns, no handle guessing,
 *     and no country-code guessing (a WhatsApp number without its
 *     country code is rejected, not completed).
 *   - Social/WhatsApp URLs are rebuilt from the validated handle/number
 *     (canonical form), not copied verbatim, so tracking parameters and
 *     odd path suffixes never reach storage.
 *   - Every returned value is validated: http(s) URLs only, no
 *     credentials, no control characters.
 *   - Work is bounded: the scan is linear in the HTML size (no
 *     unbounded lazy regexes over attacker-controlled markup), anchors
 *     are capped, and results are capped.
 *
 * This module is best-effort by design. It never throws for malformed
 * input; unparsable things are simply skipped.
 */

'use strict';

const MAX_EMAILS = 5;
const MAX_SOCIAL_PER_PLATFORM = 2;
const MAX_WHATSAPP = 3;
const MAX_PHONES = 3;
const MAX_ANCHORS = 2000;
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  commat: '@',
  period: '.',
  colon: ':',
  sol: '/',
  nbsp: ' ',
});

/** Decodes the HTML entities that matter for hrefs and obfuscated addresses. */
function decodeEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value;
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** ASCII-only lowercase: unlike toLowerCase(), never changes string length, so indexes stay aligned. */
function asciiLower(value) {
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Removes whole <tag ...>...</tag> blocks in linear time (indexOf, not a
 * lazy regex, so a page full of unclosed tags can't cause quadratic
 * work). An unclosed block drops the rest of the document.
 *
 * @param {string} html
 * @param {string} tag
 * @param {(block: string) => boolean} [keep] return true to keep a block
 */
function stripTagBlocks(html, tag, keep) {
  const lower = asciiLower(html);
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let pos = 0;

  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) break;

    const delimiter = lower.charAt(start + open.length);
    if (!(delimiter === '>' || delimiter === '/' || /\s/.test(delimiter))) {
      out += html.slice(pos, start + open.length);
      pos = start + open.length;
      continue;
    }

    const closeStart = lower.indexOf(close, start);
    if (closeStart === -1) {
      out += html.slice(pos, start);
      pos = html.length;
      break;
    }
    const gt = lower.indexOf('>', closeStart);
    const end = gt === -1 ? html.length : gt + 1;
    const block = html.slice(start, end);
    out += html.slice(pos, start) + (keep && keep(block) ? block : ' ');
    pos = end;
  }

  return out + html.slice(pos);
}

function stripComments(html) {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) break;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) {
      out += html.slice(pos, start);
      pos = html.length;
      break;
    }
    out += html.slice(pos, start) + ' ';
    pos = end + 3;
  }
  return out + html.slice(pos);
}

/**
 * HTML prepared for scanning plain-text emails: comments, <style> and
 * ordinary <script> blocks removed (minified JS is a rich source of
 * false "emails"), but JSON-LD blocks kept -- schema.org markup is a
 * legitimate place for a business's real address.
 */
function htmlForTextScan(html) {
  const noComments = stripComments(html);
  const noStyle = stripTagBlocks(noComments, 'style');
  return stripTagBlocks(noStyle, 'script', (block) =>
    /type\s*=\s*["']?application\/ld\+json/i.test(block.slice(0, 300))
  );
}

/**
 * Reads the value of one attribute from the inside of an opening tag.
 * Handles double-quoted, single-quoted and unquoted values.
 */
function readAttribute(tagInner, name) {
  const pattern = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tagInner);
  if (!match) return null;
  const raw = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
  return decodeEntities(raw).trim();
}

/**
 * Every <a ...> in document order (capped), with its href and a short,
 * tag-stripped slice of its link text. The text slice is cut from a
 * fixed-size window after the tag, never searched for across the whole
 * document, so the cost stays linear.
 *
 * @returns {Array<{ href: string, text: string }>}
 */
function listAnchors(html) {
  const anchors = [];
  const tagPattern = /<a\b([^>]*)>/gi;
  let match;

  while ((match = tagPattern.exec(html)) !== null && anchors.length < MAX_ANCHORS) {
    const href = readAttribute(match[1], 'href');
    if (!href) continue;

    const windowStart = match.index + match[0].length;
    let text = html.slice(windowStart, windowStart + 300);
    const closeAt = asciiLower(text).indexOf('</a');
    if (closeAt !== -1) text = text.slice(0, closeAt);
    text = decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

    anchors.push({ href, text });
  }

  return anchors;
}

// ---------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------

/**
 * Resolves `href` against `baseUrl` and returns a URL only if it is a
 * plain http(s) URL without credentials and without control characters.
 *
 * @param {string} href
 * @param {string} [baseUrl]
 * @returns {URL|null}
 */
function parseHttpUrl(href, baseUrl) {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH || CONTROL_CHARS.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;

  let url;
  try {
    url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url;
}

function hostMatches(hostname, domain) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === domain || h.endsWith(`.${domain}`);
}

function pathSegments(url) {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function sameSite(a, b) {
  const strip = (h) => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return strip(a) === strip(b);
}

// ---------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------

const EMAIL_SHAPE = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

// Scans text; the lookahead stops a match swallowing the start of a longer word.
const EMAIL_IN_TEXT =
  /[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![a-z0-9_@-])/gi;

/** A "TLD" that is really a file extension: name@2x.png, sprite@1x.webp, ... */
const ASSET_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff',
  'css', 'js', 'mjs', 'json', 'xml', 'html', 'htm', 'php', 'asp', 'aspx', 'map',
  'pdf', 'zip', 'gz', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'mp3', 'webm', 'txt',
]);

/** Reserved / non-routable TLDs (RFC 2606 / 6761 and common private ones). */
const RESERVED_TLDS = new Set(['invalid', 'test', 'example', 'localhost', 'local', 'internal', 'lan', 'home', 'corp']);

/** Documentation / template domains that appear in themes and form plugins. */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu',
  'domain.com', 'domain.org', 'domain.net', 'yourdomain.com', 'yourdomain.org', 'mydomain.com',
  'yoursite.com', 'mysite.com', 'yourwebsite.com', 'website.com', 'site.com', 'sitename.com',
  'email.com', 'youremail.com', 'company.com', 'yourcompany.com', 'companyname.com',
  'test.com', 'sample.com', 'placeholder.com', 'address.com', 'mail.example',
]);

/** Error-tracking / infrastructure domains that embed machine addresses in page source. */
const TRACKING_DOMAINS = [
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'bugsnag.com', 'rollbar.com',
  'datadoghq.com', 'newrelic.com', 'segment.io', 'mixpanel.com',
];

const PLACEHOLDER_LOCALS = new Set([
  'name', 'yourname', 'your-name', 'your.name', 'fullname', 'full.name', 'firstname', 'firstname.lastname',
  'first.last', 'email', 'youremail', 'your-email', 'your.email', 'emailaddress', 'email.address',
  'user', 'username', 'user.name', 'johndoe', 'john.doe', 'janedoe', 'jane.doe', 'someone', 'example',
  'test', 'xxx', 'xxxx', 'you',
]);

const NO_REPLY_LOCALS = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|bounces?)$/;

/**
 * Normalizes one candidate address and decides whether it is a real,
 * usable contact. Returns the lowercase address, or null for junk.
 *
 * @param {unknown} candidate
 * @returns {string|null}
 */
function normalizeEmail(candidate) {
  if (typeof candidate !== 'string') return null;

  let value = decodeEntities(candidate).trim();
  if (CONTROL_CHARS.test(value)) return null;
  value = value.replace(/^<+|[>.,;:)\]}'"]+$/g, '').toLowerCase();
  if (value.length === 0 || value.length > 254 || !EMAIL_SHAPE.test(value)) return null;

  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (ASSET_TLDS.has(tld) || RESERVED_TLDS.has(tld)) return null;
  if (PLACEHOLDER_DOMAINS.has(domain)) return null;
  if (TRACKING_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  if (PLACEHOLDER_LOCALS.has(local) || NO_REPLY_LOCALS.test(local)) return null;
  // Long hex ids are machine identifiers (error-tracking DSNs, hashes), not mailboxes.
  if (/^[0-9a-f]{24,}$/.test(local)) return null;

  return value;
}

/** Addresses from one mailto: href (handles ?subject=, several recipients, %40). */
function emailsFromMailto(href) {
  if (!/^\s*mailto:/i.test(href)) return [];
  let rest = href.replace(/^\s*mailto:/i, '');
  const q = rest.indexOf('?');
  if (q !== -1) rest = rest.slice(0, q);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep as-is */
  }
  return rest
    .split(/[,;]/)
    .map(normalizeEmail)
    .filter(Boolean);
}

/**
 * @param {string} html
 * @param {Array<{href: string}>} anchors
 * @returns {Array<{ value: string, via: 'mailto'|'text' }>} mailto first, then text; deduped; capped
 */
function extractEmails(html, anchors) {
  const found = [];
  const seen = new Set();
  const add = (value, via) => {
    if (value && !seen.has(value)) {
      seen.add(value);
      found.push({ value, via });
    }
  };

  for (const { href } of anchors) {
    for (const email of emailsFromMailto(href)) add(email, 'mailto');
  }

  const scanText = decodeEntities(htmlForTextScan(html));
  const matches = scanText.match(EMAIL_IN_TEXT) || [];
  for (const raw of matches) add(normalizeEmail(raw), 'text');

  return found.slice(0, MAX_EMAILS);
}

// ---------------------------------------------------------------------
// tel: numbers
// ---------------------------------------------------------------------

/**
 * Parses a tel: href into digits with an optional leading "+". Nothing
 * is added: "0712 345 678" stays "0712345678" (no country code is
 * invented), "+254 712 345 678" becomes "+254712345678".
 *
 * @param {string} href
 * @returns {string|null}
 */
function parseTelHref(href) {
  if (!/^\s*tel:/i.test(href)) return null;
  let rest = href.replace(/^\s*tel:/i, '');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep as-is */
  }
  rest = rest.split(';')[0].trim(); // drop ;ext= / ;phone-context=
  if (!/^[+\d\s().\-]+$/.test(rest)) return null;

  const digits = rest.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null; // 0000000, 1111111
  if (rest.includes('+') && !rest.trim().startsWith('+')) return null;
  return rest.trim().startsWith('+') ? `+${digits}` : digits;
}

// ---------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------

function whatsappDigits(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  // A leading 0 means a national number (no country code): we cannot
  // build a working wa.me link from it without guessing, so reject.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
}

/**
 * Canonical WhatsApp contact URL for a wa.me / api.whatsapp.com /
 * web.whatsapp.com / whatsapp: link, or null. Share links without a
 * phone number (wa.me/?text=..., send?text=...), group invites and
 * numbers without a country code are all rejected.
 *
 * @param {string} href
 * @param {string} [baseUrl]
 * @returns {string|null}
 */
function normalizeWhatsAppLink(href, baseUrl) {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (CONTROL_CHARS.test(trimmed) || trimmed.length > MAX_URL_LENGTH) return null;

  if (/^whatsapp:/i.test(trimmed)) {
    const q = trimmed.indexOf('?');
    if (q === -1) return null;
    const digits = whatsappDigits(new URLSearchParams(trimmed.slice(q + 1)).get('phone') || '');
    return digits ? `https://wa.me/${digits}` : null;
  }

  const url = parseHttpUrl(trimmed, baseUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'wa.me') {
    const segments = pathSegments(url);
    if (segments.length === 2 && segments[0].toLowerCase() === 'message' && /^[A-Za-z0-9]{6,40}$/.test(segments[1])) {
      return `https://wa.me/message/${segments[1]}`;
    }
    if (segments.length === 1) {
      const digits = whatsappDigits(segments[0]);
      return digits ? `https://wa.me/${digits}` : null;
    }
    return null;
  }

  if (host === 'api.whatsapp.com' || host === 'web.whatsapp.com') {
    if (!/^\/send\/?$/i.test(url.pathname)) return null;
    const digits = whatsappDigits(url.searchParams.get('phone') || '');
    return digits ? `https://wa.me/${digits}` : null;
  }

  return null;
}

// ---------------------------------------------------------------------
// Social profiles
// ---------------------------------------------------------------------

const INSTAGRAM_RESERVED = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'stories', 'direct', 'share', 'about', 'developer',
  'legal', 'web', 'privacy', 'directory', 'challenge', 'oauth', 'static', 'emails', 'press', 'api', 'locations',
]);

const FACEBOOK_RESERVED = new Set([
  'sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'login.php', 'recover',
  'groups', 'events', 'watch', 'hashtag', 'photo', 'photo.php', 'photos', 'video', 'videos', 'story.php',
  'permalink.php', 'posts', 'l.php', 'policies', 'policy.php', 'help', 'privacy', 'terms', 'ads', 'business',
  'marketplace', 'gaming', 'reel', 'reels', 'public', 'stories', 'home.php', 'feed', 'v2.0', 'common', 'security',
  'about', 'careers', 'legal', 'community', 'friends', 'notifications', 'messages', 'bookmarks', 'places', 'search',
  'settings', 'directory', 'fbml', 'connect', 'i18n', 'ajax', 'rsrc.php', 'flx', 'campaign',
]);

const X_RESERVED = new Set([
  'share', 'intent', 'home', 'search', 'i', 'hashtag', 'login', 'signup', 'settings', 'explore', 'messages',
  'notifications', 'privacy', 'tos', 'about', 'compose', 'oauth', 'widgets.js', 'download', 'account', 'help',
]);

/**
 * Returns { type, value } with a canonical profile URL, or null when the
 * link is not a profile (share/embed/post/login links are all rejected).
 *
 * @param {string} href
 * @param {string} [baseUrl]
 * @returns {{ type: 'instagram'|'facebook'|'tiktok'|'x'|'linkedin'|'youtube', value: string }|null}
 */
function classifySocialUrl(href, baseUrl) {
  const url = parseHttpUrl(href, baseUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url);
  const first = segments[0];

  // Profile links only: any deeper path (/user/status/123, /@user/video/123,
  // /page/posts/123, ...) is a post or sub-page, possibly someone else's
  // content that the site merely embeds, so it is not treated as the
  // business's own profile.
  if (hostMatches(host, 'instagram.com')) {
    if (segments.length !== 1 || INSTAGRAM_RESERVED.has(first.toLowerCase()) || !/^[A-Za-z0-9._]{1,30}$/.test(first)) return null;
    return { type: 'instagram', value: `https://www.instagram.com/${first}/` };
  }

  if (hostMatches(host, 'facebook.com') || hostMatches(host, 'fb.com')) {
    if (!first) return null;
    const lowerFirst = first.toLowerCase();
    if (lowerFirst === 'profile.php') {
      const id = url.searchParams.get('id');
      return id && /^\d{5,20}$/.test(id)
        ? { type: 'facebook', value: `https://www.facebook.com/profile.php?id=${id}` }
        : null;
    }
    if (lowerFirst === 'people' || lowerFirst === 'pages') {
      const rest = segments.slice(1);
      if (rest.length === 0 || rest.length > 2 || !rest.every((s) => /^[A-Za-z0-9.\-_%]{1,100}$/.test(s))) return null;
      return { type: 'facebook', value: `https://www.facebook.com/${lowerFirst}/${rest.join('/')}` };
    }
    if (lowerFirst === 'p') {
      return segments.length === 2 && /^[A-Za-z0-9.\-_%]{1,100}$/.test(segments[1])
        ? { type: 'facebook', value: `https://www.facebook.com/p/${segments[1]}` }
        : null;
    }
    if (segments.length !== 1 || FACEBOOK_RESERVED.has(lowerFirst) || !/^[A-Za-z0-9.\-_%]{1,100}$/.test(first)) return null;
    return { type: 'facebook', value: `https://www.facebook.com/${first}` };
  }

  if (hostMatches(host, 'tiktok.com')) {
    if (segments.length !== 1 || !/^@[A-Za-z0-9._]{2,24}$/.test(first)) return null;
    return { type: 'tiktok', value: `https://www.tiktok.com/${first}` };
  }

  if (hostMatches(host, 'twitter.com') || hostMatches(host, 'x.com')) {
    if (segments.length !== 1 || X_RESERVED.has(first.toLowerCase()) || !/^[A-Za-z0-9_]{1,15}$/.test(first)) return null;
    return { type: 'x', value: `https://x.com/${first}` };
  }

  if (hostMatches(host, 'linkedin.com')) {
    const kind = first && first.toLowerCase();
    if (!['company', 'in', 'school', 'showcase'].includes(kind)) return null;
    const slug = segments[1];
    if (segments.length !== 2 || !slug || !/^[A-Za-z0-9\-_%.]{1,100}$/.test(slug)) return null;
    return { type: 'linkedin', value: `https://www.linkedin.com/${kind}/${slug}/` };
  }

  if (hostMatches(host, 'youtube.com')) {
    if (!first) return null;
    if (/^@[A-Za-z0-9._-]{3,30}$/.test(first)) {
      return segments.length === 1 ? { type: 'youtube', value: `https://www.youtube.com/${first}` } : null;
    }
    const kind = first.toLowerCase();
    const id = segments[1];
    if (segments.length !== 2) return null;
    if (kind === 'channel' && id && /^UC[A-Za-z0-9_-]{22}$/.test(id)) {
      return { type: 'youtube', value: `https://www.youtube.com/channel/${id}` };
    }
    if ((kind === 'c' || kind === 'user') && id && /^[A-Za-z0-9._-]{1,100}$/.test(id)) {
      return { type: 'youtube', value: `https://www.youtube.com/${kind}/${id}` };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------
// Contact page discovery
// ---------------------------------------------------------------------

const CONTACT_SLUGS = new Set(['contact', 'contact-us', 'contactus', 'contact_us']);
const ABOUT_SLUGS = new Set(['about', 'about-us', 'aboutus', 'about_us']);
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp']);

function lastSlug(url) {
  const segments = pathSegments(url);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1].toLowerCase();
  const dot = last.lastIndexOf('.');
  return dot !== -1 && PAGE_EXTENSIONS.has(last.slice(dot + 1)) ? last.slice(0, dot) : last;
}

function hasNonPageExtension(url) {
  const last = pathSegments(url).pop();
  if (!last) return false;
  const dot = last.lastIndexOf('.');
  return dot !== -1 && !PAGE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/**
 * Picks AT MOST ONE contact-ish page from the homepage's own links:
 *   1. a path ending in /contact, /contact-us (or close variants)
 *   2. a link whose text mentions "contact"
 *   3. a path ending in /about, /about-us
 * Only same-site http(s) pages qualify, so the one extra request the
 * caller makes can never be steered onto a third-party host. Returns
 * an absolute URL (fragment removed), or null.
 *
 * @param {string} html
 * @param {string} baseUrl - the page the HTML came from
 * @returns {string|null}
 */
function findContactPageUrl(html, baseUrl) {
  if (typeof html !== 'string' || typeof baseUrl !== 'string') return null;
  const base = parseHttpUrl(baseUrl);
  if (!base) return null;

  let best = null; // { priority, url }

  for (const { href, text } of listAnchors(html)) {
    if (/^\s*(?:mailto|tel|javascript|data|sms|whatsapp):/i.test(href)) continue;
    const url = parseHttpUrl(href, baseUrl);
    if (!url || !sameSite(url.hostname, base.hostname) || hasNonPageExtension(url)) continue;

    url.hash = '';
    const isBasePage = url.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '') && url.search === base.search;
    if (isBasePage) continue;

    const slug = lastSlug(url);
    let priority = 0;
    if (CONTACT_SLUGS.has(slug)) priority = 3;
    else if (text.length <= 60 && /contact/i.test(text)) priority = 2;
    else if (ABOUT_SLUGS.has(slug)) priority = 1;
    if (priority === 0) continue;

    if (!best || priority > best.priority) best = { priority, url: url.toString() };
    if (priority === 3) break; // nothing outranks an explicit /contact path
  }

  return best && best.url.length <= MAX_URL_LENGTH ? best.url : null;
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Extracts every contact detail present in one page's HTML.
 *
 * @param {string} html
 * @param {string} [pageUrl] - used to resolve relative links
 * @returns {{
 *   emails: Array<{ value: string, via: 'mailto'|'text' }>,
 *   socials: Array<{ type: string, value: string }>,
 *   whatsapp: string[],
 *   phones: string[],
 * }}
 */
function extractContacts(html, pageUrl) {
  const empty = { emails: [], socials: [], whatsapp: [], phones: [] };
  if (typeof html !== 'string' || html.length === 0) return empty;

  const anchors = listAnchors(html);

  const socials = [];
  const socialSeen = new Set();
  const perPlatform = {};
  const whatsapp = [];
  const phones = [];

  for (const { href } of anchors) {
    const wa = normalizeWhatsAppLink(href, pageUrl);
    if (wa) {
      if (!whatsapp.includes(wa) && whatsapp.length < MAX_WHATSAPP) whatsapp.push(wa);
      continue;
    }

    const tel = parseTelHref(href);
    if (tel) {
      if (!phones.includes(tel) && phones.length < MAX_PHONES) phones.push(tel);
      continue;
    }

    const social = classifySocialUrl(href, pageUrl);
    if (social) {
      const key = `${social.type}:${social.value.toLowerCase()}`;
      if (socialSeen.has(key)) continue;
      if ((perPlatform[social.type] || 0) >= MAX_SOCIAL_PER_PLATFORM) continue;
      socialSeen.add(key);
      perPlatform[social.type] = (perPlatform[social.type] || 0) + 1;
      socials.push(social);
    }
  }

  return { emails: extractEmails(html, anchors), socials, whatsapp, phones };
}

module.exports = {
  MAX_EMAILS,
  MAX_SOCIAL_PER_PLATFORM,
  MAX_WHATSAPP,
  MAX_PHONES,
  decodeEntities,
  normalizeEmail,
  parseTelHref,
  normalizeWhatsAppLink,
  classifySocialUrl,
  findContactPageUrl,
  extractContacts,
};
