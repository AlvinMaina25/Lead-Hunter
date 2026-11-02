/**
 * Link safety for contact details.
 *
 * Contact URLs are scraped from third-party websites (or built from
 * Google data), so NOTHING is rendered as a link until it passes the
 * checks here. Only http, https, mailto and tel are ever allowed:
 * `javascript:`, `data:`, `vbscript:`, `file:` and everything else is
 * rejected, as are URLs with embedded credentials, control characters
 * or whitespace. A rejected value is rendered by the UI as plain text
 * (React-escaped), never as an anchor.
 *
 * Pure functions; no DOM access.
 */

export const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'] as const;

const MAX_LINK_LENGTH = 2048;
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;
const SIMPLE_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const TEL_NUMBER = /^\+?\d{5,20}$/;

/**
 * Returns a normalized, safe href, or null when the value must not be
 * turned into a link.
 */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LINK_LENGTH || UNSAFE_CHARS.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!(ALLOWED_LINK_SCHEMES as readonly string[]).includes(url.protocol)) return null;

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  }

  if (url.protocol === 'mailto:') {
    // One plain address only: no ?cc=/?bcc=/?body= and no multiple recipients.
    let address: string;
    try {
      address = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    return url.search === '' && url.hash === '' && SIMPLE_EMAIL.test(address) ? `mailto:${address}` : null;
  }

  // tel:
  return TEL_NUMBER.test(url.pathname) && url.search === '' && url.hash === '' ? `tel:${url.pathname}` : null;
}

/** True for http(s) links, which open in a new tab; mailto:/tel: hand off to an app instead. */
export function isWebHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

function hostMatches(href: string, domains: string[]): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const SOCIAL_DOMAINS: Record<string, string[]> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com'],
  tiktok: ['tiktok.com'],
  x: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com'],
  youtube: ['youtube.com'],
};

/** A social profile link: http(s) only, and the host must belong to the stated platform. */
export function safeSocialHref(platform: string, raw: unknown): string | null {
  const href = safeHref(raw);
  if (!href || !isWebHref(href)) return null;
  const domains = SOCIAL_DOMAINS[platform];
  return domains && hostMatches(href, domains) ? href : null;
}

/** A WhatsApp link: https on wa.me only (the server normalizes every WhatsApp link to that form). */
export function safeWhatsAppHref(raw: unknown): string | null {
  const href = safeHref(raw);
  return href && href.startsWith('https://') && new URL(href).hostname === 'wa.me' ? href : null;
}

/** A Google web-search helper link (used for businesses without a website). */
export function safeSearchHref(raw: unknown): string | null {
  const href = safeHref(raw);
  return href && href.startsWith('https://') && new URL(href).hostname === 'www.google.com' ? href : null;
}

/** Short host label for "found on ..." captions; null if the URL is unusable. */
export function hostLabel(raw: unknown): string | null {
  const href = safeHref(raw);
  if (!href || !isWebHref(href)) return null;
  return new URL(href).hostname.replace(/^www\./, '');
}
