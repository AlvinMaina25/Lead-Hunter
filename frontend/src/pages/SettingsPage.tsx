import { Database, FlaskConical } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { useDemoData } from '../lib/DemoDataContext';

export function SettingsPage() {
  const { isDemoMode, setDemoMode } = useDemoData();

  return (
    <div>
      <PageHeader title="Settings" description="Preferences for this Alvin Lead Hunter workspace." />

      <div className="space-y-4">
        <section className="rounded border border-surface-border bg-white p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Database className="h-4 w-4 text-ink-400" />
            Database connection
          </div>
          <p className="mt-2 text-sm text-ink-600">
            This dashboard never connects to Neon directly from the browser — that would require exposing your
            database credentials to every visitor. Instead, a backend API (see the <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">server/</code>{' '}
            directory) holds the only Neon connection and serves read-only JSON to this UI.
          </p>
          <p className="mt-2 text-sm text-ink-400">
            To verify the Neon connection itself, run{' '}
            <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">npm run test:connection</code>{' '}
            from the project root.
          </p>
        </section>

        <section className="rounded border border-surface-border bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-2">
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
              <div>
                <p className="text-sm font-semibold text-ink">Preview with demo data</p>
                <p className="mt-1 text-sm text-ink-600">
                  Fills every page with clearly-labeled sample businesses and leads so you can review the interface
                  before real data exists. Sample records are never mistaken for real Alvin Lead Hunter data — a
                  banner stays visible the whole time this is on.
                </p>
              </div>
            </div>
            <button
              role="switch"
              aria-checked={isDemoMode}
              onClick={() => setDemoMode(!isDemoMode)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                isDemoMode ? 'bg-ink-600' : 'bg-surface-border'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  isDemoMode ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
