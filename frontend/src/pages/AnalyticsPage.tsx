import {
  Building2,
  GlobeLock,
  Wrench,
  Flame,
  PhoneCall,
  MessageSquare,
  CalendarClock,
  FileText,
  Trophy,
  AlertTriangle,
  RefreshCw,
  Globe,
  Users,
  GitBranch,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricCardSkeleton } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { BreakdownPanel, type BreakdownEntry } from '../components/analytics/BreakdownPanel';
import { useAnalytics } from '../hooks/useData';

/**
 * Known label maps for the three breakdowns (Phase 21 Part 2 Steps
 * 6-8). These only make known values readable -- they never limit
 * which keys are rendered. Any key the backend returns that isn't
 * listed here still renders, via formatFallbackLabel below, rather
 * than being hidden (Step 6: "Do NOT hardcode only these ... if the
 * backend returns additional valid categories").
 */
const WEBSITE_STATUS_LABELS: Record<string, string> = {
  no_website: 'No Website',
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
};

/** Deliberately has no entry for the retired 'urgent' value (Step 7). */
const LEAD_PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  very_high: 'Very High',
};

const PIPELINE_STAGE_LABELS: Record<string, string> = {
  new: 'New',
  researched: 'Researched',
  contacted: 'Contacted',
  responded: 'Responded',
  meeting: 'Meeting',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};

/**
 * Fallback for any breakdown key not in the label maps above
 * ('some_new_status' -> 'Some New Status'). The backend is the source
 * of truth for which categories exist (server/lib/analytics.js) --
 * this only makes an unrecognized key readable, it never drops it.
 */
function formatFallbackLabel(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function toBreakdownEntries(breakdown: Record<string, number>, labels: Record<string, string>): BreakdownEntry[] {
  return Object.entries(breakdown).map(([key, count]) => ({
    key,
    label: labels[key] ?? formatFallbackLabel(key),
    count,
  }));
}

export function AnalyticsPage() {
  const analytics = useAnalytics();
  const { metrics, website_status_breakdown, lead_priority_breakdown, pipeline_stage_breakdown } = analytics.data;

  /**
   * Nine primary metrics (Step 4), one reusable MetricCard each --
   * not nine separate implementations. Labels are the neutral wording
   * from Step 9 ("Contacted", "Responses", ... rather than "Total
   * people ever contacted" etc.), since contacted_leads/responses/
   * meetings/proposals/won_deals are current-stage snapshots, not
   * lifetime funnel totals -- see AnalyticsMetrics in ../types.
   */
  const metricCards = [
    {
      id: 'businesses_discovered',
      label: 'Businesses Discovered',
      value: metrics.businesses_discovered,
      tone: 'ink' as const,
      icon: <Building2 className="h-4 w-4" />,
    },
    {
      id: 'no_website_businesses',
      label: 'No Website',
      value: metrics.no_website_businesses,
      tone: 'signal' as const,
      icon: <GlobeLock className="h-4 w-4" />,
    },
    {
      id: 'poor_website_businesses',
      label: 'Poor Websites',
      value: metrics.poor_website_businesses,
      tone: 'signal' as const,
      icon: <Wrench className="h-4 w-4" />,
    },
    {
      id: 'high_priority_leads',
      label: 'High-Priority Leads',
      value: metrics.high_priority_leads,
      tone: 'danger' as const,
      icon: <Flame className="h-4 w-4" />,
    },
    {
      id: 'contacted_leads',
      label: 'Contacted',
      value: metrics.contacted_leads,
      tone: 'info' as const,
      icon: <PhoneCall className="h-4 w-4" />,
    },
    {
      id: 'responses',
      label: 'Responses',
      value: metrics.responses,
      tone: 'info' as const,
      icon: <MessageSquare className="h-4 w-4" />,
    },
    {
      id: 'meetings',
      label: 'Meetings',
      value: metrics.meetings,
      tone: 'info' as const,
      icon: <CalendarClock className="h-4 w-4" />,
    },
    {
      id: 'proposals',
      label: 'Proposals',
      value: metrics.proposals,
      tone: 'info' as const,
      icon: <FileText className="h-4 w-4" />,
    },
    {
      id: 'won_deals',
      label: 'Won Deals',
      value: metrics.won_deals,
      tone: 'success' as const,
      icon: <Trophy className="h-4 w-4" />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Track lead generation, website opportunities, and sales pipeline progress."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={`h-4 w-4 ${analytics.isLoading ? 'animate-spin' : ''}`} />}
            onClick={analytics.refetch}
            disabled={analytics.isLoading}
          >
            Refresh
          </Button>
        }
      />

      {analytics.isError ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Unable to load analytics."
          description={analytics.error ?? 'Please try again.'}
          action={
            <Button variant="secondary" size="sm" onClick={analytics.refetch}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {analytics.isLoading
              ? Array.from({ length: 9 }).map((_, i) => <MetricCardSkeleton key={i} />)
              : metricCards.map((card) => {
                  const { id, ...cardProps } = card;
                  return <MetricCard key={id} {...cardProps} />;
                })}
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            <BreakdownPanel
              title="Website Status"
              icon={<Globe className="h-4 w-4 text-ink-400" />}
              entries={toBreakdownEntries(website_status_breakdown, WEBSITE_STATUS_LABELS)}
              emptyMessage="No website status data yet."
              isLoading={analytics.isLoading}
            />
            <BreakdownPanel
              title="Lead Priority"
              icon={<Users className="h-4 w-4 text-ink-400" />}
              entries={toBreakdownEntries(lead_priority_breakdown, LEAD_PRIORITY_LABELS)}
              emptyMessage="No lead priority data yet."
              isLoading={analytics.isLoading}
            />
            <BreakdownPanel
              title="Pipeline Stage"
              icon={<GitBranch className="h-4 w-4 text-ink-400" />}
              entries={toBreakdownEntries(pipeline_stage_breakdown, PIPELINE_STAGE_LABELS)}
              emptyMessage="No pipeline stage data yet."
              isLoading={analytics.isLoading}
            />
          </div>
        </>
      )}
    </div>
  );
}
