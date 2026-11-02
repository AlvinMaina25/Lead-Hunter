import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LeadDetailPage } from '../LeadDetailPage';

function renderAtLead(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/leads/${id}`]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Phase 19 Part 2: once a lead loads, the page also requests
 * GET /api/leads/:id/intelligence. Tests that queue several
 * mockResolvedValueOnce responses in order would hand that extra
 * request the response meant for a later PATCH, so those tests route
 * responses by request instead. `intelligence` defaults to a valid
 * "nothing analyzed yet" payload, which these tests don't care about.
 */
const EMPTY_INTELLIGENCE = {
  lead_id: 'lead',
  business_id: 'business',
  has_analysis: false,
  verified_observations: [],
  ai_interpretation: [],
  service_match: null,
  relevance_summary: null,
  ai_model: null,
  analyzed_at: null,
};

interface MockRoute {
  ok: boolean;
  status: number;
  body: unknown;
}

function routeFetch(
  mockFetch: ReturnType<typeof vi.fn>,
  routes: { detail: unknown; write?: MockRoute; intelligence?: MockRoute },
) {
  mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/intelligence')) {
      const { ok, status, body } = routes.intelligence ?? { ok: true, status: 200, body: EMPTY_INTELLIGENCE };
      return { ok, status, json: async () => body } as Response;
    }
    if (init?.method === 'PATCH' && routes.write) {
      const { ok, status, body } = routes.write;
      return { ok, status, json: async () => body } as Response;
    }
    return { ok: true, status: 200, json: async () => routes.detail } as Response;
  });
}

describe('LeadDetailPage loading state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading indicator while GET /api/leads/:id is in flight', async () => {
    let resolveFetch: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending);

    renderAtLead('lead-123');

    expect(screen.getByText(/loading lead/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-123');

    resolveFetch({
      ok: true,
      json: async () => ({ lead: { id: 'lead-123' } }),
    } as Response);

    await waitFor(() => {
      expect(screen.queryByText(/loading lead/i)).not.toBeInTheDocument();
    });
  });

  it('removes the loading indicator when the request fails', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as Response);

    renderAtLead('lead-456');

    expect(screen.getByText(/loading lead/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(/loading lead/i)).not.toBeInTheDocument();
    });
  });
});

describe('LeadDetailPage error states', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an error state with the server message on an API error', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Something went wrong connecting to the database.' }),
    } as Response);

    renderAtLead('lead-500');

    await waitFor(() => {
      expect(screen.getByText(/couldn't load this lead/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Something went wrong connecting to the database.')).toBeInTheDocument();
    // No fabricated lead/business data should ever be rendered.
    expect(screen.queryByText(/lead-500/i)?.closest('h3')).not.toBeTruthy();
  });

  it('shows an error state when the network request itself fails', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAtLead('lead-network-fail');

    await waitFor(() => {
      expect(screen.getByText(/couldn't load this lead/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument();
  });

  it('shows a "Lead not found" state on a 404', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Lead not found.' }),
    } as Response);

    renderAtLead('missing-lead');

    await waitFor(() => {
      expect(screen.getByText(/lead not found/i)).toBeInTheDocument();
    });
    // The generic error copy should not also be shown for a 404.
    expect(screen.queryByText(/couldn't load this lead/i)).not.toBeInTheDocument();
  });

  it('shows an error state instead of crashing on an unexpected/invalid 200 response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'shape' }),
    } as Response);

    renderAtLead('lead-weird-shape');

    await waitFor(() => {
      expect(screen.getByText(/couldn't load this lead/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/unexpected response/i)).toBeInTheDocument();
  });

  it('shows an error state when the response body is not valid JSON', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    renderAtLead('lead-bad-json');

    await waitFor(() => {
      expect(screen.getByText(/couldn't load this lead/i)).toBeInTheDocument();
    });
  });
});

describe('LeadDetailPage ready state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fullDetail = {
    lead: {
      id: 'lead-full',
      business_id: 'biz-full',
      lead_score: 78,
      priority: 'high',
      lead_status: 'contacted',
      estimated_opportunity: 5000,
      sales_notes: 'Called once, follow up next week.',
      scoring_factors: [],
      scored_at: '2026-09-01T10:00:00Z',
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    business: {
      id: 'biz-full',
      external_place_id: 'place-1',
      name: 'Acme Bakery',
      category: 'Bakery',
      phone: '+254700000000',
      email: null,
      address: '123 Main St',
      city: 'Nairobi',
      country: 'Kenya',
      latitude: -1.2921,
      longitude: 36.8219,
      google_maps_url: 'https://maps.google.com/?cid=123',
      google_rating: '4.5',
      google_review_count: 87,
      website_url: 'https://acmebakery.example',
      website_status: 'reachable',
      website_checked_at: '2026-08-15T10:00:00Z',
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-01T10:00:00Z',
    },
    website_analysis: {
      id: 'wa-1',
      business_id: 'biz-full',
      analyzed_url: 'https://acmebakery.example',
      analyzed_at: '2026-08-20T10:00:00Z',
      performance_score: 62,
      accessibility_score: 91,
      seo_score: 80,
      best_practices_score: 75,
      mobile_indicator: 'responsive',
      https_enabled: true,
      page_title: 'Acme Bakery — Fresh Bread Daily',
      meta_description: 'The best bakery in Nairobi.',
      viewport_present: true,
      http_status: 200,
      response_time_ms: 340,
      analysis_status: 'completed',
      created_at: '2026-08-20T10:00:00Z',
    },
    ai_analysis: {
      id: 'ai-1',
      business_id: 'biz-full',
      summary: 'Outdated website with no online ordering.',
      problems: ['No online ordering', 'Slow mobile load time'],
      opportunities: ['Add e-commerce', 'Improve SEO'],
      recommended_service: 'Website redesign',
      reasoning: 'Site loses mobile customers due to slow load.',
      sales_angle: 'Lead with the mobile speed data.',
      confidence: 85,
      ai_model: 'gemini-1.5-pro',
      created_at: '2026-08-21T10:00:00Z',
    },
    scoring: {
      lead_score: 78,
      priority: 'high',
      scoring_factors: [],
      scored_at: '2026-09-01T10:00:00Z',
    },
    pipeline: {
      id: 'pipe-1',
      lead_id: 'lead-full',
      stage: 'contacted',
      contacted_at: '2026-09-02T10:00:00Z',
      response_at: null,
      meeting_at: null,
      proposal_at: null,
      won_at: null,
      lost_at: null,
      notes: null,
      created_at: '2026-09-02T10:00:00Z',
      updated_at: '2026-09-02T10:00:00Z',
    },
  };

  it('renders all five sections with real API data', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fullDetail,
    } as Response);

    renderAtLead('lead-full');

    await waitFor(() => {
      expect(screen.getByText('Acme Bakery')).toBeInTheDocument();
    });

    // Business information
    expect(screen.getByText('Bakery')).toBeInTheDocument();
    expect(screen.getByText(/123 Main St, Nairobi, Kenya/)).toBeInTheDocument();
    expect(screen.getByText('+254700000000')).toBeInTheDocument();
    expect(screen.getByText('4.5 ★')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();

    // Website analysis
    expect(screen.getByText('62/100')).toBeInTheDocument();
    expect(screen.getByText('91/100')).toBeInTheDocument();
    expect(screen.getByText('Acme Bakery — Fresh Bread Daily')).toBeInTheDocument();

    // AI analysis
    expect(screen.getByText('Outdated website with no online ordering.')).toBeInTheDocument();
    expect(screen.getByText('No online ordering')).toBeInTheDocument();
    expect(screen.getByText('Add e-commerce')).toBeInTheDocument();
    expect(screen.getByText('Website redesign')).toBeInTheDocument();
    expect(screen.getByText('Lead with the mobile speed data.')).toBeInTheDocument();

    // Lead information
    expect(screen.getByText('78/100')).toBeInTheDocument();
    // formatCurrency() uses Intl.NumberFormat(undefined, ...) -- the host
    // locale -- so USD renders as "$5,000" in en-US but "US$5,000" in
    // en-GB/en-KE/en-CA, "USD 5,000" in en-AU, etc. Assert the value in
    // its own field, formatted the way the app formats it, instead of
    // hard-coding one locale's output.
    const expectedOpportunity = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(fullDetail.lead.estimated_opportunity);
    const opportunityValue = screen.getByText('Estimated opportunity').parentElement?.querySelector('dd');
    expect(opportunityValue?.textContent).toBe(expectedOpportunity);
    expect(screen.getByDisplayValue('Called once, follow up next week.')).toBeInTheDocument();

    // Pipeline (editable stage selector)
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: /pipeline stage/i })).toHaveValue('contacted');
  });

  it('renders "—"/"N/A" placeholders instead of fake data when a lead has no website or AI analysis yet', async () => {
    const minimalDetail = {
      lead: {
        id: 'lead-min',
        business_id: 'biz-min',
        lead_score: null,
        priority: 'low',
        lead_status: 'new',
        estimated_opportunity: null,
        sales_notes: null,
        scoring_factors: null,
        scored_at: null,
        created_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-01T10:00:00Z',
      },
      business: {
        id: 'biz-min',
        external_place_id: null,
        name: 'Bare Shop',
        category: null,
        phone: null,
        email: null,
        address: null,
        city: null,
        country: null,
        latitude: null,
        longitude: null,
        google_maps_url: null,
        google_rating: null,
        google_review_count: null,
        website_url: null,
        website_status: 'no_website',
        website_checked_at: null,
        created_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-01T10:00:00Z',
      },
      website_analysis: null,
      ai_analysis: null,
      scoring: { lead_score: null, priority: 'low', scoring_factors: null, scored_at: null },
      pipeline: {
        id: null,
        lead_id: 'lead-min',
        stage: 'new',
        contacted_at: null,
        response_at: null,
        meeting_at: null,
        proposal_at: null,
        won_at: null,
        lost_at: null,
        notes: null,
        created_at: null,
        updated_at: null,
      },
    };

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => minimalDetail,
    } as Response);

    renderAtLead('lead-min');

    await waitFor(() => {
      expect(screen.getByText('Bare Shop')).toBeInTheDocument();
    });

    expect(screen.getByText(/no completed website analysis on file/i)).toBeInTheDocument();
    expect(screen.getByText(/no completed ai analysis on file/i)).toBeInTheDocument();
    // Sales notes / estimated opportunity fall back to a placeholder, never 0 or invented text.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// Phase 13B2: pipeline stage editing
// ---------------------------------------------------------------------

describe('LeadDetailPage pipeline stage editing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const detail = {
    lead: {
      id: 'lead-stage',
      business_id: 'biz-stage',
      lead_score: 40,
      priority: 'medium',
      lead_status: 'new',
      estimated_opportunity: null,
      sales_notes: null,
      scoring_factors: null,
      scored_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    business: {
      id: 'biz-stage',
      external_place_id: null,
      name: 'Stage Test Co',
      category: null,
      phone: null,
      email: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      google_rating: null,
      google_review_count: null,
      website_url: null,
      website_status: 'unknown',
      website_checked_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    website_analysis: null,
    ai_analysis: null,
    scoring: { lead_score: 40, priority: 'medium', scoring_factors: null, scored_at: null },
    pipeline: {
      id: null,
      lead_id: 'lead-stage',
      stage: 'new',
      contacted_at: null,
      response_at: null,
      meeting_at: null,
      proposal_at: null,
      won_at: null,
      lost_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
  };

  it('PATCHes /api/leads/:id/pipeline with the real lead ID and updates the displayed stage on success', async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    routeFetch(mockFetch, {
      detail,
      write: {
        ok: true,
        status: 200,
        body: { ...detail.pipeline, id: 'pipe-new', stage: 'contacted', updated_at: '2026-09-05T10:00:00Z' },
      },
    });

    renderAtLead('lead-stage');

    await waitFor(() => {
      expect(screen.getByText('Stage Test Co')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox', { name: /pipeline stage/i });
    fireEvent.change(select, { target: { value: 'contacted' } });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/leads/lead-stage/pipeline',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ stage: 'contacted' }),
        }),
      );
    });

    await waitFor(() => {
      expect(select).toHaveValue('contacted');
    });
  });

  it('keeps the previous stage displayed and shows an error when the pipeline PATCH fails', async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    routeFetch(mockFetch, {
      detail,
      write: { ok: false, status: 500, body: { error: 'Something went wrong while reading from the database.' } },
    });

    renderAtLead('lead-stage');

    await waitFor(() => {
      expect(screen.getByText('Stage Test Co')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox', { name: /pipeline stage/i });
    fireEvent.change(select, { target: { value: 'meeting' } });

    await waitFor(() => {
      expect(screen.getByText('Something went wrong while reading from the database.')).toBeInTheDocument();
    });

    // Stage reverts to what the backend last confirmed ('new'), never
    // left showing the failed optimistic value.
    expect(select).toHaveValue('new');
  });
});

// ---------------------------------------------------------------------
// Phase 13B2: sales notes editing
// ---------------------------------------------------------------------

describe('LeadDetailPage sales notes editing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const detail = {
    lead: {
      id: 'lead-notes',
      business_id: 'biz-notes',
      lead_score: 40,
      priority: 'medium',
      lead_status: 'new',
      estimated_opportunity: null,
      sales_notes: null,
      scoring_factors: null,
      scored_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    business: {
      id: 'biz-notes',
      external_place_id: null,
      name: 'Notes Test Co',
      category: null,
      phone: null,
      email: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      google_rating: null,
      google_review_count: null,
      website_url: null,
      website_status: 'unknown',
      website_checked_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    website_analysis: null,
    ai_analysis: null,
    scoring: { lead_score: 40, priority: 'medium', scoring_factors: null, scored_at: null },
    pipeline: {
      id: null,
      lead_id: 'lead-notes',
      stage: 'new',
      contacted_at: null,
      response_at: null,
      meeting_at: null,
      proposal_at: null,
      won_at: null,
      lost_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
  };

  it('saves notes via PATCH /api/leads/:id/notes with the real lead ID', async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    routeFetch(mockFetch, {
      detail,
      write: { ok: true, status: 200, body: { ...detail.lead, sales_notes: 'Spoke to owner, interested.' } },
    });

    renderAtLead('lead-notes');

    await waitFor(() => {
      expect(screen.getByText('Notes Test Co')).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText(/sales notes/i);
    fireEvent.change(textarea, { target: { value: 'Spoke to owner, interested.' } });

    const saveButton = screen.getByRole('button', { name: /save notes/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/leads/lead-notes/notes',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ sales_notes: 'Spoke to owner, interested.' }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
    });
  });

  it('shows an error and keeps the draft when the notes PATCH fails, and never saves fake notes without a save click', async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    routeFetch(mockFetch, {
      detail,
      write: { ok: false, status: 500, body: { error: 'Something went wrong while reading from the database.' } },
    });

    renderAtLead('lead-notes');

    await waitFor(() => {
      expect(screen.getByText('Notes Test Co')).toBeInTheDocument();
    });

    // No save click yet -- nothing must have been written. (Reads are fine:
    // the lead detail GET, plus the Phase 19 intelligence GET.)
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);

    const textarea = screen.getByLabelText(/sales notes/i);
    fireEvent.change(textarea, { target: { value: 'Draft that fails to save' } });
    fireEvent.click(screen.getByRole('button', { name: /save notes/i }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong while reading from the database.')).toBeInTheDocument();
    });

    // The failed draft is still shown (not discarded) so the user can retry.
    expect(textarea).toHaveValue('Draft that fails to save');
  });

  it('loads previously saved notes from GET /api/leads/:id on reload', async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...detail, lead: { ...detail.lead, sales_notes: 'Previously saved note.' } }),
    } as Response);

    renderAtLead('lead-notes');

    await waitFor(() => {
      expect(screen.getByDisplayValue('Previously saved note.')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------
// Phase 13 fix: TagList must render real object-shaped AI analysis
// findings ({ title, description, evidence }) without throwing
// "Objects are not valid as a React child".
// ---------------------------------------------------------------------

describe('LeadDetailPage AI analysis findings rendering', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const detailWithObjectFindings = {
    lead: {
      id: 'lead-findings',
      business_id: 'biz-findings',
      lead_score: 60,
      priority: 'medium',
      lead_status: 'new',
      estimated_opportunity: null,
      sales_notes: null,
      scoring_factors: null,
      scored_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    business: {
      id: 'biz-findings',
      external_place_id: null,
      name: 'Peter Amor Beauty Salons, Barber & SPA',
      category: 'Beauty salon',
      phone: null,
      email: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      google_rating: null,
      google_review_count: null,
      website_url: null,
      website_status: 'unknown',
      website_checked_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    website_analysis: null,
    // Real shape returned by server/lib/aiOpportunityAnalysis.js:
    // problems/opportunities are arrays of { title, description, evidence }
    // objects, not plain strings.
    ai_analysis: {
      id: 'ai-findings',
      business_id: 'biz-findings',
      summary: 'No website on file.',
      problems: [
        {
          title: 'No online presence',
          description: 'Business has no website listed in Google Places.',
          evidence: [{ field: 'website_url', value: false }],
        },
      ],
      opportunities: [
        {
          title: 'Build a booking-ready website',
          description: 'A simple site with online booking would capture missed calls.',
          evidence: [{ field: 'google_review_count', value: 42 }],
        },
      ],
      recommended_service: 'Website design',
      reasoning: 'No verified web presence.',
      sales_angle: 'Lead with visibility.',
      confidence: 70,
      ai_model: 'gemini-3.8-flash',
      created_at: '2026-08-21T10:00:00Z',
    },
    scoring: { lead_score: 60, priority: 'medium', scoring_factors: null, scored_at: null },
    pipeline: {
      id: null,
      lead_id: 'lead-findings',
      stage: 'new',
      contacted_at: null,
      response_at: null,
      meeting_at: null,
      proposal_at: null,
      won_at: null,
      lost_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
  };

  it('renders object-shaped problems/opportunities (title/description/evidence) without throwing', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => detailWithObjectFindings,
    } as Response);

    renderAtLead('lead-findings');

    await waitFor(() => {
      expect(screen.getByText('Peter Amor Beauty Salons, Barber & SPA')).toBeInTheDocument();
    });

    // No "Objects are not valid as a React child" crash -- the page
    // rendered past loading and the section is present.
    expect(screen.queryByText(/couldn't load this lead/i)).not.toBeInTheDocument();

    // Title and description fields render as readable text.
    expect(screen.getByText('No online presence')).toBeInTheDocument();
    expect(screen.getByText('Business has no website listed in Google Places.')).toBeInTheDocument();
    expect(screen.getByText('Build a booking-ready website')).toBeInTheDocument();
    expect(screen.getByText('A simple site with online booking would capture missed calls.')).toBeInTheDocument();

    // Evidence entries render as "field: value", not "[object Object]".
    expect(screen.getByText('website_url: false')).toBeInTheDocument();
    expect(screen.getByText('google_review_count: 42')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Phase 19 Part 2: Sales Intelligence on the lead page
// ---------------------------------------------------------------------

describe('LeadDetailPage Sales Intelligence', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

  const detail = {
    lead: {
      id: 'lead-intel',
      business_id: 'biz-intel',
      lead_score: 55,
      priority: 'medium',
      lead_status: 'new',
      estimated_opportunity: null,
      sales_notes: null,
      scoring_factors: null,
      scored_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    business: {
      id: 'biz-intel',
      external_place_id: null,
      name: 'Intel Test Co',
      category: null,
      phone: null,
      email: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      google_rating: null,
      google_review_count: null,
      website_url: null,
      website_status: 'unknown',
      website_checked_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    },
    website_analysis: null,
    ai_analysis: null,
    scoring: { lead_score: 55, priority: 'medium', scoring_factors: null, scored_at: null },
    pipeline: {
      id: null,
      lead_id: 'lead-intel',
      stage: 'new',
      contacted_at: null,
      response_at: null,
      meeting_at: null,
      proposal_at: null,
      won_at: null,
      lost_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
  };

  const intelligence = {
    lead_id: 'lead-intel',
    business_id: 'biz-intel',
    has_analysis: true,
    verified_observations: [
      { fact: 'Google rating is 4.2.', source: 'business_record' },
      { fact: 'Website uses HTTPS.', source: 'website_analyzer' },
    ],
    ai_interpretation: [
      {
        type: 'opportunity',
        interpretation: 'Booking gap: this may indicate an opportunity to add an online booking workflow.',
        service: 'whatsapp_integration',
        evidence: [{ field: 'business_has_website', value: true }],
      },
    ],
    service_match: { service: 'whatsapp_integration', reason: 'No booking mechanism was detected.', confidence: 'medium' },
    relevance_summary: 'Well-reviewed business with no visible booking flow.',
    ai_model: 'gemini-test-model',
    analyzed_at: '2026-09-01T10:00:00Z',
  };

  /** Asserts the rest of the lead page is intact, whatever happened to Sales Intelligence. */
  function expectRestOfPageWorking() {
    expect(screen.getByText('Intel Test Co')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Business information' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI analysis' })).toBeInTheDocument();
    expect(screen.getByLabelText(/sales notes/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /pipeline stage/i })).toHaveValue('new');
  }

  it('shows Sales Intelligence on the lead page, loaded from GET /api/leads/:id/intelligence', async () => {
    routeFetch(mockFetch(), { detail, intelligence: { ok: true, status: 200, body: intelligence } });

    renderAtLead('lead-intel');

    expect(await screen.findByRole('region', { name: 'Verified observations' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-intel');
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-intel/intelligence');

    const verified = within(screen.getByRole('region', { name: 'Verified observations' }));
    expect(verified.getByText('Google rating is 4.2.')).toBeInTheDocument();
    expect(verified.getByText('Website Analyzer')).toBeInTheDocument();

    const ai = within(screen.getByRole('region', { name: 'AI interpretation' }));
    expect(ai.getByText(/this may indicate an opportunity to add an online booking workflow/)).toBeInTheDocument();
    expect(verified.queryByText(/this may indicate an opportunity/)).not.toBeInTheDocument();

    const service = within(screen.getByRole('region', { name: 'Potential Alvin Solutions service' }));
    expect(service.getByText('WhatsApp Quote/Order/Booking Bot')).toBeInTheDocument();
    expect(service.getByText('Medium')).toBeInTheDocument();

    expectRestOfPageWorking();
  });

  it('does not wait for Sales Intelligence: the lead page renders while it is still loading', async () => {
    mockFetch().mockImplementation(async (url: unknown) =>
      String(url).endsWith('/intelligence')
        ? new Promise<Response>(() => {}) // never resolves
        : ({ ok: true, status: 200, json: async () => detail } as Response),
    );

    renderAtLead('lead-intel');

    await waitFor(() => expect(screen.getByText('Intel Test Co')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/loading sales intelligence/i);
    expectRestOfPageWorking();
  });

  it('keeps the whole page working when the intelligence API returns an error', async () => {
    routeFetch(mockFetch(), {
      detail,
      intelligence: { ok: false, status: 500, body: { error: 'Something went wrong connecting to the database.' } },
    });

    renderAtLead('lead-intel');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Sales intelligence couldn't be loaded.")).toBeInTheDocument();
    expect(within(alert).getByText('Something went wrong connecting to the database.')).toBeInTheDocument();
    // The lead itself is NOT reported as failing to load.
    expect(screen.queryByText(/couldn't load this lead/i)).not.toBeInTheDocument();
    expectRestOfPageWorking();
  });

  it('keeps the whole page working when the intelligence request cannot reach the server', async () => {
    mockFetch().mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/intelligence')) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => detail } as Response;
    });

    renderAtLead('lead-intel');

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expectRestOfPageWorking();
  });

  it('keeps the whole page working when the intelligence API returns a malformed 200', async () => {
    routeFetch(mockFetch(), { detail, intelligence: { ok: true, status: 200, body: { unexpected: 'shape' } } });

    renderAtLead('lead-intel');

    expect(await screen.findByText(/unexpected response/i)).toBeInTheDocument();
    expectRestOfPageWorking();
  });

  it('still renders an existing (pre-Phase-19) lead that has no intelligence, with a clean empty state', async () => {
    routeFetch(mockFetch(), {
      detail,
      intelligence: {
        ok: true,
        status: 200,
        body: {
          lead_id: 'lead-intel',
          business_id: 'biz-intel',
          has_analysis: false,
          verified_observations: [],
          ai_interpretation: [],
          service_match: null,
          relevance_summary: null,
          ai_model: null,
          analyzed_at: null,
        },
      },
    });

    const { container } = renderAtLead('lead-intel');

    expect(await screen.findByText('Sales intelligence is not available for this lead yet.')).toBeInTheDocument();
    expectRestOfPageWorking();
    expect(container.textContent).not.toMatch(/undefined|NaN|\[object/);
  });

  it('does not request Sales Intelligence at all when the lead itself fails to load', async () => {
    mockFetch().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Lead not found.' }) } as Response);

    renderAtLead('missing-lead');

    await waitFor(() => expect(screen.getByText(/lead not found/i)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Sales intelligence' })).not.toBeInTheDocument();
  });
});
