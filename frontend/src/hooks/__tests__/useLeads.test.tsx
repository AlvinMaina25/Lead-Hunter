import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DemoDataProvider } from '../../lib/DemoDataContext';
import type { Lead } from '../../types';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, fetchLeads: vi.fn() };
});

import { fetchLeads } from '../../lib/api';
import { prefetchLeads, useLeads } from '../useData';

const mockFetchLeads = vi.mocked(fetchLeads);
const wrapper = ({ children }: { children: ReactNode }) => <DemoDataProvider>{children}</DemoDataProvider>;
const lead = (id: string) => ({ id, business_name: `Biz ${id}` }) as unknown as Lead;

describe('useLeads caching', () => {
  beforeEach(() => {
    mockFetchLeads.mockReset();
    window.localStorage.clear();
  });

  it('shows a loading state the first time, with no cached list', async () => {
    mockFetchLeads.mockResolvedValueOnce([lead('1')]);
    const { result } = renderHook(() => useLeads(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
  });

  it('shows the previous list immediately on a later visit, then refreshes it quietly', async () => {
    mockFetchLeads.mockResolvedValueOnce([lead('1')]);
    const first = renderHook(() => useLeads(), { wrapper });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    first.unmount();

    let resolveSecond: (leads: Lead[]) => void = () => {};
    mockFetchLeads.mockReturnValueOnce(new Promise<Lead[]>((resolve) => (resolveSecond = resolve)));
    const second = renderHook(() => useLeads(), { wrapper });

    // Instant: cached data, no loading spinner, while the refresh is still in flight.
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.data).toHaveLength(1);

    await act(async () => resolveSecond([lead('1'), lead('2')]));
    await waitFor(() => expect(second.result.current.data).toHaveLength(2));
  });

  it('prefetchLeads loads once and the page reuses that request instead of sending another', async () => {
    mockFetchLeads.mockResolvedValue([lead('1')]);
    prefetchLeads();
    const { result } = renderHook(() => useLeads(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchLeads).toHaveBeenCalledTimes(1);
  });

  it('refetch() always asks the server again', async () => {
    mockFetchLeads.mockResolvedValueOnce([lead('1')]);
    const { result } = renderHook(() => useLeads(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockFetchLeads.mockResolvedValueOnce([lead('1'), lead('2')]);
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(mockFetchLeads).toHaveBeenCalledTimes(2);
  });
});
