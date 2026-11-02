import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContactsPanel } from '../ContactsPanel';
import type { LeadContacts } from '../../../types';

const META = { source_url: 'https://shop.co.ke/contact', found_at: '2026-01-03T10:00:00.000Z' };

function contacts(overrides: Partial<LeadContacts> = {}): LeadContacts {
  return {
    phone: null,
    emails: [],
    phones: [],
    whatsapp: [],
    socials: [],
    contact_page: null,
    search_links: null,
    summary: { has_phone: false, has_email: false, has_social: false, has_whatsapp: false },
    ...overrides,
  };
}

function expectSafeAnchor(link: HTMLElement) {
  const href = link.getAttribute('href') ?? '';
  expect(href).toMatch(/^(https?:|mailto:|tel:)/);
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  if (href.startsWith('http')) expect(link).toHaveAttribute('target', '_blank');
}

describe('ContactsPanel', () => {
  it('renders nothing when the response has no contacts block (older server)', () => {
    const { container } = render(<ContactsPanel contacts={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an honest empty state, not invented contacts', () => {
    render(<ContactsPanel contacts={contacts()} />);
    expect(screen.getByText(/no contact details found yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows scraped email, WhatsApp, phone, socials and contact page as safe links with where/when they were found', () => {
    render(
      <ContactsPanel
        contacts={contacts({
          emails: [{ value: 'sales@shop.co.ke', href: 'mailto:sales@shop.co.ke', ...META }],
          whatsapp: [{ url: 'https://wa.me/254712345678', ...META }],
          phones: [{ value: '+254201234567', href: 'tel:+254201234567', ...META }],
          socials: [
            { platform: 'instagram', url: 'https://www.instagram.com/shopke/', ...META },
            { platform: 'facebook', url: 'https://www.facebook.com/ShopKE', ...META },
          ],
          contact_page: { url: 'https://shop.co.ke/contact', source_url: 'https://shop.co.ke/', found_at: META.found_at },
        })}
      />,
    );

    const email = screen.getByRole('link', { name: 'sales@shop.co.ke' });
    expect(email).toHaveAttribute('href', 'mailto:sales@shop.co.ke');
    const instagram = screen.getByRole('link', { name: /instagram/i });
    expect(instagram).toHaveAttribute('href', 'https://www.instagram.com/shopke/');
    expect(screen.getByRole('link', { name: /wa\.me\/254712345678/ })).toHaveAttribute('href', 'https://wa.me/254712345678');
    expect(screen.getByRole('link', { name: /\+254201234567/ })).toHaveAttribute('href', 'tel:+254201234567');
    expect(screen.getByRole('link', { name: /shop\.co\.ke\/contact/ })).toBeInTheDocument();

    for (const link of screen.getAllByRole('link')) expectSafeAnchor(link);
    expect(screen.getAllByText(/found on shop\.co\.ke/i).length).toBeGreaterThan(0);
  });

  it('phone: tel link always, and "Try WhatsApp" (never a claim) only when an international number gave a wa.me link', () => {
    const { rerender } = render(
      <ContactsPanel
        contacts={contacts({
          phone: { national: '020 123 4567', international: '+254 20 123 4567', tel_href: 'tel:+254201234567', whatsapp_href: 'https://wa.me/254201234567' },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+254201234567');
    const tryWa = screen.getByRole('link', { name: 'Try WhatsApp' });
    expect(tryWa).toHaveAttribute('href', 'https://wa.me/254201234567');
    expect(tryWa).toHaveAttribute('target', '_blank');
    expect(tryWa).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/is on whatsapp/i)).not.toBeInTheDocument();

    rerender(
      <ContactsPanel
        contacts={contacts({ phone: { national: '020 123 4567', international: null, tel_href: 'tel:0201234567', whatsapp_href: null } })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:0201234567');
    expect(screen.queryByRole('link', { name: /whatsapp/i })).not.toBeInTheDocument();
  });

  it('no website: shows Google and Instagram search helpers', () => {
    render(
      <ContactsPanel
        contacts={contacts({
          phone: { national: '020 123 4567', international: null, tel_href: 'tel:0201234567', whatsapp_href: null },
          search_links: {
            google: 'https://www.google.com/search?q=Sharp%20Cuts%20Nairobi',
            instagram: 'https://www.google.com/search?q=site%3Ainstagram.com%20Sharp%20Cuts%20Nairobi',
          },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: /search google/i })).toHaveAttribute('href', expect.stringContaining('google.com/search'));
    expect(screen.getByRole('link', { name: /search instagram/i })).toHaveAttribute('href', expect.stringContaining('instagram.com'));
  });

  it('SECURITY: hostile scraped URLs never become links (rendered as inert text)', () => {
    const { container } = render(
      <ContactsPanel
        contacts={contacts({
          emails: [{ value: 'x@shop.co.ke', href: 'javascript:alert(1)', ...META }],
          whatsapp: [{ url: 'javascript:alert(2)', ...META }],
          phones: [{ value: '123456789', href: 'data:text/html,<script>alert(3)</script>', ...META }],
          socials: [
            { platform: 'instagram', url: 'javascript:alert(4)', ...META },
            { platform: 'facebook', url: 'https://evil.example/ShopKE', ...META },
            { platform: 'x', url: 'data:text/html;base64,PHNjcmlwdD4=', ...META },
          ],
          contact_page: { url: 'vbscript:msgbox(5)', source_url: 'https://shop.co.ke/', found_at: null },
          phone: { national: '020', international: null, tel_href: 'javascript:alert(6)', whatsapp_href: 'file:///etc/passwd' },
          search_links: { google: 'https://evil.example/?q=x', instagram: 'javascript:alert(7)' },
        })}
      />,
    );

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toMatch(/href="\s*(javascript|data|vbscript|file):/i);
    // The values are still visible to the user, just not clickable.
    expect(screen.getByText('javascript:alert(2)')).toBeInTheDocument();
  });

  it('SECURITY: markup inside scraped text is rendered as text, not HTML', () => {
    const { container } = render(
      <ContactsPanel
        contacts={contacts({
          socials: [{ platform: 'instagram', url: '<img src=x onerror=alert(1)>', ...META }],
        })}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(within(container).getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });
});
