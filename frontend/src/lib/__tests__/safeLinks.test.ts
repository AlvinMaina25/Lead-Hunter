import { describe, expect, it } from 'vitest';
import {
  hostLabel,
  safeHref,
  safeSearchHref,
  safeSocialHref,
  safeWhatsAppHref,
} from '../safeLinks';

describe('safeHref', () => {
  it('allows http, https, mailto and tel', () => {
    expect(safeHref('https://shop.co.ke/contact')).toBe('https://shop.co.ke/contact');
    expect(safeHref('http://shop.co.ke')).toBe('http://shop.co.ke/');
    expect(safeHref('mailto:info@shop.co.ke')).toBe('mailto:info@shop.co.ke');
    expect(safeHref('tel:+254201234567')).toBe('tel:+254201234567');
    expect(safeHref('tel:0201234567')).toBe('tel:0201234567');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://shop.co.ke/x',
    'blob:https://shop.co.ke/abc',
    'whatsapp://send?phone=254712345678',
    'sms:+254712345678',
    '//shop.co.ke/contact',
    '/relative/path',
    'shop.co.ke',
    '',
    '   ',
  ])('rejects %j', (value) => {
    expect(safeHref(value)).toBeNull();
  });

  it('rejects non-strings, credentials, whitespace, control characters and oversized values', () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
    expect(safeHref({})).toBeNull();
    expect(safeHref('https://user:pw@shop.co.ke/')).toBeNull();
    expect(safeHref('https://shop.co.ke/a b')).toBeNull();
    expect(safeHref('https://shop.co.ke/\u0000')).toBeNull();
    expect(safeHref(`https://shop.co.ke/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('only allows a single plain mailto address and a plain tel number', () => {
    expect(safeHref('mailto:a@shop.co.ke?cc=b@x.com&body=hi')).toBeNull();
    expect(safeHref('mailto:a@shop.co.ke,b@shop.co.ke')).toBeNull();
    expect(safeHref('mailto:not-an-email')).toBeNull();
    expect(safeHref('tel:+254;ext=1')).toBeNull();
    expect(safeHref('tel:123')).toBeNull();
    expect(safeHref('tel:abc12345')).toBeNull();
  });
});

describe('platform-specific helpers', () => {
  it('safeSocialHref requires https on the right platform host', () => {
    expect(safeSocialHref('instagram', 'https://www.instagram.com/shopke/')).toBe('https://www.instagram.com/shopke/');
    expect(safeSocialHref('x', 'https://x.com/shopke')).toBe('https://x.com/shopke');
    expect(safeSocialHref('instagram', 'https://www.facebook.com/shopke')).toBeNull();
    expect(safeSocialHref('instagram', 'https://instagram.com.evil.example/shopke')).toBeNull();
    expect(safeSocialHref('instagram', 'javascript:alert(1)')).toBeNull();
    expect(safeSocialHref('instagram', 'mailto:a@shop.co.ke')).toBeNull();
    expect(safeSocialHref('myspace', 'https://myspace.com/x')).toBeNull();
  });

  it('safeWhatsAppHref accepts only https://wa.me', () => {
    expect(safeWhatsAppHref('https://wa.me/254712345678')).toBe('https://wa.me/254712345678');
    expect(safeWhatsAppHref('http://wa.me/254712345678')).toBeNull();
    expect(safeWhatsAppHref('https://wa.me.evil.example/254712345678')).toBeNull();
    expect(safeWhatsAppHref('https://api.whatsapp.com/send?phone=254712345678')).toBeNull();
  });

  it('safeSearchHref accepts only https://www.google.com', () => {
    expect(safeSearchHref('https://www.google.com/search?q=Sharp%20Cuts')).toContain('https://www.google.com/search');
    expect(safeSearchHref('https://evil.example/search?q=x')).toBeNull();
  });

  it('hostLabel gives a short host for captions, or null', () => {
    expect(hostLabel('https://www.shop.co.ke/contact')).toBe('shop.co.ke');
    expect(hostLabel('javascript:alert(1)')).toBeNull();
    expect(hostLabel(null)).toBeNull();
  });
});
