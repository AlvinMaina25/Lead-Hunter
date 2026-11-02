import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, runBusinessSearch } from '../api';
import type { RunSearchInput } from '../../types';

const CONFIG: RunSearchInput = {
  category: 'barber',
  location: 'Nairobi',
  keyword: 'barbershop',
  radius_meters: 5000,
  max_results: 10,
  analysis_options: { website_analysis: true, ai_analysis: false },
};

function mockResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to reject');
}

describe('runBusinessSearch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the configuration as JSON to the existing /api/searches endpoint', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse(200, { search: {}, businesses: [], summary: {} }));

    await runBusinessSearch(CONFIG);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CONFIG),
    });
  });

  it('returns the backend response body unmodified', async () => {
    const body = {
      search: { id: 's1', status: 'completed' },
      businesses: [],
      summary: { places_returned: 3, excluded_outside_radius: 3, results_count: 0 },
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse(200, body));

    await expect(runBusinessSearch(CONFIG)).resolves.toEqual(body);
  });

  it.each([
    [400, '"max_results" must be between 1 and 20.'],
    [422, 'Could not find map coordinates for "Xyzzy", so the search radius cannot be applied.'],
    [503, 'Google Places integration is not configured. Set GOOGLE_PLACES_API_KEY on the server and restart.'],
    [502, 'Google Places API key is missing or invalid.'],
  ])('rejects %i with an ApiError carrying the backend message', async (status, message) => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse(status, { error: message }));

    const err = await rejection(runBusinessSearch(CONFIG));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    expect(err.searchId).toBeUndefined();
  });

  it('carries the searchId the backend recorded for a failed search', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse(422, { error: 'Radius could not be applied.', searchId: 'search-42' }),
    );

    const err = await rejection(runBusinessSearch(CONFIG));

    expect(err.status).toBe(422);
    expect(err.searchId).toBe('search-42');
  });

  it('falls back to a generic message only when the error body is not usable', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    const err = await rejection(runBusinessSearch(CONFIG));

    expect(err.status).toBe(500);
    expect(err.message).toBe('Request to /api/searches failed (500).');
  });

  it('turns a network failure into an ApiError with status 0 and a friendly message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await rejection(runBusinessSearch(CONFIG));

    expect(err.status).toBe(0);
    expect(err.message).toBe('Could not reach the server. Check your connection and try again.');
  });
});
