import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ExportLeadsButton } from '../ExportLeadsButton';

/**
 * Phase 22 Part 2: the button downloads the backend-generated CSV via
 * exportLeadsCsv() (lib/api.ts), which uses URL.createObjectURL /
 * document.createElement('a') to trigger the browser download. jsdom
 * doesn't implement createObjectURL/revokeObjectURL, so both are
 * stubbed here and asserted on directly.
 */
function stubObjectUrl() {
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

function csvResponse(ok = true, status = 200) {
  return {
    ok,
    status,
    blob: async () => new Blob(['id,name\n'], { type: 'text/csv' }),
    json: async () => ({ error: 'Export failed on the server.' }),
  } as unknown as Response;
}

/**
 * jsdom doesn't implement navigation and logs a noisy "Not implemented"
 * error whenever a real <a href="blob:..."> is clicked. Stubbing click()
 * on every anchor keeps these tests focused on what exportLeadsCsv()
 * actually does (create the anchor, set its href/download, click it,
 * remove it) without depending on real browser navigation.
 */
function stubAnchorClicks() {
  const originalCreateElement = document.createElement.bind(document);
  return vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag);
    if (tag === 'a') el.click = vi.fn();
    return el;
  });
}

describe('ExportLeadsButton', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    stubAnchorClicks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders with the accessible name "Export CSV"', () => {
    stubObjectUrl();
    render(<ExportLeadsButton />);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('requests GET /api/leads/export.csv when clicked', async () => {
    const { createObjectURL } = stubObjectUrl();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(csvResponse());

    render(<ExportLeadsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/api/leads/export.csv');
  });

  it('downloads the CSV as alvin-leads.csv via a temporary anchor, then cleans up the object URL', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(csvResponse());
    const createElementSpy = stubAnchorClicks();

    render(<ExportLeadsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const anchor = createElementSpy.mock.results.find((r) => (r.value as HTMLElement).tagName === 'A')
      ?.value as HTMLAnchorElement;
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('alvin-leads.csv');
    expect(anchor.href).toContain('blob:mock-url');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(document.body.contains(anchor)).toBe(false);
  });

  it('shows a loading state and disables the button while the export is in flight, then restores it', async () => {
    stubObjectUrl();
    let resolveFetch: (value: Response) => void = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<ExportLeadsButton />);
    const button = screen.getByRole('button', { name: 'Export CSV' });
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeDisabled();

    resolveFetch(csvResponse());

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBeDisabled());
  });

  it('ignores duplicate clicks while an export is already in flight', async () => {
    stubObjectUrl();
    let resolveFetch: (value: Response) => void = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<ExportLeadsButton />);
    const button = screen.getByRole('button', { name: 'Export CSV' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByRole('button', { name: 'Exporting…' });
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch(csvResponse());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument());
  });

  it('shows an error and restores the button on an HTTP error, without downloading a file', async () => {
    const { createObjectURL } = stubObjectUrl();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(csvResponse(false, 500));

    render(<ExportLeadsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText('Export failed on the server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBeDisabled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows a network-error message and restores the button on a network failure', async () => {
    const { createObjectURL } = stubObjectUrl();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    render(<ExportLeadsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBeDisabled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not generate any fake CSV data -- the downloaded blob comes directly from the fetch response', async () => {
    const { createObjectURL } = stubObjectUrl();
    const mockBlob = new Blob(['id,name\n1,Acme\n'], { type: 'text/csv' });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => mockBlob,
    } as unknown as Response);

    render(<ExportLeadsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledWith(mockBlob);
  });
});
