import { Fragment } from 'react';
import type { ReactNode } from 'react';

interface NameCellProps {
  /** The business name (a link or plain text). */
  title: ReactNode;
  /** Secondary details shown muted under the name (e.g. category, location). Empty values are skipped. */
  meta: Array<string | null | undefined>;
}

/**
 * Name + a muted second line. Replaces separate Category/Location columns so
 * the name column stays readable without the table growing wider. Opts back
 * into wrapping for the name (DataTable cells are nowrap by default), capped at
 * two lines; the meta line stays on one line.
 */
export function NameCell({ title, meta }: NameCellProps) {
  const parts = meta.filter((part): part is string => Boolean(part));

  return (
    <div className="min-w-[11rem] max-w-[18rem] whitespace-normal text-sm">
      <div className="line-clamp-2 font-medium leading-5 text-ink">{title}</div>
      {/* One line, ellipsised: a wrapping meta line makes row heights unpredictable. */}
      <p
        className="mt-0.5 flex items-center gap-1.5 overflow-hidden text-xs leading-4 text-ink-400"
        title={parts.length > 0 ? parts.join(' · ') : undefined}
      >
        {parts.length === 0
          ? '—'
          : parts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-ink-400/60" />}
                <span className={i === 0 && parts.length > 1 ? 'max-w-[55%] shrink-0 truncate' : 'min-w-0 truncate'}>
                  {part}
                </span>
              </Fragment>
            ))}
      </p>
    </div>
  );
}
