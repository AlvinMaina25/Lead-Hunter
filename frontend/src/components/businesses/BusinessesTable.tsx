import { useMemo, useState } from 'react';
import { BarChart3, Building2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Column, DataTable } from '../ui/DataTable';
import { SearchInput } from '../ui/SearchInput';
import { Select } from '../ui/Select';
import { Pagination } from '../ui/Pagination';
import { EmptyState } from '../ui/EmptyState';
import { TableSkeleton } from '../ui/LoadingState';
import { WebsiteStatusBadge, Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { NameCell } from '../ui/NameCell';
import { RowMenu } from '../ui/RowMenu';
import { WebsiteAnalysisPanel } from './WebsiteAnalysisPanel';
import {
  analyzeBusinessWebsite,
  analyzeWebsiteBatch,
  checkBusinessWebsite,
  checkWebsiteBatch,
} from '../../lib/api';
import type { Business, WebsiteAnalysis, WebsiteAnalysisStatus, WebsiteStatus } from '../../types';

const PAGE_SIZE = 10;

/**
 * Bounded batch size for the "Check websites" action. Matches the
 * backend's default (server/lib/websiteCheckService.js BATCH_LIMIT) so
 * one click never fires more than this many outbound requests.
 */
const BATCH_CHECK_LIMIT = 20;

/**
 * Bounded batch size for the "Analyze websites" action (Phase 10C).
 * The backend accepts up to 50 (websiteAnalysisService's BATCH_LIMIT),
 * but this stays at the same default as the website-check batch above
 * so one click never fires more outbound analysis requests than a
 * website-check batch would.
 */
const BATCH_ANALYZE_LIMIT = 20;

const ANALYSIS_STATUS_LABELS: Record<WebsiteAnalysisStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  rate_limited: 'Rate limited',
  blocked: 'Blocked',
  timeout: 'Timeout',
  unavailable: 'Unavailable',
};

const WEBSITE_STATUS_OPTIONS = [
  { value: 'all', label: 'All website statuses' },
  { value: 'no_website', label: 'No website' },
  { value: 'reachable', label: 'Reachable' },
  { value: 'unreachable', label: 'Unreachable' },
  { value: 'unknown', label: 'Unknown' },
];

/** Short date ("Sep 10"); the year is only added when it isn't the current one. */
function formatDate(value: string): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * `google_rating` comes back from the API as a string, a number, or
 * null/undefined (PostgreSQL NUMERIC columns are returned as strings by
 * the `pg` driver — see the type comment in ../../types). Safely
 * coerces to a finite number for sorting/formatting, or null when the
 * value is absent or not a usable number.
 */
function toRatingNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Full timestamp, used for tooltips. */
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Local, optimistic result of an individual check, merged over `businesses` until the next refetch. */
interface CheckOverride {
  website_status: WebsiteStatus;
  website_checked_at: string | null;
}

type RowCheckState = { status: 'idle' } | { status: 'loading' } | { status: 'success' } | { status: 'error'; message: string };

type BatchCheckState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/** Per-row state for the "Analyze website" action (Phase 10C). */
type RowAnalyzeState = { status: 'idle' } | { status: 'loading' } | { status: 'success' } | { status: 'error'; message: string };

type BatchAnalyzeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

interface BusinessesTableProps {
  businesses: Business[];
  isLoading: boolean;
  isDemo: boolean;
  onRefetch: () => void;
}

export function BusinessesTable({ businesses, isLoading, isDemo, onRefetch }: BusinessesTableProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState<string>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [overrides, setOverrides] = useState<Record<string, CheckOverride>>({});
  const [rowStates, setRowStates] = useState<Record<string, RowCheckState>>({});
  const [batchState, setBatchState] = useState<BatchCheckState>({ status: 'idle' });

  // Phase 10C: website analysis. The API only ever hands back the
  // analysis it just ran -- there is no "list past analyses" endpoint
  // -- so `analyses` is a session-only cache of the latest analysis per
  // business, populated as each business is analyzed.
  const [analyzeRowStates, setAnalyzeRowStates] = useState<Record<string, RowAnalyzeState>>({});
  const [analyses, setAnalyses] = useState<Record<string, WebsiteAnalysis>>({});
  const [openAnalysisId, setOpenAnalysisId] = useState<string | null>(null);
  const [batchAnalyzeState, setBatchAnalyzeState] = useState<BatchAnalyzeState>({ status: 'idle' });

  // Merge in any just-completed individual checks so the table reflects
  // them immediately, without waiting on a full refetch from the server.
  const effectiveBusinesses = useMemo(
    () => businesses.map((b) => (overrides[b.id] ? { ...b, ...overrides[b.id] } : b)),
    [businesses, overrides]
  );

  const filtered = useMemo(() => {
    let result = effectiveBusinesses;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.category?.toLowerCase().includes(q) ||
          b.city?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') {
      result = result.filter((b) => b.website_status === statusFilter);
    }

    const sorted = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'google_rating':
          cmp = (toRatingNumber(a.google_rating) ?? -1) - (toRatingNumber(b.google_rating) ?? -1);
          break;
        case 'created_at':
        default:
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [effectiveBusinesses, search, statusFilter, sortKey, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('desc');
    }
    setPage(1);
  }

  async function handleCheckOne(id: string) {
    setRowStates((s) => ({ ...s, [id]: { status: 'loading' } }));
    try {
      const result = await checkBusinessWebsite(id);
      setOverrides((o) => ({
        ...o,
        [id]: { website_status: result.website_status, website_checked_at: result.website_checked_at },
      }));
      setRowStates((s) => ({ ...s, [id]: { status: 'success' } }));
    } catch (err) {
      setRowStates((s) => ({
        ...s,
        [id]: { status: 'error', message: err instanceof Error ? err.message : 'Check failed.' },
      }));
    }
  }

  async function handleBatchCheck() {
    setBatchState({ status: 'loading' });
    try {
      const result = await checkWebsiteBatch({ limit: BATCH_CHECK_LIMIT });
      setBatchState({
        status: 'success',
        message:
          result.checked === 0
            ? 'No unchecked businesses were found.'
            : `Checked ${result.checked} — ${result.reachable} reachable, ${result.unreachable} unreachable, ${result.no_website} with no website, ${result.unknown} unknown.`,
      });
      // The batch endpoint updates many rows server-side at once; a full
      // refetch (rather than guessing which rows changed) is the only
      // way to reflect that accurately.
      setOverrides({});
      onRefetch();
    } catch (err) {
      setBatchState({ status: 'error', message: err instanceof Error ? err.message : 'Batch check failed.' });
    }
  }

  async function handleAnalyzeOne(id: string) {
    setAnalyzeRowStates((s) => ({ ...s, [id]: { status: 'loading' } }));
    const result = await analyzeBusinessWebsite(id);
    if (result.ok) {
      setAnalyses((a) => ({ ...a, [id]: result.analysis }));
      setAnalyzeRowStates((s) => ({ ...s, [id]: { status: 'success' } }));
      setOpenAnalysisId(id);
    } else {
      setAnalyzeRowStates((s) => ({ ...s, [id]: { status: 'error', message: result.error } }));
    }
  }

  async function handleBatchAnalyze() {
    setBatchAnalyzeState({ status: 'loading' });
    try {
      const result = await analyzeWebsiteBatch({ limit: BATCH_ANALYZE_LIMIT });
      if (result.businesses_found === 0) {
        setBatchAnalyzeState({ status: 'success', message: 'No reachable businesses were found to analyze.' });
      } else {
        const completed = result.results.filter((r) => r.ok && r.analysis_status === 'completed').length;
        const other = result.results.length - completed;
        setBatchAnalyzeState({
          status: 'success',
          message: `Analyzed ${result.results.length} of ${result.businesses_found} — ${completed} completed, ${other} did not complete cleanly.`,
        });
      }
    } catch (err) {
      setBatchAnalyzeState({ status: 'error', message: err instanceof Error ? err.message : 'Batch analysis failed.' });
    }
  }

  const columns: Column<Business>[] = [
    {
      key: 'name',
      header: 'Business',
      sortable: true,
      render: (b) => <NameCell title={b.name} meta={[b.category, [b.city, b.country].filter(Boolean).join(', ')]} />,
    },
    {
      key: 'website_url',
      header: 'Website URL',
      responsiveClass: 'hidden lg:table-cell',
      render: (b) =>
        b.website_url ? (
          <a
            href={b.website_url.startsWith('http') ? b.website_url : `https://${b.website_url}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-[9rem] items-center gap-1 truncate text-info hover:underline"
            title={b.website_url}
          >
            <span className="truncate">{b.website_url}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span className="text-ink-400">—</span>
        ),
    },
    {
      key: 'website_status',
      header: 'Website status',
      render: (b) => <WebsiteStatusBadge status={b.website_status} />,
    },
    {
      key: 'website_checked_at',
      header: 'Last checked',
      responsiveClass: 'hidden md:table-cell',
      render: (b) => (
        <span className="text-ink-600" title={b.website_checked_at ? formatDateTime(b.website_checked_at) : undefined}>
          {b.website_checked_at ? formatDate(b.website_checked_at) : 'Never'}
        </span>
      ),
    },
    {
      key: 'google_rating',
      header: 'Rating',
      sortable: true,
      responsiveClass: 'hidden lg:table-cell',
      render: (b) => {
        const rating = toRatingNumber(b.google_rating);
        return (
          <span className="font-mono tabular-nums text-ink-600">
            {rating !== null ? `${rating.toFixed(1)} (${b.google_review_count ?? 0})` : '—'}
          </span>
        );
      },
    },
    {
      key: 'created_at',
      header: 'Added',
      sortable: true,
      responsiveClass: 'hidden md:table-cell',
      render: (b) => (
        <span className="text-ink-600" title={formatDateTime(b.created_at)}>
          {formatDate(b.created_at)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (b) => {
        const rowState = rowStates[b.id] ?? { status: 'idle' };
        const isRowLoading = rowState.status === 'loading';
        const analyzeState = analyzeRowStates[b.id] ?? { status: 'idle' };
        const isAnalyzing = analyzeState.status === 'loading';
        const canAnalyze = b.website_status === 'reachable';
        const existingAnalysis = analyses[b.id];
        const hasFeedback =
          rowState.status === 'error' ||
          rowState.status === 'success' ||
          analyzeState.status === 'error' ||
          Boolean(existingAnalysis);
        return (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleCheckOne(b.id)}
                disabled={isDemo || isRowLoading}
                title={isDemo ? 'Not available in demo mode' : 'Check this website now'}
                className="inline-flex h-7 items-center gap-1.5 rounded border border-surface-border bg-white px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-ink-400 disabled:hover:bg-white"
              >
                {isRowLoading ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking…
                  </>
                ) : (
                  'Check website'
                )}
              </button>
              <RowMenu
                busy={isAnalyzing}
                alert={analyzeState.status === 'error' ? analyzeState.message : undefined}
                items={[
                  ...(canAnalyze
                    ? [
                        {
                          key: 'analyze',
                          label: isAnalyzing ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Analyzing…
                            </>
                          ) : (
                            <>
                              <BarChart3 className="h-3.5 w-3.5" />
                              Analyze website
                            </>
                          ),
                          onSelect: () => handleAnalyzeOne(b.id),
                          disabled: isDemo || isAnalyzing,
                          title: isDemo ? 'Not available in demo mode' : 'Run a Phase 10 homepage analysis for this website',
                        },
                      ]
                    : []),
                  ...(canAnalyze && existingAnalysis
                    ? [{ key: 'view-analysis', label: 'View analysis', onSelect: () => setOpenAnalysisId(b.id) }]
                    : []),
                  {
                    key: 'view',
                    label: 'View',
                    onSelect: () => {},
                    disabled: true,
                    title: 'Business detail view is coming in a later phase',
                  },
                ]}
              />
            </div>
            {/* Feedback only takes a second line when there is something to say. */}
            {hasFeedback && (
              <div className="flex max-w-[14rem] flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal text-xs">
                {rowState.status === 'error' && <span className="text-danger">{rowState.message}</span>}
                {rowState.status === 'success' && <span className="text-success">Updated</span>}
                {existingAnalysis && (
                  <Badge tone={existingAnalysis.analysis_status === 'completed' ? 'success' : 'danger'}>
                    {ANALYSIS_STATUS_LABELS[existingAnalysis.analysis_status]}
                  </Badge>
                )}
                {analyzeState.status === 'error' && <span className="text-danger">{analyzeState.message}</span>}
              </div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="rounded border border-surface-border bg-white">
      <div className="flex flex-col gap-3 border-b border-surface-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search businesses by name, category, or city…" />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            ariaLabel="Filter by website status"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
            options={WEBSITE_STATUS_OPTIONS}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={
              batchState.status === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )
            }
            disabled={isDemo || batchState.status === 'loading'}
            title={isDemo ? 'Not available in demo mode' : `Check up to ${BATCH_CHECK_LIMIT} never-checked businesses`}
            onClick={handleBatchCheck}
          >
            {batchState.status === 'loading' ? 'Checking websites…' : 'Check websites'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={
              batchAnalyzeState.status === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BarChart3 className="h-3.5 w-3.5" />
              )
            }
            disabled={isDemo || batchAnalyzeState.status === 'loading'}
            title={isDemo ? 'Not available in demo mode' : `Analyze up to ${BATCH_ANALYZE_LIMIT} reachable websites`}
            onClick={handleBatchAnalyze}
          >
            {batchAnalyzeState.status === 'loading' ? 'Analyzing websites…' : 'Analyze websites'}
          </Button>
        </div>
      </div>

      {(batchState.status === 'success' || batchState.status === 'error') && (
        <div
          className={`border-b border-surface-border px-4 py-2 text-xs ${
            batchState.status === 'error' ? 'text-danger' : 'text-ink-600'
          }`}
        >
          {batchState.message}
        </div>
      )}

      {(batchAnalyzeState.status === 'success' || batchAnalyzeState.status === 'error') && (
        <div
          className={`border-b border-surface-border px-4 py-2 text-xs ${
            batchAnalyzeState.status === 'error' ? 'text-danger' : 'text-ink-600'
          }`}
        >
          {batchAnalyzeState.message}
        </div>
      )}

      {isLoading ? (
        <table className="w-full min-w-[720px] text-left text-sm">
          <tbody>
            <TableSkeleton columns={columns.length} rows={6} />
          </tbody>
        </table>
      ) : pageRows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title={businesses.length === 0 ? 'No businesses found' : 'No businesses match your filters'}
            description={
              businesses.length === 0
                ? 'Start a business search to populate your database.'
                : 'Try a different search term or clear the website status filter.'
            }
          />
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={pageRows}
            rowKey={(b) => b.id}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
          />
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}

      {openAnalysisId &&
        analyses[openAnalysisId] &&
        (() => {
          const business = effectiveBusinesses.find((b) => b.id === openAnalysisId);
          return (
            <WebsiteAnalysisPanel
              businessName={business?.name ?? 'Business'}
              analysis={analyses[openAnalysisId]}
              onClose={() => setOpenAnalysisId(null)}
            />
          );
        })()}
    </div>
  );
}
