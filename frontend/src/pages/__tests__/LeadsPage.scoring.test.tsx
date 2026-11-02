import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadsPage } from '../LeadsPage';
import { DemoDataProvider } from '../../lib/DemoDataContext';

/**
 * "Score new businesses" on the Leads page: after a run the lead list is
 * re-fetched, so newly scored businesses appear without a reload. fetch is
 * routed by URL; GET /api/leads answers differently before and after the
 * scoring call to prove the refresh really happens.
 */
const NEW_LEAD = {
  id: 'lead-1', business_id: 'biz-1', lead_score: 72, priority: 'high', lead_status: 'new',
  estimated_opportunity: null, sales_notes: null, scoring_factors: null,
  scored_at: '2026-10-13T00:00:00.000Z', created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z',
  business_name: 'Freshly Scored Cafe', business_category: 'Cafe', business_city: 'Nairobi',
  business_country: 'Kenya', recommended_service: null,
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function renderPage() {
  return render(
    <MemoryRouter>
      <DemoDataProvider>
        <LeadsPage />
      </DemoDataProvider>
    </MemoryRouter>,
  );
}

describe('LeadsPage: Score new businesses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('scores unscored businesses, then refreshes the leads list', async () => {
    let scored = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/businesses/unscored-count')) return ok({ unscored_count: scored ? 0 : 1 });
      if (url.includes('/api/businesses/lead-score')) {
        scored = true;
        return ok({ requested_limit: 50, businesses_found: 1, results: [{ business_id: 'biz-1', ok: true, lead_score: 72, priority: 'high' }] });
      }
      if (url.includes('/api/leads')) return ok(scored ? [NEW_LEAD] : []);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.queryByText('Freshly Scored Cafe')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Score new businesses (1)' }));

    expect(await screen.findByText('Freshly Scored Cafe')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Scored 1 business.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Score new businesses (0)' })).toBeDisabled());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/leads')).length).toBeGreaterThanOrEqual(2);
  });

  it('is not shown in demo mode (there is no backend to score against)', async () => {
    localStorage.setItem('alh_demo_mode', 'true');
    const fetchMock = vi.fn(async (_url: string) => ok([]));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(await screen.findByRole('button', { name: /Export CSV/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Score new businesses/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('unscored-count'))).toBe(false);
  });
});
