import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LeadsPage } from '../LeadsPage';
import { DemoDataProvider } from '../../lib/DemoDataContext';

/**
 * Phase 22 Part 2: useLeads (hooks/useData.ts) reads demo mode via
 * DemoDataProvider, so the page needs that context to render at all --
 * same requirement any other consumer of the Leads page already has.
 * Demo mode defaults to off (see DemoDataContext#readInitialValue), so
 * these tests mock the real GET /api/leads fetch.
 */
function renderLeadsPage() {
  return render(
    <MemoryRouter>
      <DemoDataProvider>
        <LeadsPage />
      </DemoDataProvider>
    </MemoryRouter>,
  );
}

const SAMPLE_LEADS = [
  {
    id: 'lead-1',
    business_id: 'biz-1',
    lead_score: 72,
    priority: 'high',
    lead_status: 'new',
    estimated_opportunity: null,
    sales_notes: null,
    scoring_factors: null,
    scored_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    business_name: 'Acme Cafe',
    business_category: 'Cafe',
    business_city: 'Nairobi',
    business_country: 'Kenya',
    recommended_service: null,
  },
];

describe('LeadsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE_LEADS,
    } as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('still renders the page heading and leads table alongside the new Export CSV button', async () => {
    renderLeadsPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Leads' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Acme Cafe')).toBeInTheDocument());
  });
});
