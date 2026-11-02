import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AnalyticsPage } from '../AnalyticsPage';

const FULL_BODY = {
  metrics: {
    businesses_discovered: 43,
    no_website_businesses: 12,
    poor_website_businesses: 5,
    high_priority_leads: 3,
    contacted_leads: 1,
    responses: 2,
    meetings: 4,
    proposals: 6,
    won_deals: 7,
  },
  lead_priority_breakdown: { medium: 7, low: 7 },
  pipeline_stage_breakdown: { researched: 3, contacted: 1, new: 10 },
  website_status_breakdown: { unreachable: 13, unknown: 14, reachable: 4, no_website: 12 },
};

const EMPTY_BODY = {
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

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

/**
 * A MetricCard renders its label and value as adjacent <p> siblings
 * under one wrapper div. Reading the value via the label's sibling
 * (rather than a global getByText(value)) keeps each assertion scoped
 * to its own card, since several metric values/labels legitimately
 * repeat elsewhere on the page (e.g. "No Website" is both a metric
 * label and a website-status breakdown label; "1" and "3" appear in
 * more than one card/breakdown row). `container` further scopes the
 * label lookup itself to the nine-metric grid, since a label like
 * "No Website" is unique there but not page-wide.
 */
function expectMetricValue(container: HTMLElement, label: string, value: number) {
  const labelEl = within(container).getByText(label);
  expect(labelEl.nextElementSibling).toHaveTextContent(String(value));
}

function getMetricsGrid(): HTMLElement {
  return screen.getByText('Businesses Discovered').closest('div[class*="grid-cols-2"]') as HTMLElement;
}

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the page heading', async () => {
    mockFetchOnce(FULL_BODY);
    render(<AnalyticsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());
  });

  it('shows a loading state that preserves the page structure, without flashing zero values', async () => {
    let resolveFetch: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending);

    render(<AnalyticsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
    // Nine metric cards worth of skeleton placeholders, no numeric values yet.
    expect(screen.queryByText('43')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    resolveFetch({ ok: true, status: 200, json: async () => FULL_BODY } as Response);
    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());
  });

  it('renders all nine primary metrics with their API values', async () => {
    mockFetchOnce(FULL_BODY);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());
    const grid = getMetricsGrid();

    expectMetricValue(grid, 'Businesses Discovered', 43);
    expectMetricValue(grid, 'No Website', 12);
    expectMetricValue(grid, 'Poor Websites', 5);
    expectMetricValue(grid, 'High-Priority Leads', 3);
    expectMetricValue(grid, 'Contacted', 1);
    expectMetricValue(grid, 'Responses', 2);
    expectMetricValue(grid, 'Meetings', 4);
    expectMetricValue(grid, 'Proposals', 6);
    expectMetricValue(grid, 'Won Deals', 7);
  });

  it('renders the website status, lead priority, and pipeline stage breakdowns', async () => {
    mockFetchOnce(FULL_BODY);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());

    const websitePanel = screen.getByRole('heading', { name: 'Website Status' }).closest('div')!;
    expect(within(websitePanel).getByText('Unreachable')).toBeInTheDocument();
    expect(within(websitePanel).getByText('13')).toBeInTheDocument();
    expect(within(websitePanel).getByText('Unknown')).toBeInTheDocument();
    expect(within(websitePanel).getByText('Reachable')).toBeInTheDocument();
    expect(within(websitePanel).getByText('No Website')).toBeInTheDocument();

    const priorityPanel = screen.getByRole('heading', { name: 'Lead Priority' }).closest('div')!;
    expect(within(priorityPanel).getByText('Medium')).toBeInTheDocument();
    expect(within(priorityPanel).getByText('Low')).toBeInTheDocument();
    expect(within(priorityPanel).queryByText(/urgent/i)).not.toBeInTheDocument();

    const stagePanel = screen.getByRole('heading', { name: 'Pipeline Stage' }).closest('div')!;
    expect(within(stagePanel).getByText('Researched')).toBeInTheDocument();
    expect(within(stagePanel).getByText('New')).toBeInTheDocument();
  });

  it('renders an unrecognized breakdown key with a formatted fallback label instead of hiding it', async () => {
    mockFetchOnce({
      ...FULL_BODY,
      website_status_breakdown: { ...FULL_BODY.website_status_breakdown, some_new_status: 9 },
    });
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('Some New Status')).toBeInTheDocument());
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('shows an error state with a Try again button on request failure, without falling back to zero metrics', async () => {
    mockFetchOnce({ error: 'Database unavailable' }, false, 500);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('Unable to load analytics.')).toBeInTheDocument());
    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Businesses Discovered')).not.toBeInTheDocument();

    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    mockFetchOnce(FULL_BODY);
    fireEvent.click(tryAgain);

    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows an error state on a network failure', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('Unable to load analytics.')).toBeInTheDocument());
  });

  it('renders zero/empty analytics data normally, without crashing or treating it as an error', async () => {
    mockFetchOnce(EMPTY_BODY);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('Businesses Discovered')).toBeInTheDocument());
    expect(screen.queryByText('Unable to load analytics.')).not.toBeInTheDocument();
    expect(screen.getByText('No website status data yet.')).toBeInTheDocument();
    expect(screen.getByText('No lead priority data yet.')).toBeInTheDocument();
    expect(screen.getByText('No pipeline stage data yet.')).toBeInTheDocument();
  });

  it('refreshes analytics when the Refresh button is clicked', async () => {
    mockFetchOnce(FULL_BODY);
    render(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());

    const updatedBody = { ...FULL_BODY, metrics: { ...FULL_BODY.metrics, businesses_discovered: 99 } };
    mockFetchOnce(updatedBody);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.getByText('99')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never displays demo/fake data, regardless of API values', async () => {
    mockFetchOnce(FULL_BODY);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('43')).toBeInTheDocument());
    expect(screen.queryByText(/demo data is on/i)).not.toBeInTheDocument();
  });
});
