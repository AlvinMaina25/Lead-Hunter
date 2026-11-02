import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessSearchForm } from '../BusinessSearchForm';
import type { DiscoveredBusiness, RunSearchResponse, SearchRecord } from '../../../types';

const mockFetch = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    id: 'biz-1',
    external_place_id: 'place-1',
    name: 'Sharp Cuts Barbershop',
    category: 'barber',
    phone: null,
    email: null,
    address: null,
    city: 'Nairobi',
    country: 'Kenya',
    latitude: null,
    longitude: null,
    google_maps_url: null,
    google_rating: 4.6,
    google_review_count: 120,
    website_url: null,
    website_status: 'no_website',
    website_checked_at: null,
    created_at: '2026-09-24T08:00:00.000Z',
    updated_at: '2026-09-24T08:00:00.000Z',
    isNew: true,
    ...overrides,
  };
}

function makeSearch(overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    id: 'search-1',
    search_query: 'barbershop barber in Nairobi',
    category: 'barber',
    location: 'Nairobi',
    keyword: 'barbershop',
    results_count: 2,
    started_at: '2026-09-24T08:00:00.000Z',
    completed_at: '2026-09-24T08:00:03.000Z',
    status: 'completed',
    radius_meters: 5000,
    max_results: 10,
    analysis_options: { website_analysis: true, ai_analysis: false },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<RunSearchResponse> = {}): RunSearchResponse {
  return {
    search: makeSearch(),
    businesses: [
      makeBusiness(),
      makeBusiness({ id: 'biz-2', external_place_id: 'place-2', name: 'Fade Masters', isNew: false }),
    ],
    summary: { places_returned: 8, excluded_outside_radius: 6, results_count: 2 },
    ...overrides,
  };
}

function fillRequired(category = 'barber', location = 'Nairobi') {
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: category } });
  fireEvent.change(screen.getByLabelText('Location'), { target: { value: location } });
}

function clickRunSearch() {
  fireEvent.click(screen.getByRole('button', { name: 'Run Search' }));
}

/** The JSON body of the (single) POST /api/searches the form sent. */
function postedBody(): Record<string, unknown> {
  const posts = mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  return JSON.parse(posts[0][1].body as string) as Record<string, unknown>;
}

function stat(region: HTMLElement, label: string): HTMLElement | null {
  const term = within(region).queryByText(label);
  return term ? (term.nextElementSibling as HTMLElement | null) : null;
}

describe('BusinessSearchForm — Search Configuration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('rendering and defaults', () => {
    it('renders the Search Configuration form with a Run Search button', () => {
      render(<BusinessSearchForm />);

      expect(screen.getByRole('heading', { name: 'Search configuration' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
    });

    it('renders a required Category field', () => {
      render(<BusinessSearchForm />);

      const category = screen.getByLabelText('Category');
      expect(category).toBeRequired();
      expect(category).toHaveValue('');

      fireEvent.change(category, { target: { value: 'barber' } });
      expect(category).toHaveValue('barber');
    });

    it('renders a required Location field', () => {
      render(<BusinessSearchForm />);

      const location = screen.getByLabelText('Location');
      expect(location).toBeRequired();
      expect(location).toHaveValue('');

      fireEvent.change(location, { target: { value: 'Nairobi' } });
      expect(location).toHaveValue('Nairobi');
    });

    it('renders an optional Keyword field, separate from Category', () => {
      render(<BusinessSearchForm />);

      const keyword = screen.getByLabelText(/keyword/i);
      expect(keyword).not.toBeRequired();
      expect(keyword).not.toBe(screen.getByLabelText('Category'));

      fireEvent.change(keyword, { target: { value: 'barbershop' } });
      expect(keyword).toHaveValue('barbershop');
    });

    it('renders an optional numeric Radius field with the unit spelled out', () => {
      render(<BusinessSearchForm />);

      const radius = screen.getByLabelText(/^radius/i);
      expect(radius).toHaveAttribute('type', 'number');
      expect(radius).not.toBeRequired();
      expect(radius).toHaveValue(null); // empty = no radius
      expect(screen.getByText(/^Radius/)).toHaveTextContent(/meters/);
      expect(screen.getByText(/1 to 50,000 meters/)).toBeInTheDocument();
    });

    it('renders a numeric Maximum results field that defaults to 20', () => {
      render(<BusinessSearchForm />);

      const maxResults = screen.getByLabelText('Maximum results');
      expect(maxResults).toHaveAttribute('type', 'number');
      expect(maxResults).toHaveValue(20);
    });

    it('accepts 50 as Maximum results and sends it', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);
      fillRequired();
      fireEvent.change(screen.getByLabelText('Maximum results'), { target: { value: '50' } });

      clickRunSearch();
      await screen.findByText('Search complete');

      expect(postedBody().max_results).toBe(50);
    });

    it('renders a Website analysis toggle, OFF by default', () => {
      render(<BusinessSearchForm />);

      const toggle = screen.getByRole('checkbox', { name: 'Website analysis' });
      expect(toggle).not.toBeChecked();

      fireEvent.click(toggle);
      expect(toggle).toBeChecked();
    });

    it('renders an AI analysis toggle, OFF by default', () => {
      render(<BusinessSearchForm />);

      const toggle = screen.getByRole('checkbox', { name: 'AI analysis' });
      expect(toggle).not.toBeChecked();

      fireEvent.click(toggle);
      expect(toggle).toBeChecked();
    });

    it('sends the defaults (max results 20, both analysis options off, no radius) when only the required fields are filled', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);

      fillRequired();
      clickRunSearch();
      await screen.findByText('Search complete');

      expect(postedBody()).toEqual({
        category: 'barber',
        location: 'Nairobi',
        radius_meters: null,
        max_results: 20,
        analysis_options: { website_analysis: false, ai_analysis: false },
      });
    });

    it('does not search, or analyze anything, until Run Search is clicked', () => {
      render(<BusinessSearchForm />);
      fillRequired();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Website analysis' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'AI analysis' }));

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('gives every field an accessible name', () => {
      render(<BusinessSearchForm />);

      expect(screen.getByRole('textbox', { name: 'Category' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Location' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /keyword/i })).toBeInTheDocument();
      expect(screen.getByRole('spinbutton', { name: /radius/i })).toBeInTheDocument();
      expect(screen.getByRole('spinbutton', { name: 'Maximum results' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Website analysis' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'AI analysis' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Analysis options' })).toBeInTheDocument();
    });

    it('runs the search through the form submit event (what pressing Enter in a field triggers)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);
      fillRequired();

      fireEvent.submit(screen.getByLabelText('Category').closest('form') as HTMLFormElement);

      await screen.findByText('Search complete');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('client-side validation', () => {
    it('requires category and location, tells the user, and does not call the API', () => {
      render(<BusinessSearchForm />);

      clickRunSearch();

      expect(screen.getByText('Category is required.')).toBeInTheDocument();
      expect(screen.getByText('Location is required.')).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('associates each message with its field and moves focus to the first invalid one', () => {
      render(<BusinessSearchForm />);

      clickRunSearch();

      const category = screen.getByLabelText('Category');
      expect(category).toHaveAttribute('aria-invalid', 'true');
      expect(category).toHaveAccessibleDescription('Category is required.');
      expect(screen.getByLabelText('Location')).toHaveAccessibleDescription('Location is required.');
      expect(category).toHaveFocus();
    });

    it('treats whitespace-only required fields as empty', () => {
      render(<BusinessSearchForm />);
      fillRequired('   ', '   ');

      clickRunSearch();

      expect(screen.getByText('Category is required.')).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(['0', '-5', '50001'])('rejects an invalid radius (%s) instead of converting it', (value) => {
      render(<BusinessSearchForm />);
      fillRequired();
      fireEvent.change(screen.getByLabelText(/^radius/i), { target: { value } });

      clickRunSearch();

      expect(screen.getByText('Radius must be between 1 and 50,000 meters.')).toBeInTheDocument();
      expect(screen.getByLabelText(/^radius/i)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(/^radius/i)).toHaveAccessibleDescription(/must be between 1 and 50,000 meters/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(['1', '50000'])('accepts the radius bound %s', async (value) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);
      fillRequired();
      fireEvent.change(screen.getByLabelText(/^radius/i), { target: { value } });

      clickRunSearch();
      await screen.findByText('Search complete');

      expect(postedBody().radius_meters).toBe(Number(value));
    });

    it.each(['0', '51', '2.5', ''])('rejects invalid maximum results (%j)', (value) => {
      render(<BusinessSearchForm />);
      fillRequired();
      fireEvent.change(screen.getByLabelText('Maximum results'), { target: { value } });

      clickRunSearch();

      expect(screen.getByText('Maximum results must be a whole number from 1 to 50.')).toBeInTheDocument();
      expect(screen.getByLabelText('Maximum results')).toHaveAttribute('aria-invalid', 'true');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('clears a message as soon as the field is corrected', () => {
      render(<BusinessSearchForm />);
      clickRunSearch();
      expect(screen.getByText('Category is required.')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'barber' } });

      expect(screen.queryByText('Category is required.')).not.toBeInTheDocument();
      expect(screen.getByText('Location is required.')).toBeInTheDocument();
    });
  });

  describe('running a search', () => {
    it('sends the full configuration to POST /api/searches and notifies the parent', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      const onSearchComplete = vi.fn();
      render(<BusinessSearchForm onSearchComplete={onSearchComplete} />);

      fillRequired('barber', 'Nairobi');
      fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: 'barbershop' } });
      fireEvent.change(screen.getByLabelText(/^radius/i), { target: { value: '5000' } });
      fireEvent.change(screen.getByLabelText('Maximum results'), { target: { value: '10' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Website analysis' }));
      clickRunSearch();
      await screen.findByText('Search complete');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('/api/searches');
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'POST' });
      expect(postedBody()).toEqual({
        category: 'barber',
        location: 'Nairobi',
        keyword: 'barbershop',
        radius_meters: 5000,
        max_results: 10,
        analysis_options: { website_analysis: true, ai_analysis: false },
      });
      expect(onSearchComplete).toHaveBeenCalledTimes(1);
    });

    it('never calls a website-analysis or AI endpoint, even with both toggles on', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);

      fillRequired();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Website analysis' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'AI analysis' }));
      clickRunSearch();
      await screen.findByText('Search complete');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('/api/searches');
      expect(postedBody().analysis_options).toEqual({ website_analysis: true, ai_analysis: true });
    });

    it('shows a loading state, disables the button while running, and re-enables it afterwards', async () => {
      let resolveFetch!: (res: Response) => void;
      mockFetch.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();

      const busyButton = await screen.findByRole('button', { name: /searching/i });
      expect(busyButton).toBeDisabled();
      expect(screen.getByText(/running your search/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Category')).toBeDisabled();

      // A second click while the request is in flight must not send a second request.
      fireEvent.click(busyButton);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      resolveFetch(jsonResponse(200, makeResponse()));

      await screen.findByText('Search complete');
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
      expect(screen.queryByText(/running your search/i)).not.toBeInTheDocument();
    });
  });

  describe('success state', () => {
    it('summarizes the search using the backend response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const region = await screen.findByRole('status', { name: 'Search results' });

      expect(stat(region, 'Category')).toHaveTextContent('barber');
      expect(stat(region, 'Location')).toHaveTextContent('Nairobi');
      expect(stat(region, 'Keyword')).toHaveTextContent('barbershop');
      expect(stat(region, 'Radius')).toHaveTextContent('5,000 m');
      expect(stat(region, 'Maximum results')).toHaveTextContent('10');
      expect(stat(region, 'Places returned')).toHaveTextContent('8');
      expect(stat(region, 'Results')).toHaveTextContent('2');
      expect(stat(region, 'Excluded by radius')).toHaveTextContent('6');
      expect(within(region).getByText('Sharp Cuts Barbershop')).toBeInTheDocument();
      expect(within(region).getByText('Fade Masters')).toBeInTheDocument();
      expect(region).toHaveTextContent('1 new, 1 already known');
    });

    it('omits radius details when no radius was used', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          200,
          makeResponse({
            search: makeSearch({ radius_meters: null }),
            summary: { places_returned: 2, excluded_outside_radius: 0, results_count: 2 },
          }),
        ),
      );
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const region = await screen.findByRole('status', { name: 'Search results' });

      expect(stat(region, 'Radius')).toBeNull();
      expect(stat(region, 'Excluded by radius')).toBeNull();
      expect(stat(region, 'Places returned')).toHaveTextContent('2');
    });

    it('shows an explicit empty result state (not an error) when nothing was found', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          200,
          makeResponse({
            search: makeSearch({ results_count: 0 }),
            businesses: [],
            summary: { places_returned: 0, excluded_outside_radius: 0, results_count: 0 },
          }),
        ),
      );
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const region = await screen.findByRole('status', { name: 'Search results' });

      expect(within(region).getByText('No businesses found')).toBeInTheDocument();
      expect(stat(region, 'Results')).toHaveTextContent('0');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
    });

    it('explains an empty result caused by the radius filter, using the backend counts', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          200,
          makeResponse({
            search: makeSearch({ results_count: 0 }),
            businesses: [],
            summary: { places_returned: 5, excluded_outside_radius: 5, results_count: 0 },
          }),
        ),
      );
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const region = await screen.findByRole('status', { name: 'Search results' });

      expect(within(region).getByText('No businesses found')).toBeInTheDocument();
      expect(region).toHaveTextContent('Google returned 5 places, and 5 of them were outside the radius.');
      expect(stat(region, 'Excluded by radius')).toHaveTextContent('5');
    });

    it('does not invent counts when the response has no summary', async () => {
      const { summary: _omitted, ...withoutSummary } = makeResponse();
      void _omitted;
      mockFetch.mockResolvedValueOnce(jsonResponse(200, withoutSummary));
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const region = await screen.findByRole('status', { name: 'Search results' });

      expect(stat(region, 'Places returned')).toBeNull();
      expect(stat(region, 'Excluded by radius')).toBeNull();
      expect(stat(region, 'Results')).toHaveTextContent('2');
    });
  });

  describe('error states', () => {
    it('shows the backend message for a 400 invalid configuration', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: '"max_results" must be between 1 and 20.' }));
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent('Invalid search configuration');
      expect(alert).toHaveTextContent('"max_results" must be between 1 and 20.');
      expect(alert).not.toHaveTextContent('Something went wrong');
      expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
    });

    it('shows the actual message for a 422 radius-location error', async () => {
      const message =
        'Could not find map coordinates for "Xyzzyville", so the search radius cannot be applied. Try a more specific location, or search without a radius.';
      mockFetch.mockResolvedValueOnce(jsonResponse(422, { error: message, searchId: 'search-9' }));
      const onSearchComplete = vi.fn();
      render(<BusinessSearchForm onSearchComplete={onSearchComplete} />);
      fillRequired('barber', 'Xyzzyville');
      fireEvent.change(screen.getByLabelText(/^radius/i), { target: { value: '5000' } });

      clickRunSearch();
      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent("Radius couldn't be applied");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent('Something went wrong');
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
      // The backend recorded a failed search, so the history is worth refreshing.
      expect(onSearchComplete).toHaveBeenCalledTimes(1);
    });

    it('shows a Google Places configuration problem for a 503', async () => {
      const message = 'Google Places integration is not configured. Set GOOGLE_PLACES_API_KEY on the server and restart.';
      mockFetch.mockResolvedValueOnce(jsonResponse(503, { error: message }));
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent('Google Places API unavailable');
      expect(alert).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled();
    });

    it('shows a friendly, retryable error for a network failure, and Try again re-runs the search', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const onSearchComplete = vi.fn();
      render(<BusinessSearchForm onSearchComplete={onSearchComplete} />);
      fillRequired();

      clickRunSearch();
      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent("Couldn't reach the server");
      expect(alert).toHaveTextContent('Check your connection and try again.');
      expect(onSearchComplete).not.toHaveBeenCalled();

      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

      await screen.findByText('Search complete');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(onSearchComplete).toHaveBeenCalledTimes(1);
    });

    it('shows a retryable error for a server failure (500)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: 'Something went wrong while reading from the database.' }));
      render(<BusinessSearchForm />);
      fillRequired();

      clickRunSearch();
      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent("The search couldn't be completed");
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('clears a previous error when a new search starts', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'Bad configuration.' }));
      render(<BusinessSearchForm />);
      fillRequired();
      clickRunSearch();
      await screen.findByRole('alert');

      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeResponse()));
      clickRunSearch();

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      await screen.findByText('Search complete');
    });
  });
});
