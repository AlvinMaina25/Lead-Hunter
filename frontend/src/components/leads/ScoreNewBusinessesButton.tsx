import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { fetchUnscoredBusinessCount, scoreLeadBatch } from '../../lib/api';

/**
 * The most businesses one click scores. Mirrors the backend's cap
 * (server/lib/leadScoringService.js BATCH_LIMIT.MAX); the backend
 * validates it, so a mismatch is rejected, never unbounded.
 */
const UNSCORED_BATCH_LIMIT = 50;

interface RunSummary {
  scored: number;
  failed: number;
}

interface ScoreNewBusinessesButtonProps {
  /** Called after a run so the page can refresh its list of leads. */
  onScored?: () => void;
}

/**
 * "Score new businesses" action for the Leads page. Shows how many
 * businesses have never been scored, scores them (deterministic lead
 * scoring only -- no AI, no external calls) via
 * POST /api/businesses/lead-score { only_unscored: true }, reports how
 * many were scored / failed, and asks the page to refresh. Guards against
 * duplicate clicks while running and surfaces failures inline, like
 * ExportLeadsButton. A business that fails stays unscored, so the next
 * click retries it.
 */
export function ScoreNewBusinessesButton({ onScored }: ScoreNewBusinessesButtonProps) {
  // null = not known (still loading, or the count request failed).
  const [unscoredCount, setUnscoredCount] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCount = useCallback(async () => {
    try {
      setUnscoredCount(await fetchUnscoredBusinessCount());
    } catch {
      // The count is a convenience. If it can't load, leave the button
      // usable without a number; running it reports its own errors.
      setUnscoredCount(null);
    }
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  async function handleScore() {
    if (isRunning) return;

    setIsRunning(true);
    setError(null);
    setSummary(null);

    try {
      const result = await scoreLeadBatch({ only_unscored: true, limit: UNSCORED_BATCH_LIMIT });
      const scored = result.results.filter((r) => r.ok).length;
      setSummary({ scored, failed: result.results.length - scored });
      onScored?.();
      await loadCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to score new businesses. Please try again.');
    } finally {
      setIsRunning(false);
    }
  }

  const nothingToScore = unscoredCount === 0;
  const label = isRunning
    ? 'Scoring…'
    : unscoredCount === null
      ? 'Score new businesses'
      : `Score new businesses (${unscoredCount})`;

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant="primary"
        onClick={handleScore}
        disabled={isRunning || nothingToScore}
        aria-busy={isRunning}
        icon={isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      >
        {label}
      </Button>

      {summary && (
        <p role="status" className="text-sm text-ink-600">
          {summary.scored === 0 && summary.failed === 0
            ? 'No new businesses to score.'
            : `Scored ${summary.scored} ${summary.scored === 1 ? 'business' : 'businesses'}` +
              (summary.failed > 0 ? `, ${summary.failed} failed.` : '.')}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded border border-danger/20 bg-danger-50 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
