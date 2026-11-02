/**
 * Lead score as a number plus a small bar. The number is the information; the
 * bar is a quick visual read and is hidden from assistive tech. Neutral ink on
 * purpose -- the single gold accent is reserved for priority.
 */
export function ScoreMeter({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return <span className="font-mono tabular-nums text-ink">—</span>;
  }

  const pct = Math.max(0, Math.min(100, score));

  return (
    <div className="flex items-center gap-2">
      <span className="w-7 text-right font-mono tabular-nums text-ink">{score}</span>
      <div aria-hidden="true" className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-border">
        <div className="h-full rounded-full bg-ink-600" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
