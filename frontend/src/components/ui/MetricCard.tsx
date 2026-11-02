import type { ReactNode } from 'react';

type MetricTone = 'ink' | 'signal' | 'success' | 'danger' | 'info';

const TONE_STRIPE: Record<MetricTone, string> = {
  ink: 'bg-ink-600',
  signal: 'bg-signal',
  success: 'bg-success',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** A zero is "nothing to report", so it must never be styled like an alert. */
function isZeroValue(value: number | string): boolean {
  return value === 0 || value === '0';
}

interface MetricCardProps {
  label: string;
  value: number | string;
  tone?: MetricTone;
  icon?: ReactNode;
  hint?: string;
}

export function MetricCard({ label, value, tone = 'ink', icon, hint }: MetricCardProps) {
  return (
    <div className="overflow-hidden rounded border border-surface-border bg-white">
      <div className={`h-0.5 ${isZeroValue(value) ? 'bg-transparent' : TONE_STRIPE[tone]}`} />
      <div className="flex items-start justify-between gap-2 p-4">
        <div>
          <p className="text-xs font-medium text-ink-400">{label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</p>
          {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
        </div>
        {icon && <div className="text-ink-400">{icon}</div>}
      </div>
    </div>
  );
}

interface HeroMetricCardProps {
  label: string;
  value: number | string;
  icon?: ReactNode;
}

/**
 * The one figure the dashboard leads with. Gold (the app's single accent) only
 * appears while there is something to act on; at zero the card goes quiet.
 */
export function HeroMetricCard({ label, value, icon }: HeroMetricCardProps) {
  const isZero = isZeroValue(value);

  return (
    <div className="relative flex h-full flex-col justify-between gap-6 overflow-hidden rounded border border-surface-border bg-white p-5">
      {!isZero && <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-signal" />}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink-600">{label}</p>
        {icon && <div className={isZero ? 'text-ink-400' : 'text-signal-600'}>{icon}</div>}
      </div>
      <p className={`font-mono text-5xl font-semibold leading-none tabular-nums ${isZero ? 'text-ink-400' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}

interface MetricStripProps {
  items: Array<{ label: string; value: number | string }>;
}

/** The supporting figures as one quiet block: hairline dividers, no colour, no icons. */
export function MetricStrip({ items }: MetricStripProps) {
  return (
    <dl className="grid h-full grid-cols-2 gap-px overflow-hidden rounded border border-surface-border bg-surface-border sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="bg-white px-4 py-3">
          <dt className="text-xs font-medium text-ink-400">{item.label}</dt>
          <dd
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              isZeroValue(item.value) ? 'text-ink-400' : 'text-ink'
            }`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
