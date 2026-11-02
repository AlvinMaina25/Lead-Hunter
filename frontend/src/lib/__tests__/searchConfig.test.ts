import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiError';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_FORM_VALUES,
  MAX_RADIUS_METERS,
  MAX_TEXT_LENGTH,
  describeAnalysisOptions,
  describeSearchError,
  formatRadius,
  validateSearchForm,
  type SearchFormValues,
} from '../searchConfig';

function values(overrides: Partial<SearchFormValues> = {}): SearchFormValues {
  return { ...DEFAULT_SEARCH_FORM_VALUES, category: 'barber', location: 'Nairobi', ...overrides };
}

function errorsFor(overrides: Partial<SearchFormValues>) {
  const validation = validateSearchForm(values(overrides));
  if (validation.ok) throw new Error('expected validation to fail');
  return validation.errors;
}

describe('search form defaults', () => {
  it('starts empty, with max results 20 and both analysis options off', () => {
    expect(DEFAULT_SEARCH_FORM_VALUES).toEqual({
      category: '',
      location: '',
      keyword: '',
      radius: '',
      maxResults: '20',
      websiteAnalysis: false,
      aiAnalysis: false,
    });
    expect(DEFAULT_MAX_RESULTS).toBe(20);
  });
});

describe('validateSearchForm', () => {
  it('builds the full configuration from valid values, with the defaults', () => {
    expect(validateSearchForm(values())).toEqual({
      ok: true,
      config: {
        category: 'barber',
        location: 'Nairobi',
        radius_meters: null,
        max_results: 20,
        analysis_options: { website_analysis: false, ai_analysis: false },
      },
    });
  });

  it('trims text, includes the keyword only when given, and passes numbers and flags through', () => {
    const validation = validateSearchForm(
      values({
        category: '  barber ',
        location: ' Nairobi ',
        keyword: ' barbershop ',
        radius: '5000',
        maxResults: '10',
        websiteAnalysis: true,
        aiAnalysis: true,
      }),
    );
    expect(validation).toEqual({
      ok: true,
      config: {
        category: 'barber',
        location: 'Nairobi',
        keyword: 'barbershop',
        radius_meters: 5000,
        max_results: 10,
        analysis_options: { website_analysis: true, ai_analysis: true },
      },
    });
  });

  it('omits a blank keyword entirely', () => {
    const validation = validateSearchForm(values({ keyword: '   ' }));
    expect(validation.ok).toBe(true);
    if (validation.ok) expect('keyword' in validation.config).toBe(false);
  });

  it('requires category and location', () => {
    const errors = errorsFor({ category: '   ', location: '' });
    expect(errors.category).toBe('Category is required.');
    expect(errors.location).toBe('Location is required.');
  });

  it('rejects text longer than the backend limit', () => {
    const tooLong = 'x'.repeat(MAX_TEXT_LENGTH + 1);
    const errors = errorsFor({ category: tooLong, location: tooLong, keyword: tooLong });
    expect(errors.category).toMatch(/100 characters or fewer/);
    expect(errors.location).toMatch(/100 characters or fewer/);
    expect(errors.keyword).toMatch(/100 characters or fewer/);
  });

  it('treats an empty radius as "no radius"', () => {
    const validation = validateSearchForm(values({ radius: '' }));
    expect(validation.ok && validation.config.radius_meters).toBe(null);
  });

  it('accepts the radius bounds, inclusive', () => {
    const low = validateSearchForm(values({ radius: '1' }));
    const high = validateSearchForm(values({ radius: String(MAX_RADIUS_METERS) }));
    expect(low.ok && low.config.radius_meters).toBe(1);
    expect(high.ok && high.config.radius_meters).toBe(50000);
  });

  it.each(['0', '-5', '0.5', '50001', '1000000'])('rejects out-of-range radius %s without changing it', (radius) => {
    expect(errorsFor({ radius }).radius).toBe('Radius must be between 1 and 50,000 meters.');
  });

  it.each(['abc', '1e', '0x10', 'Infinity', '12 34', '--5'])('rejects non-numeric radius %j', (radius) => {
    expect(errorsFor({ radius }).radius).toMatch(/must be a number of meters/);
  });

  it.each(['1', '10', '20', '50'])('accepts max results %s', (maxResults) => {
    const validation = validateSearchForm(values({ maxResults }));
    expect(validation.ok && validation.config.max_results).toBe(Number(maxResults));
  });

  it.each(['0', '51', '-1', '2.5', '', '  ', 'abc', '1e3'])('rejects max results %j', (maxResults) => {
    expect(errorsFor({ maxResults }).maxResults).toBe('Maximum results must be a whole number from 1 to 50.');
  });

  it('requires the analysis options to be real booleans', () => {
    const bad = { ...values(), websiteAnalysis: 'yes', aiAnalysis: 1 } as unknown as SearchFormValues;
    const validation = validateSearchForm(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.websiteAnalysis).toBe('Website analysis must be on or off.');
      expect(validation.errors.aiAnalysis).toBe('AI analysis must be on or off.');
    }
  });

  it('reports every problem at once', () => {
    const errors = errorsFor({ category: '', location: '', radius: '0', maxResults: '99' });
    expect(Object.keys(errors).sort()).toEqual(['category', 'location', 'maxResults', 'radius']);
  });
});

describe('display helpers', () => {
  it('formatRadius always shows the unit and groups thousands', () => {
    expect(formatRadius(500)).toBe('500 m');
    expect(formatRadius(5000)).toBe('5,000 m');
    expect(formatRadius(50000)).toBe('50,000 m');
  });

  it('describeAnalysisOptions lists what was requested', () => {
    expect(describeAnalysisOptions({ website_analysis: false, ai_analysis: false })).toBe('none');
    expect(describeAnalysisOptions({ website_analysis: true, ai_analysis: false })).toBe('website');
    expect(describeAnalysisOptions({ website_analysis: false, ai_analysis: true })).toBe('AI');
    expect(describeAnalysisOptions({ website_analysis: true, ai_analysis: true })).toBe('website, AI');
  });
});

describe('describeSearchError', () => {
  it('keeps the backend message and picks a title by status', () => {
    expect(describeSearchError(new ApiError('"radius_meters" must be a number.', 400))).toEqual({
      title: 'Invalid search configuration',
      message: '"radius_meters" must be a number.',
      retryable: false,
    });
    expect(describeSearchError(new ApiError('Could not find map coordinates for "Xyzzy".', 422))).toEqual({
      title: "Radius couldn't be applied",
      message: 'Could not find map coordinates for "Xyzzy".',
      retryable: false,
    });
    expect(describeSearchError(new ApiError('Google Places integration is not configured.', 503))).toEqual({
      title: 'Google Places API unavailable',
      message: 'Google Places integration is not configured.',
      retryable: false,
    });
  });

  it('marks network, rate-limit and server failures as retryable', () => {
    expect(describeSearchError(new ApiError('Could not reach the server.', 0)).retryable).toBe(true);
    expect(describeSearchError(new ApiError('Rate limit reached.', 429)).retryable).toBe(true);
    expect(describeSearchError(new ApiError('Google timed out.', 504)).retryable).toBe(true);
    expect(describeSearchError(new ApiError('Boom.', 500))).toMatchObject({ title: "The search couldn't be completed", retryable: true });
  });

  it('handles unexpected thrown values', () => {
    expect(describeSearchError(new Error('boom'))).toMatchObject({ title: 'Search failed', message: 'boom' });
    expect(describeSearchError('nope')).toMatchObject({ title: 'Search failed', message: 'Something went wrong running this search.' });
  });
});
