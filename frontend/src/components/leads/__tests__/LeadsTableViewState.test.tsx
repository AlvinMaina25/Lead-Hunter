import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LeadsTable } from '../LeadsTable';
import type { Lead } from '../../../types';

function lead(i: number): Lead {
  return {
    id: `l${i}`,
    business_id: `biz-${i}`,
    lead_score: 50,
    priority: 'medium',
    lead_status: 'new',
    estimated_opportunity: null,
    sales_notes: null,
    scoring_factors: null,
    scored_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    business_name: `Business ${i}`,
    business_category: 'Cafe',
    business_city: 'Nairobi',
    business_country: 'Kenya',
    recommended_service: null,
  };
}

const LEADS = Array.from({ length: 35 }, (_, i) => lead(i + 1)); // 4 pages of 10

function mount() {
  return render(
    <MemoryRouter>
      <LeadsTable leads={LEADS} isLoading={false} />
    </MemoryRouter>,
  );
}

describe('LeadsTable remembers its page', () => {
  it('returns to the same page after the table is unmounted and mounted again', () => {
    const first = mount();
    fireEvent.click(screen.getByLabelText('Next page'));
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(screen.getByText(/Page 3 of 4/)).toBeInTheDocument();

    // Opening a lead unmounts the Leads page; "Back" mounts it again.
    first.unmount();
    mount();
    expect(screen.getByText(/Page 3 of 4/)).toBeInTheDocument();
  });

  it('does not remember the page while the leads are still loading', () => {
    const first = mount();
    fireEvent.click(screen.getByLabelText('Next page'));
    first.unmount();

    const loading = render(
      <MemoryRouter>
        <LeadsTable leads={[]} isLoading />
      </MemoryRouter>,
    );
    loading.unmount();

    mount();
    expect(screen.getByText(/Page 2 of 4/)).toBeInTheDocument();
  });
});
