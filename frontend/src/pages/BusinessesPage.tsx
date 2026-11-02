import { AlertTriangle } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { DemoBanner } from '../components/ui/DemoBanner';
import { EmptyState } from '../components/ui/EmptyState';
import { BusinessesTable } from '../components/businesses/BusinessesTable';
import { useBusinesses } from '../hooks/useData';

export function BusinessesPage() {
  const businesses = useBusinesses();

  return (
    <div>
      <PageHeader title="Businesses" description="Every business discovered through your searches." />
      <DemoBanner />
      {businesses.isError ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Couldn't load businesses"
          description={businesses.error ?? 'Something went wrong connecting to the database. Please try again.'}
        />
      ) : (
        <BusinessesTable
          businesses={businesses.data}
          isLoading={businesses.isLoading}
          isDemo={businesses.isDemo}
          onRefetch={businesses.refetch}
        />
      )}
    </div>
  );
}
