import { Component, useEffect, useId, useState, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Check, Sparkles } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { fetchLeadIntelligence } from '../../lib/api';
import type {
  AiInterpretationItem,
  SalesIntelligenceConfidence,
  SalesIntelligenceResponse,
  VerifiedObservation,
} from '../../types';

/**
 * Phase 19 Part 2: the Sales Intelligence panel on the lead detail page.
 *
 * The one rule this file exists to enforce (mirroring the backend's
 * GET /api/leads/:id/intelligence contract): VERIFIED FACTS and AI
 * INTERPRETATION are never mixed.
 *
 *   - Verified observations are rendered ONLY from
 *     `verified_observations` -- green, labeled "Verified".
 *   - Everything else (the relevance summary, the interpretation
 *     items, the service match and its reasoning/confidence) is AI
 *     output -- blue, labeled "AI-generated". Nothing in those blocks
 *     is ever called "verified", and no AI text is ever shown as a
 *     source.
 *
 * All intelligence is generated on the server; this file only renders
 * it. It also never invents content: a missing piece renders as an
 * explicit empty state, not a placeholder value.
 */

// ---------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------

/** Verified-observation `source` values -> the labels shown to the user. */
const SOURCE_LABELS: Record<VerifiedObservation['source'], string> = {
  business_record: 'Database',
  website_analyzer: 'Website Analyzer',
};

/**
 * Only the sources the backend actually measures are ever shown. An
 * unrecognised value renders NO label rather than being echoed, so
 * nothing unexpected (least of all an AI inference) can appear in the
 * source slot.
 */
function sourceLabel(source: unknown): string | null {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source)
    ? SOURCE_LABELS[source as VerifiedObservation['source']]
    : null;
}

/**
 * The backend (aiOpportunityAnalysis.js ALLOWED_SERVICES) stores the
 * matched service as a snake_case identifier. These are the
 * user-facing names for those identifiers.
 */
const SERVICE_LABELS: Record<string, string> = {
  new_website: 'Business Website',
  website_redesign: 'Business Website Redesign',
  mobile_optimization: 'Mobile Website Optimization',
  seo_improvement: 'SEO Improvement',
  digital_business_card: 'Digital Business Card',
  qr_menu_order_system: 'QR Menu / Ordering System',
  whatsapp_integration: 'WhatsApp Quote/Order/Booking Bot',
  ai_customer_service_chatbot: 'AI Customer Support Chatbot',
  booking_system: 'Online Booking System',
  ecommerce_website: 'E-commerce Website',
};

function humanizeIdentifier(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Known identifier -> friendly name. An identifier we don't know yet
 * is title-cased rather than dropped, and a value that is already
 * human-readable (older analyses) is shown as-is.
 */
export function formatServiceName(service: string): string {
  if (Object.prototype.hasOwnProperty.call(SERVICE_LABELS, service)) return SERVICE_LABELS[service];
  return service.includes('_') ? humanizeIdentifier(service) : service;
}

const CONFIDENCE_LABELS: Record<SalesIntelligenceConfidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function confidenceLabel(confidence: unknown): string | null {
  return typeof confidence === 'string' && Object.prototype.hasOwnProperty.call(CONFIDENCE_LABELS, confidence)
    ? CONFIDENCE_LABELS[confidence as SalesIntelligenceConfidence]
    : null;
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** How many verified observations show before the "Show all" toggle -- keeps the panel compact. */
const VISIBLE_OBSERVATION_LIMIT = 8;

const NO_MATCH_TITLE = 'No clear service match';
const NO_MATCH_EXPLANATION =
  'Available evidence is insufficient to identify a specific Alvin Solutions service opportunity.';
const NO_MATCH_NOT_ANALYZED =
  'No AI analysis has been completed for this lead yet, so a service match cannot be made.';

// ---------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------

/** Same outer look as the other lead-detail panels (LeadDetailSections' Panel). */
function PanelShell({ children }: { children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="rounded border border-surface-border bg-white p-4 sm:p-5">
      <h3 id={titleId} className="text-sm font-semibold text-ink">
        Sales intelligence
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One labeled block. `kind` decides the whole visual treatment so the
 * two kinds of content can't be confused at a glance: 'verified' is a
 * plain white block with a green edge; 'ai' is a blue-tinted block
 * with a blue edge and an "AI-generated" badge.
 */
function Block({
  kind,
  title,
  caption,
  children,
}: {
  kind: 'verified' | 'ai';
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const isAi = kind === 'ai';

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded border border-l-4 p-3 sm:p-4 ${
        isAi ? 'border-info/20 border-l-info bg-info-50' : 'border-surface-border border-l-success bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-ink">
          {title}
        </h4>
        {isAi ? (
          <Badge tone="info">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            AI-generated
          </Badge>
        ) : (
          <Badge tone="success">
            <Check className="h-3 w-3" aria-hidden="true" />
            Verified
          </Badge>
        )}
      </div>
      {caption && <p className="mt-1 text-xs text-ink-400">{caption}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function MutedText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-400">{children}</p>;
}

// ---------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------

function VerifiedObservations({ observations }: { observations: VerifiedObservation[] }) {
  const [expanded, setExpanded] = useState(false);
  const canCollapse = observations.length > VISIBLE_OBSERVATION_LIMIT;
  const shown = canCollapse && !expanded ? observations.slice(0, VISIBLE_OBSERVATION_LIMIT) : observations;

  return (
    <Block
      kind="verified"
      title="Verified observations"
      caption="Measured or recorded by Alvin Lead Hunter. Nothing here is inferred."
    >
      {observations.length === 0 ? (
        <MutedText>No verified observations are available for this lead.</MutedText>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((observation, i) => {
              const label = sourceLabel(observation.source);
              return (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-3">
                    <span className="break-words text-ink">{observation.fact}</span>
                    {label && (
                      <span className="ml-1.5 mt-0.5 inline-block shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-400 sm:ml-0 sm:mt-0">
                        {label}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {canCollapse && (
            <div className="mt-2">
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? 'Show fewer' : `Show all ${observations.length} observations`}
              </Button>
            </div>
          )}
        </>
      )}
    </Block>
  );
}

const INTERPRETATION_TYPE_LABELS: Record<string, string> = {
  problem: 'Possible problem',
  opportunity: 'Possible opportunity',
};

function AiInterpretation({ items, hasAnalysis }: { items: AiInterpretationItem[]; hasAnalysis: boolean }) {
  return (
    <Block
      kind="ai"
      title="AI interpretation"
      caption="The AI's reading of the observations above. A hypothesis, not a verified fact."
    >
      {items.length === 0 ? (
        <MutedText>
          {hasAnalysis
            ? 'The AI analysis did not identify any specific problems or opportunities.'
            : 'No AI interpretation is available for this lead yet.'}
        </MutedText>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item, i) => {
            const typeLabel = INTERPRETATION_TYPE_LABELS[item.type] ?? 'AI observation';
            const service = nonEmptyText(item.service);
            const evidence = Array.isArray(item.evidence)
              ? item.evidence.filter((e) => e && typeof e === 'object' && typeof e.field === 'string')
              : [];
            return (
              <li key={i} className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-info">{typeLabel}</span>
                <p className="break-words text-sm text-ink">{item.interpretation}</p>
                {service && <p className="text-xs text-ink-600">Suggested service: {formatServiceName(service)}</p>}
                {evidence.length > 0 && (
                  <p className="break-words text-xs text-ink-400">
                    Based on: {evidence.map((e) => `${e.field.replace(/_/g, ' ')}: ${String(e.value)}`).join(' · ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

function ServiceMatch({
  match,
  hasAnalysis,
}: {
  match: SalesIntelligenceResponse['service_match'];
  hasAnalysis: boolean;
}) {
  const service = nonEmptyText(match?.service);

  return (
    <Block kind="ai" title="Potential Alvin Solutions service">
      {!service ? (
        // No forced recommendation: say so plainly, and say why.
        <div>
          <p className="text-sm font-medium text-ink">{NO_MATCH_TITLE}</p>
          <p className="mt-0.5 text-sm text-ink-600">{hasAnalysis ? NO_MATCH_EXPLANATION : NO_MATCH_NOT_ANALYZED}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink">{formatServiceName(service)}</p>
          {nonEmptyText(match?.reason) && (
            <p className="break-words text-sm text-ink-600">
              <span className="font-medium text-ink">Why: </span>
              {match?.reason}
            </p>
          )}
          <p className="flex items-center gap-2 text-sm text-ink-600">
            {confidenceLabel(match?.confidence) ? (
              <>
                <span>Confidence:</span>
                <Badge tone={match?.confidence === 'low' ? 'neutral' : 'info'}>
                  {confidenceLabel(match?.confidence)}
                </Badge>
              </>
            ) : (
              <span>Confidence not available</span>
            )}
          </p>
        </div>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------
// Presentational view (data in, markup out -- no fetching)
// ---------------------------------------------------------------------

/**
 * Renders one lead's Sales Intelligence payload. Every list is read
 * defensively, so a payload from before Phase 19 (no analysis: empty
 * interpretation, null service match) or a partly-populated one
 * renders cleanly -- no `undefined`, no crash.
 */
export function SalesIntelligenceView({ data }: { data: SalesIntelligenceResponse }) {
  const observations = (Array.isArray(data.verified_observations) ? data.verified_observations : []).filter(
    (o) => o && typeof o.fact === 'string' && o.fact.trim().length > 0,
  );
  const interpretation = (Array.isArray(data.ai_interpretation) ? data.ai_interpretation : []).filter(
    (i) => i && typeof i.interpretation === 'string' && i.interpretation.trim().length > 0,
  );
  const relevance = nonEmptyText(data.relevance_summary);
  const hasAnalysis = Boolean(data.has_analysis);
  const hasServiceMatch = Boolean(nonEmptyText(data.service_match?.service));

  const isEmpty = !hasAnalysis && observations.length === 0 && interpretation.length === 0 && !relevance && !hasServiceMatch;

  if (isEmpty) {
    return <MutedText>Sales intelligence is not available for this lead yet.</MutedText>;
  }

  const model = nonEmptyText(data.ai_model);
  const analyzedOn = formatDate(data.analyzed_at);

  return (
    <div className="flex flex-col gap-3">
      {relevance && (
        <Block kind="ai" title="Why this lead may be relevant">
          <p className="break-words text-sm text-ink">{relevance}</p>
        </Block>
      )}

      <VerifiedObservations observations={observations} />
      <AiInterpretation items={interpretation} hasAnalysis={hasAnalysis} />
      <ServiceMatch match={data.service_match} hasAnalysis={hasAnalysis} />

      {hasAnalysis && (model || analyzedOn) && (
        <p className="text-xs text-ink-400">
          AI content generated{model ? ` by ${model}` : ''}
          {analyzedOn ? ` on ${analyzedOn}` : ''}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------

function IntelligenceLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="flex items-center gap-2 text-sm text-ink-400">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-400 border-t-transparent" />
        Loading sales intelligence…
      </span>
      <div className="h-3 w-3/4 animate-pulse rounded bg-surface-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-surface-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-surface-muted" />
    </div>
  );
}

function IntelligenceError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        Sales intelligence couldn't be loaded.
      </p>
      {message && <p className="break-words text-sm text-ink-400">{message}</p>}
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Container: fetch + isolation
// ---------------------------------------------------------------------

type IntelligenceState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SalesIntelligenceResponse };

function SalesIntelligenceLoader({ leadId }: { leadId: string }) {
  const [state, setState] = useState<IntelligenceState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetchLeadIntelligence(leadId)
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: 'ready', data: result.intelligence }
            : { status: 'error', message: result.error },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'Something went wrong loading this data.' });
      });

    return () => {
      cancelled = true;
    };
  }, [leadId, attempt]);

  return (
    <PanelShell>
      {state.status === 'loading' && <IntelligenceLoading />}
      {state.status === 'error' && (
        <IntelligenceError message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      )}
      {state.status === 'ready' && <SalesIntelligenceView data={state.data} />}
    </PanelShell>
  );
}

/**
 * Last line of defence for "a Sales Intelligence failure must NOT
 * break the page": if rendering this panel ever throws (e.g. a
 * malformed field that slipped past the shape check), only this panel
 * is replaced by an error message -- the rest of the lead page keeps
 * working.
 */
export class SalesIntelligenceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Sales intelligence failed to render.', error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <PanelShell>
          <IntelligenceError message="This section couldn't be displayed. The rest of the page is unaffected." />
        </PanelShell>
      );
    }
    return this.props.children;
  }
}

/**
 * The panel the lead detail page renders. Fetches
 * GET /api/leads/:id/intelligence on its own -- independently of the
 * lead-detail request -- so its loading/error states never affect the
 * rest of the page. `key={leadId}` (on both layers) resets everything
 * when navigating between leads.
 */
export function SalesIntelligenceSection({ leadId }: { leadId: string }) {
  return (
    <SalesIntelligenceErrorBoundary key={leadId}>
      <SalesIntelligenceLoader leadId={leadId} />
    </SalesIntelligenceErrorBoundary>
  );
}
