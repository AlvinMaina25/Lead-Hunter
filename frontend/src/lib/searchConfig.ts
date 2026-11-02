/**
 * Phase 20 Part 2: pure (React-free) logic behind the Search
 * Configuration form -- defaults, client-side validation, the request
 * payload, and display helpers.
 *
 * Validation here exists for UX only (fast, specific messages before a
 * request is sent). The backend -- server/lib/validation.js
 * #validateSearchConfiguration -- remains authoritative and re-checks
 * everything; its 400 messages are shown as-is when they come back.
 * The limits below deliberately mirror the backend's.
 */
import { ApiError } from './apiError';
import type { RunSearchInput, SearchAnalysisOptions } from '../types';

export const MIN_RADIUS_METERS = 1;
export const MAX_RADIUS_METERS = 50000;
export const MIN_RESULTS = 1;
export const MAX_RESULTS_LIMIT = 50;
export const DEFAULT_MAX_RESULTS = 20;
/** Same cap as the backend's MAX_FIELD_LENGTH for category / location / keyword. */
export const MAX_TEXT_LENGTH = 100;

/** Everything the form edits. Numeric fields stay strings until validated so nothing is silently coerced. */
export interface SearchFormValues {
  category: string;
  location: string;
  keyword: string;
  radius: string;
  maxResults: string;
  websiteAnalysis: boolean;
  aiAnalysis: boolean;
  onlyWithoutWebsite: boolean;
}

export const DEFAULT_SEARCH_FORM_VALUES: SearchFormValues = {
  category: '',
  location: '',
  keyword: '',
  radius: '',
  maxResults: String(DEFAULT_MAX_RESULTS),
  websiteAnalysis: false,
  aiAnalysis: false,
  onlyWithoutWebsite: false,
};

export type SearchFormField = keyof SearchFormValues;
export type SearchFormErrors = Partial<Record<SearchFormField, string>>;

/** Order used to decide which invalid field receives focus first. */
export const SEARCH_FORM_FIELD_ORDER: SearchFormField[] = [
  'category',
  'location',
  'keyword',
  'radius',
  'maxResults',
  'websiteAnalysis',
  'aiAnalysis',
  'onlyWithoutWebsite',
];

/** A validated configuration, ready to send: every field the form controls is present. */
export interface ValidatedSearchConfiguration extends RunSearchInput {
  radius_meters: number | null;
  max_results: number;
  analysis_options: SearchAnalysisOptions;
  only_without_website: boolean;
}

export type SearchFormValidation =
  | { ok: true; config: ValidatedSearchConfiguration }
  | { ok: false; errors: SearchFormErrors };

type ParsedNumber = { kind: 'empty' } | { kind: 'invalid' } | { kind: 'number'; value: number };

// Plain decimal / exponent notation only -- rejects things Number() would
// happily accept, like "0x10" or "Infinity".
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function parseNumber(text: string): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!NUMBER_PATTERN.test(trimmed)) return { kind: 'invalid' };
  const value = Number(trimmed);
  return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'invalid' };
}

function checkText(label: string, raw: string, required: boolean): { value: string; error?: string } {
  const value = raw.trim();
  if (required && value.length === 0) return { value, error: `${label} is required.` };
  if (value.length > MAX_TEXT_LENGTH) {
    return { value, error: `${label} must be ${MAX_TEXT_LENGTH} characters or fewer.` };
  }
  return { value };
}

const RADIUS_RANGE_MESSAGE = `Radius must be between ${MIN_RADIUS_METERS.toLocaleString('en-US')} and ${MAX_RADIUS_METERS.toLocaleString('en-US')} meters.`;
const MAX_RESULTS_MESSAGE = `Maximum results must be a whole number from ${MIN_RESULTS} to ${MAX_RESULTS_LIMIT}.`;

export function validateSearchForm(values: SearchFormValues): SearchFormValidation {
  const errors: SearchFormErrors = {};

  const category = checkText('Category', values.category, true);
  if (category.error) errors.category = category.error;

  const location = checkText('Location', values.location, true);
  if (location.error) errors.location = location.error;

  const keyword = checkText('Keyword', values.keyword, false);
  if (keyword.error) errors.keyword = keyword.error;

  // Radius: empty = no radius; otherwise a number of meters in range.
  let radius: number | null = null;
  const parsedRadius = parseNumber(values.radius);
  if (parsedRadius.kind === 'invalid') {
    errors.radius = 'Radius must be a number of meters, or left empty for no radius.';
  } else if (parsedRadius.kind === 'number') {
    if (parsedRadius.value < MIN_RADIUS_METERS || parsedRadius.value > MAX_RADIUS_METERS) {
      errors.radius = RADIUS_RANGE_MESSAGE;
    } else {
      radius = parsedRadius.value;
    }
  }

  // Maximum results: required whole number 1..50.
  let maxResults = DEFAULT_MAX_RESULTS;
  const parsedMax = parseNumber(values.maxResults);
  if (
    parsedMax.kind !== 'number' ||
    !Number.isInteger(parsedMax.value) ||
    parsedMax.value < MIN_RESULTS ||
    parsedMax.value > MAX_RESULTS_LIMIT
  ) {
    errors.maxResults = MAX_RESULTS_MESSAGE;
  } else {
    maxResults = parsedMax.value;
  }

  // The UI only produces booleans, but this is the last check before a
  // request is built, so enforce it rather than assume it.
  if (typeof values.websiteAnalysis !== 'boolean') errors.websiteAnalysis = 'Website analysis must be on or off.';
  if (typeof values.aiAnalysis !== 'boolean') errors.aiAnalysis = 'AI analysis must be on or off.';

  if (typeof values.onlyWithoutWebsite !== 'boolean') errors.onlyWithoutWebsite = 'No website filter must be on or off.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const config: ValidatedSearchConfiguration = {
    category: category.value,
    location: location.value,
    radius_meters: radius,
    max_results: maxResults,
    analysis_options: {
      website_analysis: values.websiteAnalysis,
      ai_analysis: values.aiAnalysis,
    },
    only_without_website: values.onlyWithoutWebsite,
  };
  if (keyword.value) config.keyword = keyword.value;
  return { ok: true, config };
}

/** "5,000 m" -- the unit is always shown. Pinned to en-US so output does not depend on the runtime locale. */
export function formatRadius(meters: number): string {
  return `${meters.toLocaleString('en-US')} m`;
}

/** "website, AI" / "none" -- which analysis options were requested for a search. */
export function describeAnalysisOptions(options: SearchAnalysisOptions): string {
  const enabled: string[] = [];
  if (options.website_analysis) enabled.push('website');
  if (options.ai_analysis) enabled.push('AI');
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

export interface SearchErrorInfo {
  title: string;
  /** The backend's own message whenever there is one. */
  message: string;
  /** True when trying the same search again could plausibly succeed (network / server / rate-limit failures). */
  retryable: boolean;
}

/**
 * Turns whatever runBusinessSearch threw into something displayable.
 * The message is always the backend's own when one exists -- only the
 * title is chosen here, from the HTTP status.
 */
export function describeSearchError(err: unknown): SearchErrorInfo {
  const fallbackMessage = 'Something went wrong running this search.';

  if (!(err instanceof ApiError)) {
    return {
      title: 'Search failed',
      message: err instanceof Error && err.message ? err.message : fallbackMessage,
      retryable: true,
    };
  }

  const message = err.message || fallbackMessage;

  switch (err.status) {
    case 0:
      return { title: "Couldn't reach the server", message, retryable: true };
    case 400:
      return { title: 'Invalid search configuration', message, retryable: false };
    case 422:
      return { title: "Radius couldn't be applied", message, retryable: false };
    case 503:
      return { title: 'Google Places API unavailable', message, retryable: false };
    case 429:
      return { title: 'Search rate limit reached', message, retryable: true };
    default:
      return { title: "The search couldn't be completed", message, retryable: err.status >= 500 };
  }
}
