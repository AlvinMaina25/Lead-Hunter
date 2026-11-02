import type { ReactNode } from 'react';
import { PanelLoading } from '../ui/LoadingState';

export interface BreakdownEntry {
  /** Raw backend key (e.g. 'no_website', 'very_high') — used as the React key. */
  key: string;
  /** Human-readable label already resolved by the caller (see AnalyticsPage's label maps). */
  label: string;
  count: number;
}

interface BreakdownPanelProps {
  title: string;
  icon: ReactNode;
  entries: BreakdownEntry[];
  /** Shown when `entries` is empty -- an empty breakdown is a normal, valid state (Phase 21 Part 2 Step 12), never an error. */
  emptyMessage: string;
  isLoading?: boolean;
}

/**
 * A single reusable panel for the three Phase 21 breakdown sections
 * (website status, lead priority, pipeline stage) -- one component,
 * not three separate implementations, mirroring how MetricCard is
 * reused for all nine top-level metrics.
 *
 * Renders as a simple horizontal bar/list: no charting library is
 * already established in this project (see frontend/package.json),
 * and Phase 21 Part 2's spec explicitly allows a "clean horizontal
 * bar/list visualization" instead of introducing one just for this.
 *
 * The bar for each row is purely decorative (aria-hidden) -- the
 * label text and the numeric count next to it are what actually
 * convey the value, so nothing here depends on color alone.
 */
export function BreakdownPanel({ title, icon, entries, emptyMessage, isLoading = false }: BreakdownPanelProps) {
  const maxCount = Math.max(1, ...entries.map((entry) => entry.count));
  const sorted = [...entries].sort((a, b) => b.count - a.count);

  return (
    <div className="rounded border border-surface-border bg-white p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        {icon}
        {title}
      </h2>

      {isLoading ? (
        <PanelLoading />
      ) : sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((entry) => (
            <li key={entry.key}>
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-600">{entry.label}</span>
                <span className="font-mono font-semibold tabular-nums text-ink">{entry.count}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-ink-600"
                  style={{ width: `${Math.round((entry.count / maxCount) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
