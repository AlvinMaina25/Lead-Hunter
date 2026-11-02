import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SalesIntelligenceErrorBoundary,
  SalesIntelligenceSection,
  SalesIntelligenceView,
  formatServiceName,
} from '../SalesIntelligencePanel';
import type { SalesIntelligenceResponse } from '../../../types';

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const AI_INTERPRETATION_TEXT =
  'Booking gap: Based on the available evidence, this may indicate an opportunity to add an online booking workflow.';

const fullIntelligence: SalesIntelligenceResponse = {
  lead_id: 'lead-1',
  business_id: 'biz-1',
  has_analysis: true,
  verified_observations: [
    { fact: 'Google rating is 4.2.', source: 'business_record' },
    { fact: 'Google review count is 137.', source: 'business_record' },
    { fact: 'Business has a website on file.', source: 'business_record' },
    { fact: 'Website status is "reachable".', source: 'business_record' },
    { fact: 'Website uses HTTPS.', source: 'website_analyzer' },
    { fact: 'PageSpeed performance score is 62/100.', source: 'website_analyzer' },
  ],
  ai_interpretation: [
    {
      type: 'opportunity',
      interpretation: AI_INTERPRETATION_TEXT,
      service: 'whatsapp_integration',
      evidence: [{ field: 'business_google_review_count', value: 137 }],
    },
    {
      type: 'problem',
      interpretation: 'Slow site: The website may load slowly on mobile.',
      service: null,
      evidence: [{ field: 'analysis_performance_score', value: 62 }],
    },
  ],
  service_match: {
    service: 'whatsapp_integration',
    reason: 'No booking mechanism was detected.',
    confidence: 'medium',
  },
  relevance_summary: 'Well-reviewed business whose website shows no booking flow.',
  ai_model: 'gemini-test-model',
  analyzed_at: '2026-09-01T10:00:00Z',
};

/** What GET /api/leads/:id/intelligence returns for a lead that predates Phase 19 / was never AI-analyzed. */
const notAnalyzedIntelligence: SalesIntelligenceResponse = {
  lead_id: 'lead-old',
  business_id: 'biz-old',
  has_analysis: false,
  verified_observations: [
    { fact: 'Business name is "Old Shop".', source: 'business_record' },
    { fact: 'No phone number is on file.', source: 'business_record' },
  ],
  ai_interpretation: [],
  service_match: null,
  relevance_summary: null,
  ai_model: null,
  analyzed_at: null,
};

function verifiedRegion() {
  return screen.getByRole('region', { name: 'Verified observations' });
}
function aiRegion() {
  return screen.getByRole('region', { name: 'AI interpretation' });
}
function serviceRegion() {
  return screen.getByRole('region', { name: 'Potential Alvin Solutions service' });
}

// ---------------------------------------------------------------------
// Presentational view
// ---------------------------------------------------------------------

describe('SalesIntelligenceView', () => {
  it('renders the Sales Intelligence content: relevance, verified, AI interpretation and service match', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);

    expect(
      within(screen.getByRole('region', { name: 'Why this lead may be relevant' })).getByText(
        'Well-reviewed business whose website shows no booking flow.',
      ),
    ).toBeInTheDocument();
    expect(verifiedRegion()).toBeInTheDocument();
    expect(aiRegion()).toBeInTheDocument();
    expect(serviceRegion()).toBeInTheDocument();
  });

  it('shows verified observations, with their source, in the verified section', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);

    const verified = within(verifiedRegion());
    for (const o of fullIntelligence.verified_observations) {
      expect(verified.getByText(o.fact)).toBeInTheDocument();
    }
    expect(verified.getAllByText('Database')).toHaveLength(4);
    expect(verified.getAllByText('Website Analyzer')).toHaveLength(2);
    expect(verified.getByText('Verified')).toBeInTheDocument();
  });

  it('shows the AI interpretation in its own, clearly AI-labelled section', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);

    const ai = within(aiRegion());
    expect(ai.getByText(AI_INTERPRETATION_TEXT)).toBeInTheDocument();
    expect(ai.getByText('Possible opportunity')).toBeInTheDocument();
    expect(ai.getByText('Possible problem')).toBeInTheDocument();
    expect(ai.getByText('AI-generated')).toBeInTheDocument();
    expect(ai.getByText(/hypothesis, not a verified fact/i)).toBeInTheDocument();
    // Evidence the AI cited stays traceable, but is labelled as what the AI was "based on".
    expect(ai.getByText(/Based on: business google review count: 137/)).toBeInTheDocument();
  });

  it('shows the service match separately, with a friendly service name, reason and confidence', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);

    const service = within(serviceRegion());
    expect(service.getByText('WhatsApp Quote/Order/Booking Bot')).toBeInTheDocument();
    expect(service.getByText('No booking mechanism was detected.')).toBeInTheDocument();
    expect(service.getByText(/^Why:/)).toBeInTheDocument();
    expect(service.getByText('Confidence:')).toBeInTheDocument();
    expect(service.getByText('Medium')).toBeInTheDocument();
    expect(service.getByText('AI-generated')).toBeInTheDocument();
  });

  it.each([
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ] as const)('renders %s confidence as "%s"', (bucket, label) => {
    render(
      <SalesIntelligenceView
        data={{ ...fullIntelligence, service_match: { ...fullIntelligence.service_match!, confidence: bucket } }}
      />,
    );
    expect(within(serviceRegion()).getByText(label)).toBeInTheDocument();
  });

  it('says confidence is unavailable, rather than inventing one, when the match has none', () => {
    render(
      <SalesIntelligenceView
        data={{ ...fullIntelligence, service_match: { ...fullIntelligence.service_match!, confidence: null } }}
      />,
    );
    const service = within(serviceRegion());
    expect(service.getByText('Confidence not available')).toBeInTheDocument();
    expect(service.queryByText('Confidence:')).not.toBeInTheDocument();
  });

  it('renders "No clear service match" with an explanation, and no forced recommendation', () => {
    render(
      <SalesIntelligenceView
        data={{
          ...fullIntelligence,
          service_match: { service: null, reason: 'The verified evidence does not clearly support one.', confidence: 'low' },
        }}
      />,
    );

    const service = within(serviceRegion());
    expect(service.getByText('No clear service match')).toBeInTheDocument();
    expect(
      service.getByText(
        'Available evidence is insufficient to identify a specific Alvin Solutions service opportunity.',
      ),
    ).toBeInTheDocument();
    // No service name, no "Why:", no confidence badge is fabricated for a non-match.
    expect(service.queryByText(/^Why:/)).not.toBeInTheDocument();
    expect(service.queryByText('Confidence:')).not.toBeInTheDocument();
    expect(service.queryByText('Low')).not.toBeInTheDocument();
  });

  it('renders a null service_match honestly for a lead that was never AI-analyzed', () => {
    render(<SalesIntelligenceView data={notAnalyzedIntelligence} />);

    const service = within(serviceRegion());
    expect(service.getByText('No clear service match')).toBeInTheDocument();
    expect(service.getByText(/no ai analysis has been completed for this lead yet/i)).toBeInTheDocument();
    // Must not claim the evidence was assessed and found insufficient.
    expect(service.queryByText(/evidence is insufficient/i)).not.toBeInTheDocument();
  });

  it('renders an empty state when there is nothing at all to show', () => {
    render(
      <SalesIntelligenceView
        data={{
          ...notAnalyzedIntelligence,
          verified_observations: [],
        }}
      />,
    );

    expect(screen.getByText('Sales intelligence is not available for this lead yet.')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('renders per-section empty states for missing observations / interpretation without hiding the rest', () => {
    render(
      <SalesIntelligenceView
        data={{ ...fullIntelligence, verified_observations: [], ai_interpretation: [] }}
      />,
    );

    expect(within(verifiedRegion()).getByText('No verified observations are available for this lead.')).toBeInTheDocument();
    expect(
      within(aiRegion()).getByText('The AI analysis did not identify any specific problems or opportunities.'),
    ).toBeInTheDocument();
    // The service match is still shown.
    expect(within(serviceRegion()).getByText('WhatsApp Quote/Order/Booking Bot')).toBeInTheDocument();
  });

  it('renders a pre-Phase-19 lead (no AI analysis) cleanly: verified facts shown, AI sections say so, nothing undefined', () => {
    const { container } = render(<SalesIntelligenceView data={notAnalyzedIntelligence} />);

    expect(within(verifiedRegion()).getByText('Business name is "Old Shop".')).toBeInTheDocument();
    expect(within(aiRegion()).getByText('No AI interpretation is available for this lead yet.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Why this lead may be relevant' })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('never renders undefined/null/NaN even when optional fields are missing or malformed', () => {
    const sloppy = {
      lead_id: 'lead-x',
      business_id: 'biz-x',
      has_analysis: true,
      verified_observations: [{ fact: 'Website uses HTTPS.', source: 'business_record' }, { source: 'website_analyzer' }, null],
      ai_interpretation: [
        { type: 'opportunity', interpretation: 'Something plausible.', evidence: 'not-an-array' },
        { type: 'problem' },
        null,
      ],
      service_match: { service: 42, reason: null, confidence: 'certain' },
    } as unknown as SalesIntelligenceResponse;

    const { container } = render(<SalesIntelligenceView data={sloppy} />);

    expect(within(verifiedRegion()).getByText('Website uses HTTPS.')).toBeInTheDocument();
    expect(within(aiRegion()).getByText('Something plausible.')).toBeInTheDocument();
    expect(within(serviceRegion()).getByText('No clear service match')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|null|NaN|\[object/);
  });

  it('never displays AI content inside the verified-observation section', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);

    const verified = within(verifiedRegion());
    const aiTexts = [
      AI_INTERPRETATION_TEXT,
      'Slow site: The website may load slowly on mobile.',
      'Well-reviewed business whose website shows no booking flow.',
      'No booking mechanism was detected.',
      'WhatsApp Quote/Order/Booking Bot',
      'AI-generated',
      /confidence/i,
      /possible (problem|opportunity)/i,
    ];
    for (const text of aiTexts) {
      expect(verified.queryByText(text)).not.toBeInTheDocument();
    }

    // The verified list contains exactly the verified observations -- no more, no fewer.
    expect(verified.getAllByRole('listitem')).toHaveLength(fullIntelligence.verified_observations.length);
  });

  it('never shows the AI as a source, and drops unrecognised sources instead of echoing them', () => {
    render(
      <SalesIntelligenceView
        data={{
          ...fullIntelligence,
          verified_observations: [
            { fact: 'Google rating is 4.2.', source: 'business_record' },
            { fact: 'Some other fact.', source: 'ai_inference' as unknown as 'business_record' },
          ],
        }}
      />,
    );

    const verified = within(verifiedRegion());
    expect(verified.getByText('Some other fact.')).toBeInTheDocument();
    expect(verified.queryByText(/ai_inference|ai inference/i)).not.toBeInTheDocument();
    expect(verified.getAllByText('Database')).toHaveLength(1);
  });

  it('keeps a long list compact: shows the first few observations and lets the user expand', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      fact: `Observation number ${i + 1}.`,
      source: 'business_record' as const,
    }));
    render(<SalesIntelligenceView data={{ ...fullIntelligence, verified_observations: many }} />);

    const verified = within(verifiedRegion());
    expect(verified.getAllByRole('listitem')).toHaveLength(8);
    expect(verified.queryByText('Observation number 12.')).not.toBeInTheDocument();

    fireEvent.click(verified.getByRole('button', { name: 'Show all 12 observations' }));
    expect(verified.getAllByRole('listitem')).toHaveLength(12);
    expect(verified.getByText('Observation number 12.')).toBeInTheDocument();

    fireEvent.click(verified.getByRole('button', { name: 'Show fewer' }));
    expect(verified.getAllByRole('listitem')).toHaveLength(8);
  });

  it('does not show an expand toggle for a short list', () => {
    render(<SalesIntelligenceView data={fullIntelligence} />);
    expect(within(verifiedRegion()).queryByRole('button')).not.toBeInTheDocument();
  });

  it('credits the AI model that produced the AI content, and only when there is an analysis', () => {
    const { rerender } = render(<SalesIntelligenceView data={fullIntelligence} />);
    expect(screen.getByText(/AI content generated by gemini-test-model/)).toBeInTheDocument();

    rerender(<SalesIntelligenceView data={notAnalyzedIntelligence} />);
    expect(screen.queryByText(/AI content generated/)).not.toBeInTheDocument();
  });
});

describe('formatServiceName', () => {
  it('maps every backend service identifier to a friendly name', () => {
    expect(formatServiceName('new_website')).toBe('Business Website');
    expect(formatServiceName('digital_business_card')).toBe('Digital Business Card');
    expect(formatServiceName('qr_menu_order_system')).toBe('QR Menu / Ordering System');
    expect(formatServiceName('whatsapp_integration')).toBe('WhatsApp Quote/Order/Booking Bot');
    expect(formatServiceName('ai_customer_service_chatbot')).toBe('AI Customer Support Chatbot');
  });

  it('title-cases an identifier it does not know, and leaves human-readable text alone', () => {
    expect(formatServiceName('brand_new_thing')).toBe('Brand New Thing');
    expect(formatServiceName('Website redesign')).toBe('Website redesign');
    // Inherited object keys must never be mistaken for a service.
    expect(formatServiceName('constructor')).toBe('constructor');
  });
});

// ---------------------------------------------------------------------
// Container: request, loading, error, isolation
// ---------------------------------------------------------------------

describe('SalesIntelligenceSection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it('requests GET /api/leads/:id/intelligence and renders the response', async () => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => fullIntelligence } as Response);

    render(<SalesIntelligenceSection leadId="lead-1" />);

    expect(await screen.findByText('Google rating is 4.2.')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/leads/lead-1/intelligence');
    expect(screen.getByRole('heading', { name: 'Sales intelligence' })).toBeInTheDocument();
  });

  it('shows a loading state, and no data, while the request is in flight', async () => {
    let resolveFetch: (res: Response) => void = () => {};
    mockFetch().mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFetch = resolve)));

    render(<SalesIntelligenceSection leadId="lead-1" />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading sales intelligence/i);
    expect(screen.queryByRole('region', { name: 'Verified observations' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not available for this lead/i)).not.toBeInTheDocument();

    resolveFetch({ ok: true, status: 200, json: async () => fullIntelligence } as Response);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(verifiedRegion()).toBeInTheDocument();
  });

  it('shows the empty state for a lead with no intelligence yet', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...notAnalyzedIntelligence, verified_observations: [] }),
    } as Response);

    render(<SalesIntelligenceSection leadId="lead-old" />);

    expect(await screen.findByText('Sales intelligence is not available for this lead yet.')).toBeInTheDocument();
  });

  it('shows an error state with the server message when the API fails, and no fabricated data', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Something went wrong connecting to the database.' }),
    } as Response);

    render(<SalesIntelligenceSection leadId="lead-1" />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Sales intelligence couldn't be loaded.")).toBeInTheDocument();
    expect(within(alert).getByText('Something went wrong connecting to the database.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Verified observations' })).not.toBeInTheDocument();
  });

  it('shows an error state when the network request itself fails', async () => {
    mockFetch().mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<SalesIntelligenceSection leadId="lead-1" />);

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
  });

  it('shows an error state for an unexpected 200 body instead of rendering it', async () => {
    mockFetch().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ unexpected: 'shape' }) } as Response);

    render(<SalesIntelligenceSection leadId="lead-1" />);

    expect(await screen.findByText(/unexpected response/i)).toBeInTheDocument();
  });

  it('lets the user retry after a failure', async () => {
    mockFetch()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Temporary failure.' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fullIntelligence } as Response);

    render(<SalesIntelligenceSection leadId="lead-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Google rating is 4.2.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('SalesIntelligenceErrorBoundary', () => {
  it('replaces only the panel with an error message if rendering throws, leaving siblings alone', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): ReactElement {
      throw new Error('render failure');
    }

    render(
      <div>
        <p>Rest of the page</p>
        <SalesIntelligenceErrorBoundary>
          <Boom />
        </SalesIntelligenceErrorBoundary>
      </div>,
    );

    expect(screen.getByText('Rest of the page')).toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByText("Sales intelligence couldn't be loaded.")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
