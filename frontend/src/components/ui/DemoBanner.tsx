import { FlaskConical } from 'lucide-react';
import { useDemoData } from '../../lib/DemoDataContext';

export function DemoBanner() {
  const { isDemoMode, setDemoMode } = useDemoData();
  if (!isDemoMode) return null;

  return (
    <div className="mb-6 flex flex-col gap-2 rounded border border-info/25 bg-info-50 px-4 py-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <p>
          <span className="font-semibold text-ink">Demo data is on.</span> Everything on this page is sample data for
          previewing the interface — it is not connected to your Neon database.
        </p>
      </div>
      <button
        onClick={() => setDemoMode(false)}
        className="shrink-0 rounded border border-info/30 bg-white px-3 py-1 text-xs font-medium text-ink-600 transition-colors hover:bg-surface-muted"
      >
        Turn off demo data
      </button>
    </div>
  );
}
