import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LeadsTable, hasAnyContact } from '../LeadsTable';
import type { Lead } from '../../../types';

function lead(id: string, name: string, flags: Partial<Lead> = {}): Lead {
  return {
    id,
    business_id: `biz-${id}`,
    lead_score: 50,
    priority: 'medium',
    lead_status: 'new',
    estimated_opportunity: null,
    sales_notes: null,
    scoring_factors: null,
    scored_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    business_name: name,
    business_category: 'Cafe',
    business_city: 'Nairobi',
    business_country: 'Kenya',
    recommended_service: null,
    ...flags,
  };
}

const LEADS: Lead[] = [
  lead('1', 'Alpha Email', { has_phone: true, has_email: true, has_social: false, has_whatsapp: false }),
  lead('2', 'Bravo PhoneOnly', { has_phone: true, has_email: false, has_social: false, has_whatsapp: false }),
  lead('3', 'Charlie SocialOnly', { has_phone: false, has_email: false, has_social: true, has_whatsapp: false }),
  lead('4', 'Delta Nothing', { has_phone: false, has_email: false, has_social: false, has_whatsapp: false }),
  lead('5', 'Echo Unknown'), // older server: no flags at all
];

function renderTable() {
  return render(
    <MemoryRouter>
      <LeadsTable leads={LEADS} isLoading={false} />
    </MemoryRouter>,
  );
}

const names = () => screen.queryAllByRole('link', { name: /Alpha|Bravo|Charlie|Delta|Echo/ }).map((a) => a.textContent);

describe('LeadsTable contact indicators', () => {
  it('shows labelled indicators per contact kind (text, not colour alone)', () => {
    renderTable();
    const alphaRow = screen.getByRole('link', { name: 'Alpha Email' }).closest('tr') as HTMLElement;
    expect(within(alphaRow).getByText('Has phone')).toBeInTheDocument();
    expect(within(alphaRow).getByText('Has email')).toBeInTheDocument();
    expect(within(alphaRow).queryByText('Has social profile')).not.toBeInTheDocument();

    const charlieRow = screen.getByRole('link', { name: 'Charlie SocialOnly' }).closest('tr') as HTMLElement;
    expect(within(charlieRow).getByText('Has social profile')).toBeInTheDocument();
  });

  it('distinguishes "no contact" from "flags not provided"', () => {
    renderTable();
    const deltaRow = screen.getByRole('link', { name: 'Delta Nothing' }).closest('tr') as HTMLElement;
    expect(within(deltaRow).getByText('None')).toBeInTheDocument();
    const echoRow = screen.getByRole('link', { name: 'Echo Unknown' }).closest('tr') as HTMLElement;
    expect(within(echoRow).queryByText('None')).not.toBeInTheDocument();
  });
});

describe('LeadsTable contact filter', () => {
  it('"Has email" keeps only leads with an email', () => {
    renderTable();
    fireEvent.change(screen.getByLabelText('Filter by contact info'), { target: { value: 'email' } });
    expect(names()).toEqual(['Alpha Email']);
  });

  it('"Has any contact" keeps leads with phone, email, social or WhatsApp -- not empty or unknown ones', () => {
    renderTable();
    fireEvent.change(screen.getByLabelText('Filter by contact info'), { target: { value: 'any' } });
    expect(names()).toEqual(['Alpha Email', 'Bravo PhoneOnly', 'Charlie SocialOnly']);
  });

  it('"Any contact info" (default) shows everyone', () => {
    renderTable();
    expect(names()).toHaveLength(5);
  });
});

describe('hasAnyContact', () => {
  it('is false when no flag is set or flags are missing', () => {
    expect(hasAnyContact(lead('x', 'X'))).toBe(false);
    expect(hasAnyContact(lead('x', 'X', { has_whatsapp: true }))).toBe(true);
  });
});
