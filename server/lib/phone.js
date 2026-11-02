/**
 * Phone helpers for contact links.
 *
 * The one rule: NEVER GUESS A COUNTRY CODE. A national number such as
 * "020 123 4567" does not say which country it belongs to, so it can
 * never be turned into an international number here. Only a number
 * that already carries its own "+<country code>" prefix (Google's
 * internationalPhoneNumber, or a "+..." tel:/wa.me value found on a
 * website) is converted. Everything else returns null, and callers
 * simply don't offer a link that needs one.
 *
 * Pure functions, no I/O.
 */

'use strict';

// E.164: a "+", then at most 15 digits, the first of which (the start
// of the country code) is never 0. 8 is the practical lower bound for
// a real subscriber number plus country code.
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

/**
 * Turns an international phone number into digits-only E.164
 * ("+254 20 123 4567" -> "254201234567"), suitable for wa.me links.
 *
 * Returns null -- never a guess -- when the input has no leading "+"
 * (so the country is unknown), contains anything other than digits and
 * ordinary separators (space . - ( ) and non-breaking/thin spaces),
 * or is outside the E.164 length range.
 *
 * @param {unknown} international
 * @returns {string|null}
 */
function toE164Digits(international) {
  if (typeof international !== 'string') return null;
  const trimmed = international.trim();
  if (!trimmed.startsWith('+')) return null;

  const body = trimmed.slice(1);
  // Only digits plus common visual separators are acceptable. Letters
  // ("ext", "x") or anything else means we can't be sure what it is.
  if (!/^[\d\s().\-\u00a0\u2009\u202f]+$/.test(body)) return null;

  const digits = body.replace(/\D/g, '');
  if (digits.length < E164_MIN_DIGITS || digits.length > E164_MAX_DIGITS) return null;
  if (digits.startsWith('0')) return null;
  return digits;
}

/** @param {unknown} international @returns {string|null} "tel:+254..." or null */
function buildInternationalTelHref(international) {
  const digits = toE164Digits(international);
  return digits ? `tel:+${digits}` : null;
}

/**
 * A tel: href for a number that may only be in national format. A tel:
 * link doesn't need the country code (a phone dials it as typed), so
 * keeping just digits and an optional leading "+" is safe and doesn't
 * guess anything. Returns null if there are too few/many digits.
 *
 * @param {unknown} phone
 * @returns {string|null}
 */
function buildTelHref(phone) {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!/^[+\d\s().\-\u00a0\u2009\u202f]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > E164_MAX_DIGITS + 5) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/**
 * wa.me link for an INTERNATIONAL number. Opening it does not mean the
 * number is on WhatsApp -- the UI must label it "Try WhatsApp".
 *
 * @param {unknown} international
 * @returns {string|null}
 */
function buildWhatsAppHref(international) {
  const digits = toE164Digits(international);
  return digits ? `https://wa.me/${digits}` : null;
}

module.exports = {
  E164_MIN_DIGITS,
  E164_MAX_DIGITS,
  toE164Digits,
  buildInternationalTelHref,
  buildTelHref,
  buildWhatsAppHref,
};
