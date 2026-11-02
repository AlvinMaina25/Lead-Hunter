import type { ReactNode } from 'react';

type BadgeTone = 'neutral' | 'success' | 'danger' | 'info' | 'signal' | 'outline';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-ink-600 border-surface-border',
  success: 'bg-success-50 text-success border-success/20',
  danger: 'bg-danger-50 text-danger border-danger/20',
  info: 'bg-info-50 text-info border-info/20',
  signal: 'bg-signal-50 text-signal-600 border-signal/25',
  // Outline only: for lifecycle status, which is information rather than a signal.
  outline: 'bg-transparent text-ink-600 border-ink-400/40',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium leading-5 ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Priority reads as a coloured dot + text rather than a pill, so it can't be
 * mistaken for status. Gold is reserved for "high": the one signal this tool
 * exists to surface. Text always carries the meaning; the dot only reinforces it.
 */
const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-ink-400/60',
  medium: 'bg-info',
  high: 'bg-signal',
  very_high: 'bg-danger',
};

/**
 * Phase 12: unlike formatLabel (which only capitalizes the first
 * character, e.g. "no_website" -> "No website"), priority values read
 * better with every word capitalized ("very_high" -> "Very High"),
 * matching the display example in the Phase 12 spec. Scoped to this
 * badge only so other badges' existing text is untouched.
 */
function formatPriorityLabel(value: string): string {
  return value
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export function PriorityBadge({ priority }: { priority: string }) {
  const isUrgent = priority === 'high' || priority === 'very_high';
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap text-xs leading-5 ${
        isUrgent ? 'font-semibold text-ink' : 'font-medium text-ink-600'
      }`}
    >
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[priority] ?? 'bg-ink-400/60'}`} />
      {formatPriorityLabel(priority)}
    </span>
  );
}

export function LeadStatusBadge({ status }: { status: string }) {
  return <Badge tone="outline">{formatLabel(status)}</Badge>;
}

const WEBSITE_STATUS_TONE: Record<string, BadgeTone> = {
  reachable: 'success',
  unreachable: 'danger',
  no_website: 'neutral',
  unknown: 'neutral',
};

export function WebsiteStatusBadge({ status }: { status: string }) {
  return <Badge tone={WEBSITE_STATUS_TONE[status] ?? 'neutral'}>{formatLabel(status)}</Badge>;
}

export function SearchStatusBadge({ status }: { status: string }) {
  const tone: Record<string, BadgeTone> = {
    pending: 'neutral',
    running: 'info',
    completed: 'success',
    failed: 'danger',
  };
  return <Badge tone={tone[status] ?? 'neutral'}>{formatLabel(status)}</Badge>;
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
