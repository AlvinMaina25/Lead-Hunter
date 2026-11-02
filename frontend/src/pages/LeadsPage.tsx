import { AlertTriangle } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { DemoBanner } from '../components/ui/DemoBanner';
import { EmptyState } from '../components/ui/EmptyState';
import { LeadsTable } from '../components/leads/LeadsTable';
import { ExportLeadsButton } from '../components/leads/ExportLeadsButton';
import { ScoreNewBusinessesButton } from '../components/leads/ScoreNewBusinessesButton';
import { useLeads } from '../hooks/useData';

export function LeadsPage() {
  const leads = useLeads();

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Every business scored and prioritized for outreach."
        actions={
          <div className="flex items-start gap-2">
            {/* Demo data has no backend to score against. */}
            {!leads.isDemo && <ScoreNewBusinessesButton onScored={leads.refetch} />}
            <ExportLeadsButton />
          </div>
        }
      />
      <DemoBanner />
      {leads.isError ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Couldn't load leads"
          description={leads.error ?? 'Something went wrong connecting to the database. Please try again.'}
        />
      ) : (
        <LeadsTable leads={leads.data} isLoading={leads.isLoading} />
      )}
    </div>
  );
}
