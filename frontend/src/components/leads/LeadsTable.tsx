import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MessageCircle, Phone, Share2, Users, X } from 'lucide-react';
import { Column, DataTable } from '../ui/DataTable';
import { SearchInput } from '../ui/SearchInput';
import { Select } from '../ui/Select';
import { Pagination } from '../ui/Pagination';
import { EmptyState } from '../ui/EmptyState';
import { ListSkeleton, TableSkeleton } from '../ui/LoadingState';
import { LeadStatusBadge, PriorityBadge } from '../ui/Badge';
import { NameCell } from '../ui/NameCell';
import { RowMenu } from '../ui/RowMenu';
import { ScoreMeter } from '../ui/ScoreMeter';
import { scoreBusinessLead } from '../../lib/api';
import { DEFAULT_LEADS_VIEW_STATE, loadLeadsViewState, saveLeadsViewState } from '../../lib/leadsViewState';
import type { Lead, ScoringFactor } from '../../types';

const PAGE_SIZE = 10;

const PRIORITY_OPTIONS = [
  { value: 'all', label: 'All priorities' },
  { value: 'very_high', label: 'Very High' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

/** Phase 12: local, optimistic result of a "(Re)score" click, merged over `leads` until the next refetch. */
interface ScoreOverride {
  lead_score: number;
  priority: Lead['priority'];
  scoring_factors: ScoringFactor[];
  scored_at: string;
}

type RowScoreState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string };

/**
 * Phase 12. Shows exactly how a lead_score was produced -- the
 * "Why?"/score-breakdown control from the Phase 12 spec. Displays the
 * numeric score/priority as text (never color alone) plus every
 * verified factor that contributed.
 */
function ScoreBreakdown({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const factors = lead.scoring_factors ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex animate-overlay-in items-center justify-center bg-black/30 p-4 motion-reduce:animate-none"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg animate-panel-in overflow-y-auto rounded border border-surface-border bg-white p-5 shadow-lg motion-reduce:animate-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-ink">{lead.business_name ?? 'Score breakdown'}</h3>
            <p className="mt-0.5 text-sm text-ink-600">
              Lead Score: <span className="font-mono tabular-nums">{lead.lead_score ?? '—'}/100</span>
              {' · '}
              Priority: <span className="font-medium">{formatPriority(lead.priority)}</span>
            </p>
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-surface-muted hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        {factors.length === 0 ? (
          <p className="text-sm text-ink-600">This lead hasn't been scored yet.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {factors.map((f) => (
              <li key={f.code} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-ink">{f.label}</p>
                  <p className="text-ink-600">{f.reason}</p>
                </div>
                <span className="shrink-0 font-mono tabular-nums text-ink">
                  {f.points > 0 ? `+${f.points}` : f.points}
                </span>
              </li>
            ))}
          </ul>
        )}

        {lead.scored_at && (
          <p className="mt-3 text-xs text-ink-400">Last scored {new Date(lead.scored_at).toLocaleString()}</p>
        )}
      </div>
    </div>
  );
}

function formatPriority(priority: string): string {
  return priority
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

const CONTACT_FILTER_OPTIONS = [
  { value: 'all', label: 'Any contact info' },
  { value: 'email', label: 'Has email' },
  { value: 'any', label: 'Has any contact' },
];

/** The contact kinds a lead can show an indicator for, in display order. */
function contactKinds(lead: Lead): Array<{ key: string; label: string; icon: typeof Phone }> {
  const kinds: Array<{ key: string; label: string; icon: typeof Phone }> = [];
  if (lead.has_phone) kinds.push({ key: 'phone', label: 'Has phone', icon: Phone });
  if (lead.has_email) kinds.push({ key: 'email', label: 'Has email', icon: Mail });
  if (lead.has_whatsapp) kinds.push({ key: 'whatsapp', label: 'Has WhatsApp link', icon: MessageCircle });
  if (lead.has_social) kinds.push({ key: 'social', label: 'Has social profile', icon: Share2 });
  return kinds;
}

/**
 * Small contact indicators for a row. Each icon has a text label
 * (screen readers + tooltip) -- meaning is never carried by the icon
 * alone. When the API didn't send the flags at all (older server) this
 * shows "—" rather than implying "no contact".
 */
export function ContactIndicators({ lead }: { lead: Lead }) {
  const flagsKnown =
    lead.has_phone !== undefined ||
    lead.has_email !== undefined ||
    lead.has_social !== undefined ||
    lead.has_whatsapp !== undefined;
  if (!flagsKnown) return <span className="text-ink-400">—</span>;

  const kinds = contactKinds(lead);
  if (kinds.length === 0) return <span className="text-ink-400">None</span>;

  return (
    <ul className="flex items-center gap-1.5" aria-label="Contact info available">
      {kinds.map(({ key, label, icon: Icon }) => (
        <li key={key} title={label} className="flex items-center text-ink-600">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </li>
      ))}
    </ul>
  );
}

/** True when the lead has at least one way to be contacted. */
export function hasAnyContact(lead: Lead): boolean {
  return Boolean(lead.has_phone || lead.has_email || lead.has_social || lead.has_whatsapp);
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'disqualified', label: 'Disqualified' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
];

/** Short date ("Sep 10"); the year is only added when it isn't the current one. */
function formatDate(value: string): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Category · Location" pieces for the muted second line under a lead's name. */
function leadMeta(lead: Lead): Array<string | null | undefined> {
  return [lead.business_category, [lead.business_city, lead.business_country].filter(Boolean).join(', ')];
}

function formatCurrency(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    value
  );
}

interface LeadsTableProps {
  leads: Lead[];
  isLoading: boolean;
  /** Compact mode: no filters/pagination, capped row count — used for "Recent Leads" on the dashboard */
  compact?: boolean;
  compactLimit?: number;
}

export function LeadsTable({ leads, isLoading, compact = false, compactLimit = 5 }: LeadsTableProps) {
  // The full table (not the dashboard's compact list) restores its last
  // view, so coming back from a lead's detail page keeps the same page,
  // filters and sort instead of resetting to page 1.
  const [initialView] = useState(() => (compact ? DEFAULT_LEADS_VIEW_STATE : loadLeadsViewState()));
  const [search, setSearch] = useState(initialView.search);
  const [priorityFilter, setPriorityFilter] = useState(initialView.priorityFilter);
  const [statusFilter, setStatusFilter] = useState(initialView.statusFilter);
  const [contactFilter, setContactFilter] = useState(initialView.contactFilter);
  const [sortKey, setSortKey] = useState<string>(initialView.sortKey);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(initialView.sortDirection);
  const [page, setPage] = useState(initialView.page);

  // Phase 12: local, optimistic results of "(Re)score" clicks, merged
  // over `leads` until the next refetch -- mirrors the `overrides`
  // pattern already used for website checks in BusinessesTable.tsx.
  const [scoreOverrides, setScoreOverrides] = useState<Record<string, ScoreOverride>>({});
  const [scoreRowStates, setScoreRowStates] = useState<Record<string, RowScoreState>>({});
  const [breakdownLeadId, setBreakdownLeadId] = useState<string | null>(null);

  const effectiveLeads = useMemo(
    () => leads.map((l) => (scoreOverrides[l.business_id] ? { ...l, ...scoreOverrides[l.business_id] } : l)),
    [leads, scoreOverrides]
  );

  async function handleScoreOne(businessId: string) {
    setScoreRowStates((s) => ({ ...s, [businessId]: { status: 'loading' } }));
    try {
      const result = await scoreBusinessLead(businessId);
      setScoreOverrides((o) => ({
        ...o,
        [businessId]: {
          lead_score: result.lead_score,
          priority: result.priority,
          scoring_factors: result.scoring_factors,
          scored_at: result.scored_at,
        },
      }));
      setScoreRowStates((s) => ({ ...s, [businessId]: { status: 'idle' } }));
    } catch (err) {
      setScoreRowStates((s) => ({
        ...s,
        [businessId]: { status: 'error', message: err instanceof Error ? err.message : 'Scoring failed.' },
      }));
    }
  }

  const breakdownLead = breakdownLeadId ? effectiveLeads.find((l) => l.id === breakdownLeadId) ?? null : null;

  const filtered = useMemo(() => {
    let result = effectiveLeads;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (lead) =>
          lead.business_name?.toLowerCase().includes(q) ||
          lead.business_category?.toLowerCase().includes(q) ||
          lead.business_city?.toLowerCase().includes(q)
      );
    }
    if (priorityFilter !== 'all') {
      result = result.filter((lead) => lead.priority === priorityFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter((lead) => lead.lead_status === statusFilter);
    }
    if (contactFilter === 'email') {
      result = result.filter((lead) => lead.has_email === true);
    } else if (contactFilter === 'any') {
      result = result.filter(hasAnyContact);
    }

    const sorted = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'business_name':
          cmp = (a.business_name ?? '').localeCompare(b.business_name ?? '');
          break;
        case 'lead_score':
          cmp = (a.lead_score ?? -1) - (b.lead_score ?? -1);
          break;
        case 'priority': {
          const order = { low: 0, medium: 1, high: 2, very_high: 3 };
          cmp = (order[a.priority] ?? 0) - (order[b.priority] ?? 0);
          break;
        }
        case 'lead_status':
          cmp = a.lead_status.localeCompare(b.lead_status);
          break;
        case 'created_at':
        default:
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [effectiveLeads, search, priorityFilter, statusFilter, contactFilter, sortKey, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = compact
    ? filtered.slice(0, compactLimit)
    : filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Save the clamped page (what the user actually sees), but not while
  // loading: with no rows yet, the page would clamp to 1 and overwrite it.
  useEffect(() => {
    if (compact || isLoading) return;
    saveLeadsViewState({ search, priorityFilter, statusFilter, contactFilter, sortKey, sortDirection, page: currentPage });
  }, [compact, isLoading, search, priorityFilter, statusFilter, contactFilter, sortKey, sortDirection, currentPage]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('desc');
    }
    setPage(1);
  }

  const columns: Column<Lead>[] = [
    {
      key: 'business_name',
      header: 'Business',
      sortable: true,
      render: (lead) => (
        <NameCell
          title={
            <Link to={`/leads/${lead.id}`} className="hover:underline">
              {lead.business_name ?? '—'}
            </Link>
          }
          meta={leadMeta(lead)}
        />
      ),
    },
    {
      key: 'lead_score',
      header: 'Score',
      sortable: true,
      render: (lead) => <ScoreMeter score={lead.lead_score} />,
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      render: (lead) => <PriorityBadge priority={lead.priority} />,
    },
    {
      key: 'lead_status',
      header: 'Status',
      sortable: true,
      render: (lead) => <LeadStatusBadge status={lead.lead_status} />,
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (lead) => <ContactIndicators lead={lead} />,
    },
    {
      key: 'recommended_service',
      header: 'Recommended service',
      responsiveClass: 'hidden lg:table-cell',
      render: (lead) => (
        <div className="max-w-[10rem] truncate text-ink-600" title={lead.recommended_service ?? undefined}>
          {lead.recommended_service ?? '—'}
        </div>
      ),
    },
    {
      key: 'estimated_opportunity',
      header: 'Est. value',
      // Not `xl` (1280): at that width the column appears before the container has room for it.
      responsiveClass: 'hidden min-[1320px]:table-cell',
      render: (lead) => (
        <span className="font-mono tabular-nums text-ink-600">{formatCurrency(lead.estimated_opportunity)}</span>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      responsiveClass: 'hidden md:table-cell',
      render: (lead) => <span className="text-ink-600">{formatDate(lead.created_at)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (lead) => {
        const rowState = scoreRowStates[lead.business_id] ?? { status: 'idle' };
        const isScoring = rowState.status === 'loading';
        return (
          <div className="flex items-center gap-1.5">
            <Link
              to={`/leads/${lead.id}`}
              title="View lead detail"
              className="inline-flex h-7 items-center rounded border border-surface-border bg-white px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-muted"
            >
              View
            </Link>
            <RowMenu
              busy={isScoring}
              alert={rowState.status === 'error' ? rowState.message : undefined}
              items={[
                {
                  key: 'why',
                  label: 'Why?',
                  onSelect: () => setBreakdownLeadId(lead.id),
                  disabled: !lead.scoring_factors || lead.scoring_factors.length === 0,
                  title: "Show the factors behind this lead's score",
                },
                {
                  key: 'score',
                  label: lead.scored_at ? 'Re-score' : 'Score',
                  onSelect: () => handleScoreOne(lead.business_id),
                  disabled: isScoring,
                  title:
                    rowState.status === 'error'
                      ? rowState.message
                      : lead.scored_at
                        ? 'Recalculate this lead\'s score from current data'
                        : 'Calculate this lead\'s score',
                },
              ]}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div className="rounded border border-surface-border bg-white">
      {!compact && (
        <div className="flex flex-col gap-3 border-b border-surface-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search leads by business, category, or city…" />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Filter by priority"
              value={priorityFilter}
              onChange={(v) => { setPriorityFilter(v); setPage(1); }}
              options={PRIORITY_OPTIONS}
            />
            <Select
              ariaLabel="Filter by lead status"
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(1); }}
              options={STATUS_OPTIONS}
            />
            <Select
              ariaLabel="Filter by contact info"
              value={contactFilter}
              onChange={(v) => { setContactFilter(v); setPage(1); }}
              options={CONTACT_FILTER_OPTIONS}
            />
          </div>
        </div>
      )}

      {isLoading && compact ? (
        <ListSkeleton rows={compactLimit} />
      ) : isLoading ? (
        <table className="w-full min-w-[720px] text-left text-sm">
          <tbody>
            <TableSkeleton columns={columns.length} rows={6} />
          </tbody>
        </table>
      ) : pageRows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title={leads.length === 0 ? 'No leads found' : 'No leads match your filters'}
            description={
              leads.length === 0
                ? 'Start a business search to populate your database.'
                : 'Try a different search term or clear the priority, status and contact filters.'
            }
          />
        </div>
      ) : compact ? (
        <ul className="divide-y divide-surface-border">
          {pageRows.map((lead) => (
            <li key={lead.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <NameCell
                  title={
                    <Link to={`/leads/${lead.id}`} className="hover:underline">
                      {lead.business_name ?? '—'}
                    </Link>
                  }
                  meta={leadMeta(lead)}
                />
              </div>
              <div className="hidden w-24 sm:block">
                <PriorityBadge priority={lead.priority} />
              </div>
              <div className="hidden w-28 md:block">
                <LeadStatusBadge status={lead.lead_status} />
              </div>
              <ScoreMeter score={lead.lead_score} />
            </li>
          ))}
        </ul>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={pageRows}
            rowKey={(lead) => lead.id}
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

      {breakdownLead && <ScoreBreakdown lead={breakdownLead} onClose={() => setBreakdownLeadId(null)} />}
    </div>
  );
}
