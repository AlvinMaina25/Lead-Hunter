/**
 * Remembers where the user was in the Leads table (page, search, filters,
 * sort) so that opening a lead and coming back -- via the "Back to leads"
 * link or the browser's Back button -- lands on the same page instead of
 * page 1. LeadsTable's state is otherwise local, so it is lost when the
 * Leads page unmounts.
 *
 * Kept in sessionStorage (cleared when the tab closes), with an in-memory
 * copy as a fallback for when storage is unavailable.
 */

export interface LeadsViewState {
  search: string;
  priorityFilter: string;
  statusFilter: string;
  contactFilter: string;
  sortKey: string;
  sortDirection: 'asc' | 'desc';
  page: number;
}

export const DEFAULT_LEADS_VIEW_STATE: LeadsViewState = {
  search: '',
  priorityFilter: 'all',
  statusFilter: 'all',
  contactFilter: 'all',
  sortKey: 'created_at',
  sortDirection: 'desc',
  page: 1,
};

const STORAGE_KEY = 'alvin.leadsViewState.v1';

let memoryCopy: LeadsViewState | null = null;

function isValid(value: unknown): value is LeadsViewState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.search === 'string' &&
    typeof v.priorityFilter === 'string' &&
    typeof v.statusFilter === 'string' &&
    typeof v.contactFilter === 'string' &&
    typeof v.sortKey === 'string' &&
    (v.sortDirection === 'asc' || v.sortDirection === 'desc') &&
    typeof v.page === 'number' &&
    Number.isInteger(v.page) &&
    v.page >= 1
  );
}

export function loadLeadsViewState(): LeadsViewState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValid(parsed)) return parsed;
    }
  } catch {
    // storage unavailable or corrupt -- fall through
  }
  return memoryCopy ?? DEFAULT_LEADS_VIEW_STATE;
}

export function saveLeadsViewState(state: LeadsViewState): void {
  memoryCopy = state;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore -- the in-memory copy still covers in-app navigation
  }
}

export function resetLeadsViewState(): void {
  memoryCopy = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
