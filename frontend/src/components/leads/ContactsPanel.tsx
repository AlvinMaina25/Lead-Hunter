import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ContactProvenance, LeadContacts } from '../../types';
import {
  hostLabel,
  isWebHref,
  safeHref,
  safeSearchHref,
  safeSocialHref,
  safeWhatsAppHref,
} from '../../lib/safeLinks';

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
};

const LINK_CLASS = 'inline-flex items-center gap-1 text-info hover:underline break-all';

/**
 * A link that has ALREADY been validated (href comes from one of the
 * safe* helpers). http(s) links open in a new tab with
 * rel="noopener noreferrer"; mailto:/tel: links hand off to the mail /
 * phone app (a new tab would just be left blank) and still carry the
 * same rel.
 */
function Anchor({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  const web = isWebHref(href);
  return (
    <a
      href={href}
      title={title}
      {...(web ? { target: '_blank' } : {})}
      rel="noopener noreferrer"
      className={LINK_CLASS}
    >
      {children}
      {web && <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />}
    </a>
  );
}

function formatFoundAt(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Found on shop.co.ke · 3 Jan 2026". Only shown for contacts that were actually scraped. */
function Provenance({ source_url, found_at }: ContactProvenance) {
  const host = hostLabel(source_url);
  const when = formatFoundAt(found_at);
  if (!host && !when) return null;
  return (
    <span className="text-xs text-ink-400">
      {' '}
      {host ? `found on ${host}` : 'found on website'}
      {when ? ` · ${when}` : ''}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-ink-400">{label}</dt>
      <dd className="flex flex-col gap-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * Contact details for one lead (GET /api/leads/:id `contacts`).
 *
 * - Everything shown is either Google's phone or something literally
 *   found on the business's own website (with where/when). Nothing is
 *   inferred.
 * - The Google-derived WhatsApp link is labelled "Try WhatsApp": we
 *   cannot know the number is on WhatsApp.
 * - Every URL is validated (lib/safeLinks.ts); one that fails is shown
 *   as plain text, not as a link.
 */
export function ContactsPanel({ contacts }: { contacts: LeadContacts | undefined }) {
  if (!contacts) return null;

  const phone = contacts.phone;
  const telHref = phone ? safeHref(phone.tel_href) : null;
  const tryWhatsAppHref = phone ? safeWhatsAppHref(phone.whatsapp_href) : null;
  const searchGoogle = contacts.search_links ? safeSearchHref(contacts.search_links.google) : null;
  const searchInstagram = contacts.search_links ? safeSearchHref(contacts.search_links.instagram) : null;
  const contactPageHref = contacts.contact_page ? safeHref(contacts.contact_page.url) : null;

  const hasAnything =
    Boolean(phone) ||
    contacts.emails.length > 0 ||
    contacts.phones.length > 0 ||
    contacts.whatsapp.length > 0 ||
    contacts.socials.length > 0 ||
    Boolean(contactPageHref) ||
    Boolean(searchGoogle || searchInstagram);

  return (
    <section aria-label="Contact details" className="rounded border border-surface-border bg-white p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-ink">Contact details</h3>
      <div className="mt-4">
        {!hasAnything ? (
          <p className="text-sm text-ink-600">No contact details found yet.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            {phone && (
              <Row label="Phone (from Google)">
                <span>
                  {phone.national ?? phone.international}
                  {phone.national && phone.international && (
                    <span className="text-xs text-ink-400"> · {phone.international}</span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {telHref && <Anchor href={telHref}>Call</Anchor>}
                  {tryWhatsAppHref && (
                    <Anchor
                      href={tryWhatsAppHref}
                      title="We can't tell whether this number is on WhatsApp — this just opens a chat if it is."
                    >
                      Try WhatsApp
                    </Anchor>
                  )}
                </span>
              </Row>
            )}

            {contacts.emails.length > 0 && (
              <Row label="Email">
                {contacts.emails.map((email) => {
                  const href = safeHref(email.href);
                  return (
                    <span key={email.value}>
                      {href ? <Anchor href={href}>{email.value}</Anchor> : <span className="break-all">{email.value}</span>}
                      <Provenance source_url={email.source_url} found_at={email.found_at} />
                    </span>
                  );
                })}
              </Row>
            )}

            {contacts.phones.length > 0 && (
              <Row label="Phone (found on website)">
                {contacts.phones.map((p) => {
                  const href = safeHref(p.href);
                  return (
                    <span key={p.value}>
                      {href ? <Anchor href={href}>{p.value}</Anchor> : <span>{p.value}</span>}
                      <Provenance source_url={p.source_url} found_at={p.found_at} />
                    </span>
                  );
                })}
              </Row>
            )}

            {contacts.whatsapp.length > 0 && (
              <Row label="WhatsApp (found on website)">
                {contacts.whatsapp.map((w) => {
                  const href = safeWhatsAppHref(w.url);
                  return (
                    <span key={w.url}>
                      {href ? <Anchor href={href}>{href.replace('https://', '')}</Anchor> : <span className="break-all">{w.url}</span>}
                      <Provenance source_url={w.source_url} found_at={w.found_at} />
                    </span>
                  );
                })}
              </Row>
            )}

            {contacts.socials.length > 0 && (
              <Row label="Social profiles">
                {contacts.socials.map((s) => {
                  const href = safeSocialHref(s.platform, s.url);
                  const label = PLATFORM_LABELS[s.platform] ?? s.platform;
                  return (
                    <span key={`${s.platform}:${s.url}`}>
                      {href ? (
                        <Anchor href={href}>{label}</Anchor>
                      ) : (
                        <span>
                          {label}: <span className="break-all">{s.url}</span>
                        </span>
                      )}
                      <Provenance source_url={s.source_url} found_at={s.found_at} />
                    </span>
                  );
                })}
              </Row>
            )}

            {contacts.contact_page && (
              <Row label="Contact page">
                <span>
                  {contactPageHref ? (
                    <Anchor href={contactPageHref}>{contactPageHref}</Anchor>
                  ) : (
                    <span className="break-all">{contacts.contact_page.url}</span>
                  )}
                </span>
              </Row>
            )}

            {(searchGoogle || searchInstagram) && (
              <Row label="No website — look them up">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {searchGoogle && <Anchor href={searchGoogle}>Search Google</Anchor>}
                  {searchInstagram && (
                    <Anchor href={searchInstagram} title="A Google search limited to instagram.com">
                      Search Instagram
                    </Anchor>
                  )}
                </span>
              </Row>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}
