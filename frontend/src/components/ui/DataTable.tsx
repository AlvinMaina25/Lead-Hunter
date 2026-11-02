import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  /** Tailwind classes to hide this column below a breakpoint, e.g. "hidden sm:table-cell" */
  responsiveClass?: string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSort?: (key: string) => void;
}

export function DataTable<T>({ columns, rows, rowKey, sortKey, sortDirection, onSort }: DataTableProps<T>) {
  return (
    // The wrapper is the scroll container for both axes, which is what lets the
    // header stick: `position: sticky` only works against a scrolling ancestor,
    // and `overflow-x: auto` alone would make this wrapper that ancestor without
    // ever scrolling vertically.
    <div className="max-h-[75vh] overflow-auto">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                // Opaque background + inset shadow instead of a border: borders
                // on collapsed-table cells don't travel with a sticky header.
                className={`sticky top-0 z-10 whitespace-nowrap bg-surface-muted px-2.5 py-2.5 text-xs font-medium text-ink-400 shadow-[inset_0_-1px_0_theme(colors.surface.border)] first:pl-4 last:pr-4 ${col.responsiveClass ?? ''}`}
              >
                {col.sortable ? (
                  <button
                    onClick={() => onSort?.(col.key)}
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-ink"
                  >
                    {col.header}
                    {sortKey === col.key ? (
                      sortDirection === 'asc' ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-ink-400/60" />
                    )}
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-surface-border last:border-0 hover:bg-surface-muted/40">
              {columns.map((col) => (
                // nowrap by default so dates, numbers and badges never wrap;
                // free-text cells opt back in with `whitespace-normal` inside render().
                <td
                  key={col.key}
                  className={`whitespace-nowrap px-2.5 py-3 align-middle first:pl-4 last:pr-4 ${col.responsiveClass ?? ''}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
