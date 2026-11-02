import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreNewBusinessesButton } from '../ScoreNewBusinessesButton';

/**
 * The button talks to two endpoints through lib/api.ts:
 *   GET  /api/businesses/unscored-count -> { unscored_count }
 *   POST /api/businesses/lead-score     -> { requested_limit, businesses_found, results }
 * fetch is stubbed per URL. Assertions look at the request path/body only
 * (fetchApi also adds options such as credentials, which aren't the point here).
 */
type Handler = () => Partial<Response> | Promise<Partial<Response>>;

function jsonResponse(body: unknown, ok = true, status = 200): Partial<Response> {
  return { ok, status, json: async () => body };
}

function stubFetch(handlers: { count: Handler[] | Handler; score?: Handler }) {
  const countQueue = Array.isArray(handlers.count) ? [...handlers.count] : null;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/api/businesses/unscored-count')) {
      const handler = countQueue ? (countQueue.length > 1 ? countQueue.shift()! : countQueue[0]) : (handlers.count as Handler);
      return handler();
    }
    if (url.includes('/api/businesses/lead-score')) {
      if (!handlers.score) throw new Error('unexpected lead-score call');
      return handlers.score();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const scoreCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/businesses/lead-score'));

const results = (oks: boolean[]) => ({
  requested_limit: 50,
  businesses_found: oks.length,
  results: oks.map((ok, i) => ({
    business_id: `biz-${i}`,
    ok,
    lead_score: ok ? 50 : null,
    priority: ok ? 'medium' : null,
  })),
});

describe('ScoreNewBusinessesButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the unscored count on the button', async () => {
    stubFetch({ count: () => jsonResponse({ unscored_count: 7 }) });
    render(<ScoreNewBusinessesButton />);

    expect(await screen.findByRole('button', { name: 'Score new businesses (7)' })).toBeEnabled();
  });

  it('is disabled when there is nothing to score, and never calls the scorer', async () => {
    const fetchMock = stubFetch({ count: () => jsonResponse({ unscored_count: 0 }) });
    render(<ScoreNewBusinessesButton />);

    const button = await screen.findByRole('button', { name: 'Score new businesses (0)' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(scoreCalls(fetchMock)).toHaveLength(0);
  });

  it('stays usable, without a number, when the count cannot be loaded', async () => {
    stubFetch({ count: () => jsonResponse({ error: 'nope' }, false, 500) });
    render(<ScoreNewBusinessesButton />);

    const button = await screen.findByRole('button', { name: 'Score new businesses' });
    expect(button).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a malformed count response as unknown, not as a number', async () => {
    stubFetch({ count: () => jsonResponse([{ id: 'lead-1' }]) });
    render(<ScoreNewBusinessesButton />);

    expect(await screen.findByRole('button', { name: 'Score new businesses' })).toBeEnabled();
  });

  it('scores only unscored businesses (capped at 50), shows scored/failed, refreshes the list and the count', async () => {
    let release!: (value: Partial<Response>) => void;
    const fetchMock = stubFetch({
      count: [() => jsonResponse({ unscored_count: 3 }), () => jsonResponse({ unscored_count: 1 })],
      score: () => new Promise((resolve) => { release = resolve; }),
    });
    const onScored = vi.fn();
    render(<ScoreNewBusinessesButton onScored={onScored} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Score new businesses (3)' }));

    // While running: disabled, busy, relabelled; extra clicks do nothing.
    const running = await screen.findByRole('button', { name: 'Scoring…' });
    expect(running).toBeDisabled();
    expect(running).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(running);
    expect(scoreCalls(fetchMock)).toHaveLength(1);

    const [, init] = scoreCalls(fetchMock)[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ only_unscored: true, limit: 50 });
    expect(onScored).not.toHaveBeenCalled();

    release(jsonResponse(results([true, true, false])));

    expect(await screen.findByRole('status')).toHaveTextContent('Scored 2 businesses, 1 failed.');
    expect(onScored).toHaveBeenCalledTimes(1);
    // Count refreshed to what is left (the failed one), and the button is usable again.
    expect(await screen.findByRole('button', { name: 'Score new businesses (1)' })).toBeEnabled();
  });

  it('reports a clean run without a failed clause', async () => {
    stubFetch({
      count: [() => jsonResponse({ unscored_count: 1 }), () => jsonResponse({ unscored_count: 0 })],
      score: () => jsonResponse(results([true])),
    });
    render(<ScoreNewBusinessesButton />);

    fireEvent.click(await screen.findByRole('button', { name: 'Score new businesses (1)' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/^Scored 1 business\.$/);
  });

  it('shows the backend error message, does not refresh, and re-enables the button when scoring fails', async () => {
    stubFetch({
      count: () => jsonResponse({ unscored_count: 4 }),
      score: () => jsonResponse({ error: '"limit" must be an integer between 1 and 50.' }, false, 400),
    });
    const onScored = vi.fn();
    render(<ScoreNewBusinessesButton onScored={onScored} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Score new businesses (4)' }));

    expect(await screen.findByText(/must be an integer between 1 and 50/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(onScored).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Score new businesses (4)' })).toBeEnabled());
  });
});
