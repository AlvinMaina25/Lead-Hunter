import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchAnalytics, fetchLeadDetail, fetchLeadIntelligence } from '../api';

describe('fetchLeadDetail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests GET /api/leads/:id using the given lead ID', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ lead: { id: 'lead-123' } }),
    } as Response);

    await fetchLeadDetail('lead-123');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-123');
  });

  it('builds the request path from whatever lead ID it is given', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ lead: { id: 'a-totally-different-id' } }),
    } as Response);

    await fetchLeadDetail('a-totally-different-id');

    expect(fetch).toHaveBeenCalledWith('/api/leads/a-totally-different-id');
  });

  it('returns the real backend response body, unmodified', async () => {
    const backendResponse = {
      lead: { id: 'lead-123', lead_status: 'new', priority: 'high' },
      business: { id: 'biz-1', name: 'Acme Co' },
      website_analysis: null,
      ai_analysis: null,
      scoring: null,
      pipeline: { stage: 'new' },
    };

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => backendResponse,
    } as Response);

    const result = await fetchLeadDetail('lead-123');

    expect(result).toEqual({ ok: true, detail: backendResponse });
  });
});

describe('fetchLeadIntelligence', () => {
  const validBody = {
    lead_id: 'lead-123',
    business_id: 'biz-1',
    has_analysis: true,
    verified_observations: [{ fact: 'Google rating is 4.2.', source: 'business_record' }],
    ai_interpretation: [],
    service_match: null,
    relevance_summary: null,
    ai_model: null,
    analyzed_at: null,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it('requests GET /api/leads/:id/intelligence using the given lead ID', async () => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => validBody } as Response);

    await fetchLeadIntelligence('lead-123');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-123/intelligence');
  });

  it('URL-encodes the lead ID so it can never alter the request path', async () => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => validBody } as Response);

    await fetchLeadIntelligence('a/b?c');

    expect(fetch).toHaveBeenCalledWith('/api/leads/a%2Fb%3Fc/intelligence');
  });

  it('returns the real backend response body, unmodified', async () => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => validBody } as Response);

    expect(await fetchLeadIntelligence('lead-123')).toEqual({ ok: true, intelligence: validBody });
  });

  it('accepts the payload the backend returns for a lead with no AI analysis yet', async () => {
    const notAnalyzed = { ...validBody, has_analysis: false };
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => notAnalyzed } as Response);

    expect(await fetchLeadIntelligence('lead-123')).toEqual({ ok: true, intelligence: notAnalyzed });
  });

  it('reports a 404 as notFound with the server message', async () => {
    mockFetch().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Lead not found.' }) } as Response);

    expect(await fetchLeadIntelligence('missing')).toEqual({
      ok: false,
      status: 404,
      notFound: true,
      error: 'Lead not found.',
    });
  });

  it('reports other HTTP errors with the server message, or a generic one if there is none', async () => {
    mockFetch().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Database is down.' }) } as Response);
    expect(await fetchLeadIntelligence('lead-123')).toMatchObject({ ok: false, status: 500, error: 'Database is down.' });

    mockFetch().mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as Response);
    expect(await fetchLeadIntelligence('lead-123')).toMatchObject({
      ok: false,
      status: 502,
      notFound: false,
      error: 'Request to /api/leads/lead-123/intelligence failed (502).',
    });
  });

  it('never throws on a network failure -- it reports it', async () => {
    mockFetch().mockRejectedValueOnce(new TypeError('Failed to fetch'));

    expect(await fetchLeadIntelligence('lead-123')).toEqual({
      ok: false,
      status: 0,
      notFound: false,
      error: 'Could not reach the server. Check your connection and try again.',
    });
  });

  it('never throws when the response body is not valid JSON', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    expect(await fetchLeadIntelligence('lead-123')).toMatchObject({ ok: false, status: 200 });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unrelated object', { unexpected: 'shape' }],
    ['a body missing the interpretation list', { verified_observations: [] }],
    ['a body whose lists are not arrays', { verified_observations: 'x', ai_interpretation: 'y', service_match: null }],
    ['a body whose service_match is a string', { verified_observations: [], ai_interpretation: [], service_match: 'x' }],
  ])('treats %s as an unexpected response instead of trusting it', async (_label, body) => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => body } as Response);

    expect(await fetchLeadIntelligence('lead-123')).toEqual({
      ok: false,
      status: 200,
      notFound: false,
      error: 'The server returned an unexpected response.',
    });
  });
});

describe('fetchAnalytics', () => {
  const validBody = {
    metrics: {
      businesses_discovered: 43,
      no_website_businesses: 12,
      poor_website_businesses: 0,
      high_priority_leads: 0,
      contacted_leads: 1,
      responses: 0,
      meetings: 0,
      proposals: 0,
      won_deals: 0,
    },
    lead_priority_breakdown: { medium: 7, low: 7 },
    pipeline_stage_breakdown: { researched: 3, contacted: 1, new: 10 },
    website_status_breakdown: { unreachable: 13, unknown: 14, reachable: 4, no_website: 12 },
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests GET /api/analytics', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validBody,
    } as Response);

    await fetchAnalytics();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/analytics');
  });

  it('returns the real backend response body, unmodified', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validBody,
    } as Response);

    const result = await fetchAnalytics();

    expect(result).toEqual(validBody);
  });

  it('rejects with the backend error message on an HTTP error response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database unavailable' }),
    } as Response);

    await expect(fetchAnalytics()).rejects.toThrow('Database unavailable');
  });

  it('rejects with a generic message on an HTTP error with no JSON body', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async (): Promise<unknown> => {
        throw new Error('not json');
      },
    } as Response);

    await expect(fetchAnalytics()).rejects.toThrow('/api/analytics');
  });

  it('rejects on a network failure', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchAnalytics()).rejects.toThrow();
  });

  it('rejects when the 200 response body is missing the metrics object', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ lead_priority_breakdown: {}, pipeline_stage_breakdown: {}, website_status_breakdown: {} }),
    } as Response);

    await expect(fetchAnalytics()).rejects.toThrow('unexpected analytics response');
  });

  it('rejects when a metrics field has the wrong type', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...validBody, metrics: { ...validBody.metrics, businesses_discovered: '43' } }),
    } as Response);

    await expect(fetchAnalytics()).rejects.toThrow('unexpected analytics response');
  });

  it('accepts empty breakdown objects (a valid empty-database response)', async () => {
    const emptyBody = {
      metrics: {
        businesses_discovered: 0,
        no_website_businesses: 0,
        poor_website_businesses: 0,
        high_priority_leads: 0,
        contacted_leads: 0,
        responses: 0,
        meetings: 0,
        proposals: 0,
        won_deals: 0,
      },
      lead_priority_breakdown: {},
      pipeline_stage_breakdown: {},
      website_status_breakdown: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => emptyBody,
    } as Response);

    await expect(fetchAnalytics()).resolves.toEqual(emptyBody);
  });
});
