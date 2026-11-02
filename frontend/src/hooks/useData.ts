import { useEffect, useState } from 'react';
import { useDemoData } from '../lib/DemoDataContext';
import { fetchAnalytics, fetchBusinesses, fetchDashboardMetrics, fetchLeads, fetchSearches } from '../lib/api';
import { DEMO_BUSINESSES, DEMO_LEADS, DEMO_SEARCHES, computeDemoMetrics } from '../data/mockData';
import type { AnalyticsData, Business, DashboardMetrics, Lead, SearchRecord } from '../types';

interface AsyncState<T> {
  data: T;
  isLoading: boolean;
  isDemo: boolean;
  isError: boolean;
  error: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong loading this data.';
}

export function useDashboardMetrics(): AsyncState<DashboardMetrics> {
  const { isDemoMode } = useDemoData();
  const [state, setState] = useState<AsyncState<DashboardMetrics>>({
    data: {
      totalBusinesses: 0,
      totalLeads: 0,
      businessesWithNoWebsite: 0,
      websitesNeedingImprovement: 0,
      highPriorityLeads: 0,
      leadsContacted: 0,
      leadsWon: 0,
    },
    isLoading: true,
    isDemo: isDemoMode,
    isError: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, isError: false, error: null }));

    if (isDemoMode) {
      setState({ data: computeDemoMetrics(), isLoading: false, isDemo: true, isError: false, error: null });
      return;
    }

    fetchDashboardMetrics()
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, isDemo: false, isError: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((s) => ({ ...s, isLoading: false, isDemo: false, isError: true, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  return state;
}

// The leads list comes from a remote database, so a fresh request on every
// click on "Leads" made the page feel slow. The last list that loaded is
// kept here: the page shows it immediately and refreshes it in the
// background. It is also requested once as the app opens (prefetchLeads),
// so even the first click is usually instant.
let leadsCache: Lead[] | null = null;
let leadsInFlight: Promise<Lead[]> | null = null;

/** `force` always starts a new request (used after the data was changed, e.g. scoring). */
function loadLeads(force = false): Promise<Lead[]> {
  if (force || !leadsInFlight) {
    const request: Promise<Lead[]> = fetchLeads()
      .then((data) => {
        leadsCache = data;
        return data;
      })
      .finally(() => {
        if (leadsInFlight === request) leadsInFlight = null;
      });
    leadsInFlight = request;
  }
  return leadsInFlight;
}

/** Starts loading the leads list in the background. Never throws; errors surface when the Leads page itself loads. */
export function prefetchLeads(): void {
  loadLeads().catch(() => {});
}

/** Forgets the cached leads list (used by tests). */
export function clearLeadsCache(): void {
  leadsCache = null;
  leadsInFlight = null;
}

export function useLeads(): AsyncState<Lead[]> & { refetch: () => void } {
  const { isDemoMode } = useDemoData();
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [state, setState] = useState<AsyncState<Lead[]>>({
    data: !isDemoMode && leadsCache ? leadsCache : [],
    isLoading: isDemoMode || leadsCache === null,
    isDemo: isDemoMode,
    isError: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    // With a cached list there is something to show, so refresh quietly
    // instead of replacing it with a loading state.
    const hasCache = !isDemoMode && leadsCache !== null;
    setState((s) => ({ ...s, isLoading: !hasCache, isError: false, error: null }));

    if (isDemoMode) {
      setState({ data: DEMO_LEADS, isLoading: false, isDemo: true, isError: false, error: null });
      return;
    }

    loadLeads(refreshIndex > 0)
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, isDemo: false, isError: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((s) => ({ ...s, isLoading: false, isDemo: false, isError: true, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDemoMode, refreshIndex]);

  return { ...state, refetch: () => setRefreshIndex((i) => i + 1) };
}

export function useBusinesses(): AsyncState<Business[]> & { refetch: () => void } {
  const { isDemoMode } = useDemoData();
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [state, setState] = useState<AsyncState<Business[]>>({
    data: [],
    isLoading: true,
    isDemo: isDemoMode,
    isError: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, isError: false, error: null }));

    if (isDemoMode) {
      setState({ data: DEMO_BUSINESSES, isLoading: false, isDemo: true, isError: false, error: null });
      return;
    }

    fetchBusinesses()
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, isDemo: false, isError: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((s) => ({ ...s, isLoading: false, isDemo: false, isError: true, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDemoMode, refreshIndex]);

  return { ...state, refetch: () => setRefreshIndex((i) => i + 1) };
}

export function useSearches(): AsyncState<SearchRecord[]> & { refetch: () => void } {
  const { isDemoMode } = useDemoData();
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [state, setState] = useState<AsyncState<SearchRecord[]>>({
    data: [],
    isLoading: true,
    isDemo: isDemoMode,
    isError: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, isError: false, error: null }));

    if (isDemoMode) {
      setState({ data: DEMO_SEARCHES, isLoading: false, isDemo: true, isError: false, error: null });
      return;
    }

    fetchSearches()
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, isDemo: false, isError: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((s) => ({ ...s, isLoading: false, isDemo: false, isError: true, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDemoMode, refreshIndex]);

  return { ...state, refetch: () => setRefreshIndex((i) => i + 1) };
}

/**
 * A GET /api/analytics response with every metric at 0 and every
 * breakdown empty -- the initial state before the first real response
 * arrives, and also exactly what an empty database legitimately looks
 * like (Phase 21 Part 2 Step 12). AnalyticsPage.tsx only ever renders
 * this while isLoading is true (behind the skeleton) or once a real
 * fetch has genuinely returned it -- it is never shown as a stand-in
 * for demo/fake data.
 */
const EMPTY_ANALYTICS: AnalyticsData = {
  metrics: {
    businesses_discovered: 0,
    no_website_businesses: 0,
    poor_website_businesses: 0,
    high_priority_leads: 0,
    contacted_leads: 0,
    responses: 0,
    meetings: 0,
    proposals: 0,
    won_deals: 0,
  },
  lead_priority_breakdown: {},
  pipeline_stage_breakdown: {},
  website_status_breakdown: {},
};

/**
 * Phase 21 Part 2: loads GET /api/analytics.
 *
 * Deliberately does NOT branch on isDemoMode the way every other hook
 * above does -- Phase 21's backend explicitly must never return fake
 * data, so the frontend must never substitute demo data for it either
 * (Part 1 and Part 2 specs both say so directly). This hook always
 * calls the real endpoint regardless of the app-wide demo toggle, so
 * `isDemo` on the returned state is always `false`.
 */
export function useAnalytics(): AsyncState<AnalyticsData> & { refetch: () => void } {
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [state, setState] = useState<AsyncState<AnalyticsData>>({
    data: EMPTY_ANALYTICS,
    isLoading: true,
    isDemo: false,
    isError: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, isError: false, error: null }));

    fetchAnalytics()
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, isDemo: false, isError: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((s) => ({ ...s, isLoading: false, isDemo: false, isError: true, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshIndex]);

  return { ...state, refetch: () => setRefreshIndex((i) => i + 1) };
}
