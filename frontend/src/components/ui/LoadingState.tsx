export function TableSkeleton({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-surface-border last:border-0">
          {Array.from({ length: columns }).map((__, colIndex) => (
            <td key={colIndex} className="px-4 py-3">
              <div
                className="h-3.5 animate-pulse rounded bg-surface-muted"
                style={{ width: `${55 + ((rowIndex + colIndex) % 4) * 10}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-surface-border">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="flex-1 space-y-2">
            <div className="h-3.5 animate-pulse rounded bg-surface-muted" style={{ width: `${45 + (i % 3) * 12}%` }} />
            <div className="h-3 w-1/4 animate-pulse rounded bg-surface-muted" />
          </div>
          <div className="h-3.5 w-14 animate-pulse rounded bg-surface-muted" />
        </li>
      ))}
    </ul>
  );
}

export function MetricCardSkeleton() {
  return (
    <div className="rounded border border-surface-border bg-white p-4">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-muted" />
      <div className="mt-3 h-7 w-16 animate-pulse rounded bg-surface-muted" />
    </div>
  );
}

export function MetricStripSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="rounded border border-surface-border bg-white p-5">
        <div className="h-3.5 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="mt-8 h-12 w-20 animate-pulse rounded bg-surface-muted" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-surface-border bg-surface-border sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white px-4 py-3">
            <div className="h-3 w-20 animate-pulse rounded bg-surface-muted" />
            <div className="mt-2 h-6 w-10 animate-pulse rounded bg-surface-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PanelLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded border border-surface-border bg-white px-6 py-16 text-sm text-ink-400">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-400 border-t-transparent" />
      {label}
    </div>
  );
}
