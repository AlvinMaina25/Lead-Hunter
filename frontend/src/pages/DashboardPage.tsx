import { Link } from 'react-router-dom';
import { Flame, AlertTriangle } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { DemoBanner } from '../components/ui/DemoBanner';
import { HeroMetricCard, MetricStrip } from '../components/ui/MetricCard';
import { MetricStripSkeleton } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { LeadsTable } from '../components/leads/LeadsTable';
import { useDashboardMetrics, useLeads } from '../hooks/useData';

export function DashboardPage() {
  const metrics = useDashboardMetrics();
  const leads = useLeads();

  // "High priority leads" leads the page; everything else is supporting context.
  const supporting = [
    { label: 'Total businesses', value: metrics.data.totalBusinesses },
    { label: 'Total leads', value: metrics.data.totalLeads },
    { label: 'No website', value: metrics.data.businessesWithNoWebsite },
    { label: 'Needs improvement', value: metrics.data.websitesNeedingImprovement },
    { label: 'Leads contacted', value: metrics.data.leadsContacted },
    { label: 'Leads won', value: metrics.data.leadsWon },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A snapshot of your pipeline across businesses, leads, and outreach."
      />
      <DemoBanner />

      {metrics.isError ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Couldn't load dashboard data"
          description={metrics.error ?? 'Something went wrong connecting to the database. Please try again.'}
        />
      ) : (
        <>
          {metrics.isLoading ? (
            <MetricStripSkeleton />
          ) : (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
              <HeroMetricCard
                label="High priority leads"
                value={metrics.data.highPriorityLeads}
                icon={<Flame className="h-4 w-4" />}
              />
              <MetricStrip items={supporting} />
            </div>
          )}

          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Recent leads</h2>
              <Link to="/leads" className="text-sm font-medium text-ink-600 hover:text-ink">
                View all leads
              </Link>
            </div>
            {leads.isError ? (
              <EmptyState
                icon={<AlertTriangle className="h-8 w-8" />}
                title="Couldn't load leads"
                description={leads.error ?? 'Something went wrong connecting to the database. Please try again.'}
              />
            ) : (
              <LeadsTable leads={leads.data} isLoading={leads.isLoading} compact compactLimit={5} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
