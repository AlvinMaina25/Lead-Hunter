import { useMemo, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { Column, DataTable } from '../ui/DataTable';
import { SearchInput } from '../ui/SearchInput';
import { Select } from '../ui/Select';
import { Pagination } from '../ui/Pagination';
import { EmptyState } from '../ui/EmptyState';
import { TableSkeleton } from '../ui/LoadingState';
import { SearchStatusBadge } from '../ui/Badge';
import { describeAnalysisOptions, formatRadius } from '../../lib/searchConfig';
import type { SearchRecord } from '../../types';

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Phase 20: the configuration a search was run with, as short "Label:
 * value" details. Every field is optional/nullable -- rows created
 * before Phase 20 (or demo data) simply produce fewer (or no) details
 * rather than made-up defaults.
 */
function configDetails(s: SearchRecord): string[] {
  const details: string[] = [];
  if (s.keyword) details.push(`Keyword: ${s.keyword}`);
  if (typeof s.radius_meters === 'number') details.push(`Radius: ${formatRadius(s.radius_meters)}`);
  if (typeof s.max_results === 'number') details.push(`Max results: ${s.max_results}`);
  if (s.analysis_options) details.push(`Analysis requested: ${describeAnalysisOptions(s.analysis_options)}`);
  return details;
}

interface SearchesTableProps {
  searches: SearchRecord[];
  isLoading: boolean;
}

export function SearchesTable({ searches, isLoading }: SearchesTableProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState<string>('started_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let result = searches;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (s) =>
          s.search_query.toLowerCase().includes(q) ||
          s.category?.toLowerCase().includes(q) ||
          s.location?.toLowerCase().includes(q) ||
          s.keyword?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') {
      result = result.filter((s) => s.status === statusFilter);
    }

    const sorted = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'search_query':
          cmp = a.search_query.localeCompare(b.search_query);
          break;
        case 'results_count':
          cmp = a.results_count - b.results_count;
          break;
        case 'started_at':
        default:
          cmp = new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [searches, search, statusFilter, sortKey, sortDirection]);

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

  const columns: Column<SearchRecord>[] = [
    {
      key: 'search_query',
      header: 'Query',
      sortable: true,
      render: (s) => {
        const details = configDetails(s);
        return (
          <div>
            <span className="font-medium text-ink">{s.search_query}</span>
            {details.length > 0 && <div className="mt-0.5 text-xs text-ink-400">{details.join(' · ')}</div>}
          </div>
        );
      },
    },
    {
      key: 'category',
      header: 'Category',
      responsiveClass: 'hidden sm:table-cell',
      render: (s) => <span className="text-ink-600">{s.category ?? '—'}</span>,
    },
    {
      key: 'location',
      header: 'Location',
      responsiveClass: 'hidden md:table-cell',
      render: (s) => <span className="text-ink-600">{s.location ?? '—'}</span>,
    },
    {
      key: 'results_count',
      header: 'Results',
      sortable: true,
      render: (s) => <span className="font-mono tabular-nums text-ink">{s.results_count}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <SearchStatusBadge status={s.status} />,
    },
    {
      key: 'started_at',
      header: 'Started',
      sortable: true,
      responsiveClass: 'hidden lg:table-cell',
      render: (s) => <span className="text-ink-600">{formatDateTime(s.started_at)}</span>,
    },
    {
      key: 'completed_at',
      header: 'Completed',
      responsiveClass: 'hidden xl:table-cell',
      render: (s) => <span className="text-ink-600">{formatDateTime(s.completed_at)}</span>,
    },
  ];

  return (
    <div className="rounded border border-surface-border bg-white">
      <div className="flex flex-col gap-3 border-b border-surface-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by query, category, or location…" />
        <Select
          ariaLabel="Filter by search status"
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setPage(1); }}
          options={STATUS_OPTIONS}
        />
      </div>

      {isLoading ? (
        <table className="w-full min-w-[720px] text-left text-sm">
          <tbody>
            <TableSkeleton columns={columns.length} rows={6} />
          </tbody>
        </table>
      ) : pageRows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<SearchIcon className="h-8 w-8" />}
            title={searches.length === 0 ? 'No searches yet' : 'No searches match your filters'}
            description={
              searches.length === 0
                ? 'Run a business search to start building your lead pipeline. Search history will appear here.'
                : 'Try a different search term or clear the status filter.'
            }
          />
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={pageRows}
            rowKey={(s) => s.id}
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
    </div>
  );
}
