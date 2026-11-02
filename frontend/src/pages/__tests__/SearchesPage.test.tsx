import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchesPage } from '../SearchesPage';
import { DemoDataProvider } from '../../lib/DemoDataContext';
import type { RunSearchResponse, SearchRecord } from '../../types';

const mockFetch = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A row from before Phase 20: none of the configuration fields exist. */
const LEGACY_SEARCH: SearchRecord = {
  id: 'search-legacy',
  search_query: 'plumbers in Mombasa',
  category: 'plumber',
  location: 'Mombasa',
  results_count: 12,
  started_at: '2026-09-01T08:00:00.000Z',
  completed_at: '2026-09-01T08:00:04.000Z',
  status: 'completed',
};

/** The same row shape after migration 007: legacy rows read NULL / defaults. */
const LEGACY_SEARCH_WITH_DEFAULTS: SearchRecord = {
  ...LEGACY_SEARCH,
  id: 'search-legacy-defaults',
  search_query: 'electricians in Kisumu',
  keyword: null,
  radius_meters: null,
  max_results: 20,
  analysis_options: { website_analysis: false, ai_analysis: false },
};

const CONFIGURED_SEARCH: SearchRecord = {
  id: 'search-new',
  search_query: 'barbershop barber in Nairobi',
  category: 'barber',
  location: 'Nairobi',
  keyword: 'barbershop',
  results_count: 0,
  started_at: '2026-09-24T08:00:00.000Z',
  completed_at: '2026-09-24T08:00:03.000Z',
  status: 'completed',
  radius_meters: 5000,
  max_results: 10,
  analysis_options: { website_analysis: true, ai_analysis: false },
};

const FAILED_SEARCH: SearchRecord = {
  ...LEGACY_SEARCH,
  id: 'search-failed',
  search_query: 'florists in Nakuru',
  category: 'florist',
  location: 'Nakuru',
  results_count: 0,
  status: 'failed',
};

const ZERO_RESULT_RESPONSE: RunSearchResponse = {
  search: CONFIGURED_SEARCH,
  businesses: [],
  summary: { places_returned: 0, excluded_outside_radius: 0, results_count: 0 },
};

/** Routes fetch by method: GETs return the queued history lists in order (last one repeats), POST returns `post`. */
function routeFetch(histories: SearchRecord[][], post?: Response) {
  let getCount = 0;
  mockFetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return post ?? jsonResponse(200, ZERO_RESULT_RESPONSE);
    const history = histories[Math.min(getCount, histories.length - 1)];
    getCount += 1;
    return jsonResponse(200, history);
  });
}

function renderPage() {
  return render(
    <DemoDataProvider>
      <SearchesPage />
    </DemoDataProvider>,
  );
}

function getRequests(): unknown[] {
  return mockFetch.mock.calls.filter(([, init]) => !init || !init.method || init.method === 'GET').map(([url]) => url);
}

describe('SearchesPage with the Search Configuration form', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('keeps the existing page: header, the extended search form (no second search page), and the history table', async () => {
    routeFetch([[LEGACY_SEARCH]]);
    renderPage();

    expect(screen.getByRole('heading', { name: 'Searches' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Search configuration' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Run Search' })).toHaveLength(1);
    expect(await screen.findByText('plumbers in Mombasa')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Query/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
    expect(getRequests()).toEqual(['/api/searches']);
  });

  it('shows the empty history state when there are no searches yet', async () => {
    routeFetch([[]]);
    renderPage();

    expect(await screen.findByText('No searches yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Search' })).toBeInTheDocument();
  });

  it("shows the existing error state when history can't be loaded, and the form still works", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { error: 'Something went wrong while reading from the database.' }));
    renderPage();

    expect(await screen.findByText("Couldn't load searches")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
  });

  it('shows old records (no Phase 20 fields) without made-up configuration', async () => {
    routeFetch([[LEGACY_SEARCH, LEGACY_SEARCH_WITH_DEFAULTS]]);
    renderPage();

    const legacyRow = (await screen.findByText('plumbers in Mombasa')).closest('tr') as HTMLElement;
    expect(legacyRow).not.toHaveTextContent('Radius');
    expect(legacyRow).not.toHaveTextContent('Max results');
    expect(legacyRow).not.toHaveTextContent('Analysis');
    expect(within(legacyRow).getByText('12')).toBeInTheDocument();
    expect(within(legacyRow).getByText('Completed')).toBeInTheDocument();

    // Migrated rows: NULL keyword/radius are simply not shown; the defaults are.
    const migratedRow = screen.getByText('electricians in Kisumu').closest('tr') as HTMLElement;
    expect(migratedRow).toHaveTextContent('Max results: 20');
    expect(migratedRow).toHaveTextContent('Analysis requested: none');
    expect(migratedRow).not.toHaveTextContent('Keyword');
    expect(migratedRow).not.toHaveTextContent('Radius');
  });

  it('shows the search configuration on new records', async () => {
    routeFetch([[CONFIGURED_SEARCH]]);
    renderPage();

    const row = (await screen.findByText('barbershop barber in Nairobi')).closest('tr') as HTMLElement;

    expect(row).toHaveTextContent('Keyword: barbershop');
    expect(row).toHaveTextContent('Radius: 5,000 m');
    expect(row).toHaveTextContent('Max results: 10');
    expect(row).toHaveTextContent('Analysis requested: website');
    expect(within(row).getByText('Completed')).toBeInTheDocument();
    expect(within(row).getByText('barber')).toBeInTheDocument();
    expect(within(row).getByText('Nairobi')).toBeInTheDocument();
  });

  it('adds a new search to the history after a successful run, without a page reload', async () => {
    routeFetch([[LEGACY_SEARCH], [CONFIGURED_SEARCH, LEGACY_SEARCH]]);
    renderPage();
    await screen.findByText('plumbers in Mombasa');
    expect(screen.queryByText('barbershop barber in Nairobi')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'barber' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Nairobi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Search' }));

    expect(await screen.findByText('No businesses found')).toBeInTheDocument();
    const row = (await screen.findByText('barbershop barber in Nairobi')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Radius: 5,000 m');
    expect(screen.getByText('plumbers in Mombasa')).toBeInTheDocument();
    expect(getRequests()).toEqual(['/api/searches', '/api/searches']);
  });

  it('does not refresh the history when the request never reached the backend', async () => {
    routeFetch([[LEGACY_SEARCH]], jsonResponse(400, { error: '"category" is required.' }));
    renderPage();
    await screen.findByText('plumbers in Mombasa');

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'barber' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Nairobi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Search' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('"category" is required.');
    expect(getRequests()).toEqual(['/api/searches']);
  });

  it('still filters history by status and by text', async () => {
    const keywordOnly: SearchRecord = { ...LEGACY_SEARCH, id: 'search-keyword', search_query: 'hairdressers in Thika', keyword: 'unisex' };
    routeFetch([[LEGACY_SEARCH, CONFIGURED_SEARCH, FAILED_SEARCH, keywordOnly]]);
    renderPage();
    await screen.findByText('plumbers in Mombasa');
    expect(screen.getByText('florists in Nakuru')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by search status'), { target: { value: 'failed' } });
    expect(screen.getByText('florists in Nakuru')).toBeInTheDocument();
    expect(screen.queryByText('plumbers in Mombasa')).not.toBeInTheDocument();
    expect(screen.queryByText('barbershop barber in Nairobi')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by search status'), { target: { value: 'all' } });
    const searchBox = screen.getByPlaceholderText('Search by query, category, or location…');
    fireEvent.change(searchBox, { target: { value: 'nairobi' } });
    expect(screen.getByText('barbershop barber in Nairobi')).toBeInTheDocument();
    expect(screen.queryByText('plumbers in Mombasa')).not.toBeInTheDocument();

    // The stored keyword is searchable too, even when it is not part of the query text.
    fireEvent.change(searchBox, { target: { value: 'unisex' } });
    expect(screen.getByText('hairdressers in Thika')).toBeInTheDocument();
    expect(screen.queryByText('barbershop barber in Nairobi')).not.toBeInTheDocument();
  });

  it('still hides the search form in demo mode and shows the demo banner', () => {
    window.localStorage.setItem('alh_demo_mode', 'true');
    renderPage();

    expect(screen.getByText('Demo data is on.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Search configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run Search' })).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
