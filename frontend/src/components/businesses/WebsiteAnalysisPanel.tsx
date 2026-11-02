import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { WebsiteAnalysis, WebsiteAnalysisStatus } from '../../types';

const STATUS_LABELS: Record<WebsiteAnalysisStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  rate_limited: 'Rate limited',
  blocked: 'Blocked',
  timeout: 'Timeout',
  unavailable: 'Unavailable',
};

const STATUS_TONE: Record<WebsiteAnalysisStatus, 'success' | 'danger' | 'neutral'> = {
  completed: 'success',
  failed: 'danger',
  rate_limited: 'neutral',
  blocked: 'danger',
  timeout: 'neutral',
  unavailable: 'danger',
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** NULL means "not measured" -- a real, distinct finding from `false`. Never collapse the two. */
function boolLabel(value: boolean | null): string {
  return value === null ? 'N/A' : value ? 'Yes' : 'No';
}

function scoreLabel(value: number | null): string {
  return value === null ? 'N/A' : `${value}/100`;
}

function numberLabel(value: number | null, suffix = ''): string {
  return value === null ? 'N/A' : `${value}${suffix}`;
}

function bytesLabel(value: number | null): string {
  if (value === null) return 'N/A';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function textLabel(value: string | null): string {
  return value === null || value.trim().length === 0 ? 'N/A' : value;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-ink-400">{label}</dt>
      <dd className={`text-sm ${value === 'N/A' ? 'text-ink-400' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</h4>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">{children}</dl>
    </div>
  );
}

interface WebsiteAnalysisPanelProps {
  businessName: string;
  analysis: WebsiteAnalysis;
  onClose: () => void;
}

export function WebsiteAnalysisPanel({ businessName, analysis, onClose }: WebsiteAnalysisPanelProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 animate-overlay-in bg-ink/50 motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Website analysis for ${businessName}`}
        className="relative flex max-h-[85vh] w-full max-w-2xl animate-panel-in flex-col overflow-hidden rounded border border-surface-border bg-white shadow-xl motion-reduce:animate-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-surface-border p-4">
          <div>
            <h3 className="text-sm font-semibold text-ink">{businessName}</h3>
            <p className="mt-0.5 max-w-md truncate text-xs text-ink-400" title={analysis.analyzed_url}>
              {analysis.analyzed_url}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close analysis"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-400 hover:bg-surface-muted hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center gap-3 border-b border-surface-border pb-4">
            <Badge tone={STATUS_TONE[analysis.analysis_status]}>{STATUS_LABELS[analysis.analysis_status]}</Badge>
            <span className="text-xs text-ink-400">Analyzed {formatDateTime(analysis.analyzed_at)}</span>
          </div>

          {analysis.error_message && (
            <p className="mt-4 rounded border border-danger/20 bg-danger-50 px-3 py-2 text-xs text-danger">
              {analysis.error_message}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-5">
            <Section title="Scores">
              <Field label="Performance" value={scoreLabel(analysis.performance_score)} />
              <Field label="Accessibility" value={scoreLabel(analysis.accessibility_score)} />
              <Field label="SEO" value={scoreLabel(analysis.seo_score)} />
              <Field label="Best practices" value={scoreLabel(analysis.best_practices_score)} />
            </Section>

            <Section title="Technical">
              <Field label="HTTPS" value={boolLabel(analysis.https_enabled)} />
              <Field label="Mobile indicator" value={textLabel(analysis.mobile_indicator)} />
              <Field label="HTTP status" value={numberLabel(analysis.http_status)} />
              <Field label="Response time" value={numberLabel(analysis.response_time_ms, ' ms')} />
              <Field label="HTML size" value={bytesLabel(analysis.html_size_bytes)} />
            </Section>

            <Section title="Page">
              <div className="col-span-2 sm:col-span-4">
                <Field label="Page title" value={textLabel(analysis.page_title)} />
              </div>
              <div className="col-span-2 sm:col-span-4">
                <Field label="Meta description" value={textLabel(analysis.meta_description)} />
              </div>
              <Field label="Viewport" value={boolLabel(analysis.viewport_present)} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
