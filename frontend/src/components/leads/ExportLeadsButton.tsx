import { useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { exportLeadsCsv } from '../../lib/api';

/**
 * Phase 22 Part 2: "Export CSV" action for the Leads page. Requests the
 * backend-generated CSV (GET /api/leads/export.csv, Phase 22 Part 1) and
 * lets the browser download it -- the frontend never builds the CSV
 * itself. Guards against duplicate clicks while a request is in flight
 * and surfaces failures inline, following the same error-banner pattern
 * as BusinessSearchForm.
 */
export function ExportLeadsButton() {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    if (isExporting) return;

    setIsExporting(true);
    setError(null);

    try {
      await exportLeadsCsv();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to export leads. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant="secondary"
        onClick={handleExport}
        disabled={isExporting}
        aria-busy={isExporting}
        icon={isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      >
        {isExporting ? 'Exporting…' : 'Export CSV'}
      </Button>

      {error && (
        <div className="flex items-start gap-2 rounded border border-danger/20 bg-danger-50 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
