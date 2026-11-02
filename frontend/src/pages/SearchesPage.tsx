import { AlertTriangle } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { DemoBanner } from '../components/ui/DemoBanner';
import { EmptyState } from '../components/ui/EmptyState';
import { SearchesTable } from '../components/searches/SearchesTable';
import { BusinessSearchForm } from '../components/searches/BusinessSearchForm';
import { useSearches } from '../hooks/useData';
import { useDemoData } from '../lib/DemoDataContext';

export function SearchesPage() {
  const searches = useSearches();
  const { isDemoMode } = useDemoData();

  return (
    <div>
      <PageHeader title="Searches" description="Discover businesses with Google Places, and review search history." />
      <DemoBanner />
      {!isDemoMode && <BusinessSearchForm onSearchComplete={searches.refetch} />}
      {searches.isError ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Couldn't load searches"
          description={searches.error ?? 'Something went wrong connecting to the database. Please try again.'}
        />
      ) : (
        <SearchesTable searches={searches.data} isLoading={searches.isLoading} />
      )}
    </div>
  );
}
