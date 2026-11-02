import { useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge, PriorityBadge, WebsiteStatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type {
  Business,
  Lead,
  LeadDetailAiAnalysis,
  LeadDetailPipeline,
  LeadDetailScoring,
  LeadDetailWebsiteAnalysis,
  LeadPipelineStage,
  WebsiteAnalysisStatus,
} from '../../types';

// ---------------------------------------------------------------------
// Shared formatting helpers. Every one of these treats `null`/`undefined`
// as "not available" and renders a plain "—" placeholder -- never a
// fabricated value or a `0`. See the Phase 13B1B task constraints.
// ---------------------------------------------------------------------

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function textLabel(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}

function numberLabel(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function scoreLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}/100`;
}

function boolLabel(value: boolean | null | undefined): string {
  return value === null || value === undefined ? 'N/A' : value ? 'Yes' : 'No';
}

/**
 * `google_rating` comes back from the API as a string, a number, or
 * null (PostgreSQL NUMERIC columns are returned as strings by the `pg`
 * driver -- see the type comment on Business.google_rating). Mirrors
 * `toRatingNumber` in BusinessesTable.tsx.
 */
function toRatingNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

const WEBSITE_ANALYSIS_STATUS_LABELS: Record<WebsiteAnalysisStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  rate_limited: 'Rate limited',
  blocked: 'Blocked',
  timeout: 'Timeout',
  unavailable: 'Unavailable',
};

function formatPipelineStage(stage: string): string {
  return stage
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ---------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-surface-border bg-white p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, value, wide = false }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'col-span-2 sm:col-span-4' : ''}`}>
      <dt className="text-xs font-medium text-ink-400">{label}</dt>
      <dd className="text-sm text-ink break-words">{value}</dd>
    </div>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">{children}</dl>;
}

/**
 * A single evidence entry backing an AI-reported problem/opportunity
 * (server/lib/aiOpportunityAnalysis.js's EVIDENCE_ITEM_SCHEMA):
 * { field, value }, where field is a verified data field name and
 * value is what that field actually contains.
 */
interface AiAnalysisEvidence {
  field: string;
  value: string | number | boolean;
}

/**
 * The real shape ai_analysis.problems/opportunities entries come back
 * in (server/lib/aiOpportunityAnalysis.js's problems/opportunities
 * JSON schema) -- an object, not a plain string. TagList used to
 * assume every item was a string and rendered it directly inside a
 * <span>, which crashes React ("Objects are not valid as a React
 * child") the moment a real object-shaped entry reaches it.
 */
interface AiAnalysisFinding {
  title: string;
  description: string;
  evidence?: AiAnalysisEvidence[] | null;
}

function isAiAnalysisFinding(item: unknown): item is AiAnalysisFinding {
  return !!item && typeof item === 'object' && 'title' in item && 'description' in item;
}

/**
 * Renders each item's meaningful fields instead of the raw object:
 * bolded title, its description underneath, and (when present) the
 * evidence entries that back it, each as "field: value". A plain
 * string item (kept for backward compatibility / defensiveness) still
 * renders exactly as before.
 */
function TagList({ items }: { items: Array<string | AiAnalysisFinding> }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-ink">
          <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-400" aria-hidden="true" />
          {isAiAnalysisFinding(item) ? (
            <span className="break-words">
              <span className="font-medium text-ink">{item.title}</span>
              <span className="block text-ink-600">{item.description}</span>
              {item.evidence && item.evidence.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {item.evidence.map((e, j) => (
                    <li key={j} className="text-xs text-ink-400">
                      {e.field}: {String(e.value)}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          ) : (
            <span className="break-words">{item}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------
// 1. Business information
// ---------------------------------------------------------------------

export function BusinessInfoPanel({ business }: { business: Business }) {
  const location = [business.address, business.city, business.country].filter(Boolean).join(', ');
  const rating = toRatingNumber(business.google_rating);

  return (
    <Panel title="Business information">
      <FieldGrid>
        <Field label="Business name" value={textLabel(business.name)} wide />
        <Field label="Category" value={textLabel(business.category)} />
        <Field label="Location" value={location || '—'} />
        <Field label="Phone" value={textLabel(business.phone)} />
        <Field
          label="Website"
          value={
            business.website_url ? (
              <a
                href={business.website_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-info hover:underline"
              >
                {business.website_url}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              '—'
            )
          }
        />
        <Field
          label="Google rating"
          value={rating === null ? '—' : `${rating.toFixed(1)} ★`}
        />
        <Field label="Google review count" value={numberLabel(business.google_review_count)} />
        <Field
          label="Google Maps"
          value={
            business.google_maps_url ? (
              <a
                href={business.google_maps_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-info hover:underline"
              >
                View on Maps
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              '—'
            )
          }
        />
      </FieldGrid>
    </Panel>
  );
}

// ---------------------------------------------------------------------
// 2. Website analysis
// ---------------------------------------------------------------------

export function WebsiteAnalysisSectionPanel({
  websiteStatus,
  analysis,
}: {
  websiteStatus: Business['website_status'];
  analysis: LeadDetailWebsiteAnalysis | null;
}) {
  return (
    <Panel title="Website analysis">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <WebsiteStatusBadge status={websiteStatus} />
        {analysis && (
          <Badge tone={analysis.analysis_status === 'completed' ? 'success' : 'neutral'}>
            {WEBSITE_ANALYSIS_STATUS_LABELS[analysis.analysis_status]}
          </Badge>
        )}
      </div>

      {!analysis ? (
        <p className="text-sm text-ink-400">No completed website analysis on file for this lead yet.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <FieldGrid>
            <Field label="Performance score" value={scoreLabel(analysis.performance_score)} />
            <Field label="Accessibility score" value={scoreLabel(analysis.accessibility_score)} />
            <Field label="SEO score" value={scoreLabel(analysis.seo_score)} />
            <Field label="Best practices score" value={scoreLabel(analysis.best_practices_score)} />
            <Field label="Mobile indicator" value={textLabel(analysis.mobile_indicator)} />
            <Field label="HTTPS" value={boolLabel(analysis.https_enabled)} />
            <Field label="HTTP status" value={numberLabel(analysis.http_status)} />
            <Field label="Response time" value={numberLabel(analysis.response_time_ms, ' ms')} />
            <Field label="Analysis date" value={formatDateTime(analysis.analyzed_at)} />
          </FieldGrid>
          <FieldGrid>
            <Field label="Page title" value={textLabel(analysis.page_title)} wide />
            <Field label="Meta description" value={textLabel(analysis.meta_description)} wide />
          </FieldGrid>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------
// 3. AI analysis
// ---------------------------------------------------------------------

export function AiAnalysisPanel({ analysis }: { analysis: LeadDetailAiAnalysis | null }) {
  return (
    <Panel title="AI analysis">
      {!analysis ? (
        <p className="text-sm text-ink-400">No completed AI analysis on file for this lead yet.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <Field label="Summary" value={textLabel(analysis.summary)} wide />

          {analysis.problems && analysis.problems.length > 0 && (
            <div>
              <dt className="text-xs font-medium text-ink-400">Problems</dt>
              <dd className="mt-1.5">
                <TagList items={analysis.problems} />
              </dd>
            </div>
          )}

          {analysis.opportunities && analysis.opportunities.length > 0 && (
            <div>
              <dt className="text-xs font-medium text-ink-400">Opportunities</dt>
              <dd className="mt-1.5">
                <TagList items={analysis.opportunities} />
              </dd>
            </div>
          )}

          <FieldGrid>
            <Field label="Recommended service" value={textLabel(analysis.recommended_service)} />
            <Field label="Confidence" value={analysis.confidence === null ? '—' : `${analysis.confidence}%`} />
            <Field label="AI model" value={textLabel(analysis.ai_model)} />
          </FieldGrid>

          <Field label="Reasoning" value={textLabel(analysis.reasoning)} wide />
          <Field label="Sales angle" value={textLabel(analysis.sales_angle)} wide />
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------
// 4. Lead information
// ---------------------------------------------------------------------

export function LeadInfoPanel({
  lead,
  scoring,
  onSaveNotes,
}: {
  lead: Lead;
  scoring: LeadDetailScoring;
  /** Phase 13B2. Persists a new sales_notes value via PATCH /api/leads/:id/notes. Rejects on failure so the caller can show an error and keep the draft. */
  onSaveNotes: (notes: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(lead.sales_notes ?? '');
  const [lastSyncedNotes, setLastSyncedNotes] = useState(lead.sales_notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Keep the draft in sync when the underlying lead's sales_notes
  // changes from outside this component (a successful save persisted
  // upstream, or navigating to a different lead) -- but never clobber
  // text the user is actively editing.
  if (lead.sales_notes !== lastSyncedNotes) {
    setLastSyncedNotes(lead.sales_notes);
    setDraft(lead.sales_notes ?? '');
  }

  const dirty = draft !== (lead.sales_notes ?? '');

  async function handleSave() {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      await onSaveNotes(draft);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save sales notes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Lead information">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PriorityBadge priority={scoring.priority} />
        {scoring.scored_at && (
          <span className="text-xs text-ink-400">Scored {formatDateTime(scoring.scored_at)}</span>
        )}
      </div>
      <FieldGrid>
        <Field label="Lead score" value={scoreLabel(scoring.lead_score)} />
        <Field label="Priority" value={<PriorityBadge priority={scoring.priority} />} />
        <Field label="Estimated opportunity" value={formatCurrency(lead.estimated_opportunity)} />
      </FieldGrid>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor="sales-notes" className="text-xs font-medium text-ink-400">
          Sales notes
        </label>
        <textarea
          id="sales-notes"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          disabled={saving}
          className="w-full rounded border border-surface-border bg-white p-2.5 text-sm text-ink focus:border-ink-600 disabled:bg-surface-muted"
        />
        <div className="mt-1 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save notes'}
          </Button>
          {justSaved && !dirty && !error && <span className="text-xs text-success">Saved</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------
// 5. Pipeline (read-only)
// ---------------------------------------------------------------------

const PIPELINE_STAGE_OPTIONS: Array<{ value: LeadPipelineStage; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'researched', label: 'Researched' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'responded', label: 'Responded' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

export function PipelinePanel({
  pipeline,
  onChangeStage,
}: {
  pipeline: LeadDetailPipeline;
  /** Phase 13B2. Persists a new stage via PATCH /api/leads/:id/pipeline. Rejects on failure so the caller can show an error and keep the previous stage displayed. */
  onChangeStage: (stage: LeadPipelineStage) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: string) {
    const stage = next as LeadPipelineStage;
    if (stage === pipeline.stage) return;
    setSaving(true);
    setError(null);
    try {
      await onChangeStage(stage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update pipeline stage.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Pipeline">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="info">{formatPipelineStage(pipeline.stage)}</Badge>
        <Select
          ariaLabel="Pipeline stage"
          value={pipeline.stage}
          onChange={handleChange}
          options={PIPELINE_STAGE_OPTIONS}
          disabled={saving}
        />
        {saving && <span className="text-xs text-ink-400">Saving…</span>}
        {pipeline.updated_at && !saving && (
          <span className="text-xs text-ink-400">Updated {formatDateTime(pipeline.updated_at)}</span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {pipeline.notes && <p className="mt-3 text-sm text-ink-600">{pipeline.notes}</p>}
    </Panel>
  );
}
