import { useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search as SearchIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ApiError, runBusinessSearch } from '../../lib/api';
import {
  DEFAULT_SEARCH_FORM_VALUES,
  MAX_RADIUS_METERS,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  MAX_TEXT_LENGTH,
  MIN_RADIUS_METERS,
  MIN_RESULTS,
  SEARCH_FORM_FIELD_ORDER,
  describeSearchError,
  formatRadius,
  validateSearchForm,
  type SearchErrorInfo,
  type SearchFormErrors,
  type SearchFormField,
  type SearchFormValues,
} from '../../lib/searchConfig';
import type { RunSearchResponse, SearchSummary } from '../../types';

interface BusinessSearchFormProps {
  /** Called after a search finishes (or fails after the backend recorded it), so the parent can refresh search history. */
  onSearchComplete?: () => void;
}

const inputClass =
  'h-9 w-full rounded border bg-white px-3 text-sm text-ink placeholder:text-ink-400 focus:border-ink-600 focus:outline-none focus:ring-2 focus:ring-ink-600/20';

function borderClass(hasError: boolean): string {
  return hasError ? 'border-danger' : 'border-surface-border';
}

const labelClass = 'mb-1 block text-xs font-medium text-ink-600';
const hintClass = 'mt-1 text-xs text-ink-400';
const errorClass = 'mt-1 text-xs text-danger';

/**
 * Phase 20 Part 2: the manual Search Configuration form on the Searches
 * page (this replaces the old three-field search bar; category /
 * location / keyword keep their meaning). It only collects a
 * configuration and posts it to the existing POST /api/searches via
 * runBusinessSearch -- radius filtering, limits and the analysis
 * flags are the backend's job, and nothing here runs a search, a
 * website analysis or an AI analysis unless the user clicks Run Search.
 */
export function BusinessSearchForm({ onSearchComplete }: BusinessSearchFormProps) {
  const [values, setValues] = useState<SearchFormValues>(DEFAULT_SEARCH_FORM_VALUES);
  const [errors, setErrors] = useState<SearchFormErrors>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<SearchErrorInfo | null>(null);
  const [result, setResult] = useState<RunSearchResponse | null>(null);
  const inputRefs = useRef<Partial<Record<SearchFormField, HTMLInputElement | null>>>({});

  function setInputRef(field: SearchFormField) {
    return (el: HTMLInputElement | null) => {
      inputRefs.current[field] = el;
    };
  }

  function update<K extends SearchFormField>(field: K, value: SearchFormValues[K]) {
    const next = { ...values, [field]: value };
    setValues(next);
    // Once the user has tried to submit, keep the messages in sync as they fix things.
    if (submitAttempted) {
      const validation = validateSearchForm(next);
      setErrors(validation.ok ? {} : validation.errors);
    }
  }

  function a11y(field: SearchFormField, hintId?: string) {
    const errorId = errors[field] ? `${field}-error` : undefined;
    const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
    return {
      'aria-invalid': errors[field] ? (true as const) : undefined,
      'aria-describedby': describedBy,
    };
  }

  async function runSearch() {
    if (isSubmitting) return;

    setSubmitAttempted(true);
    const validation = validateSearchForm(values);
    if (!validation.ok) {
      setErrors(validation.errors);
      const firstInvalid = SEARCH_FORM_FIELD_ORDER.find((field) => validation.errors[field]);
      if (firstInvalid) inputRefs.current[firstInvalid]?.focus();
      return;
    }

    setErrors({});
    setIsSubmitting(true);
    setRequestError(null);
    setResult(null);

    try {
      const response = await runBusinessSearch(validation.config);
      setResult(response);
      onSearchComplete?.();
    } catch (err) {
      setRequestError(describeSearchError(err));
      // The backend records a failed search row (and tells us its id), so the history has changed too.
      if (err instanceof ApiError && err.searchId) onSearchComplete?.();
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runSearch();
  }

  const radiusHintId = 'search-radius-hint';
  const maxResultsHintId = 'search-max-results-hint';

  return (
    <section aria-labelledby="search-configuration-heading" className="mb-6 rounded border border-surface-border bg-white p-4">
      <h2 id="search-configuration-heading" className="text-sm font-semibold text-ink">
        Search configuration
      </h2>
      <p className="mt-1 text-xs text-ink-400">Set up a search, then run it manually. Nothing runs until you click Run Search.</p>

      {/* noValidate: the browser's native tooltips would pre-empt these field-level messages. */}
      <form onSubmit={handleSubmit} noValidate aria-busy={isSubmitting} className="mt-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="search-category" className={labelClass}>
              Category
            </label>
            <input
              id="search-category"
              ref={setInputRef('category')}
              value={values.category}
              onChange={(e) => update('category', e.target.value)}
              placeholder="e.g. barber"
              maxLength={MAX_TEXT_LENGTH}
              required
              disabled={isSubmitting}
              className={`${inputClass} ${borderClass(!!errors.category)}`}
              {...a11y('category')}
            />
            {errors.category && (
              <p id="category-error" className={errorClass}>
                {errors.category}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="search-location" className={labelClass}>
              Location
            </label>
            <input
              id="search-location"
              ref={setInputRef('location')}
              value={values.location}
              onChange={(e) => update('location', e.target.value)}
              placeholder="e.g. Nairobi"
              maxLength={MAX_TEXT_LENGTH}
              required
              disabled={isSubmitting}
              className={`${inputClass} ${borderClass(!!errors.location)}`}
              {...a11y('location')}
            />
            {errors.location && (
              <p id="location-error" className={errorClass}>
                {errors.location}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="search-keyword" className={labelClass}>
              Keyword <span className="text-ink-400">(optional)</span>
            </label>
            <input
              id="search-keyword"
              ref={setInputRef('keyword')}
              value={values.keyword}
              onChange={(e) => update('keyword', e.target.value)}
              placeholder="e.g. barbershop"
              maxLength={MAX_TEXT_LENGTH}
              disabled={isSubmitting}
              className={`${inputClass} ${borderClass(!!errors.keyword)}`}
              {...a11y('keyword')}
            />
            {errors.keyword && (
              <p id="keyword-error" className={errorClass}>
                {errors.keyword}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="search-radius" className={labelClass}>
              Radius <span className="text-ink-400">(meters, optional)</span>
            </label>
            <div className="relative">
              <input
                id="search-radius"
                ref={setInputRef('radius')}
                type="number"
                inputMode="numeric"
                min={MIN_RADIUS_METERS}
                max={MAX_RADIUS_METERS}
                step="any"
                value={values.radius}
                onChange={(e) => update('radius', e.target.value)}
                placeholder="No radius"
                disabled={isSubmitting}
                className={`${inputClass} ${borderClass(!!errors.radius)} pr-16`}
                {...a11y('radius', radiusHintId)}
              />
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-400">
                meters
              </span>
            </div>
            <p id={radiusHintId} className={hintClass}>
              {MIN_RADIUS_METERS.toLocaleString('en-US')} to {MAX_RADIUS_METERS.toLocaleString('en-US')} meters. Leave empty for no
              radius.
            </p>
            {errors.radius && (
              <p id="radius-error" className={errorClass}>
                {errors.radius}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="search-max-results" className={labelClass}>
              Maximum results
            </label>
            <input
              id="search-max-results"
              ref={setInputRef('maxResults')}
              type="number"
              inputMode="numeric"
              min={MIN_RESULTS}
              max={MAX_RESULTS_LIMIT}
              step={1}
              value={values.maxResults}
              onChange={(e) => update('maxResults', e.target.value)}
              disabled={isSubmitting}
              className={`${inputClass} ${borderClass(!!errors.maxResults)}`}
              {...a11y('maxResults', maxResultsHintId)}
            />
            <p id={maxResultsHintId} className={hintClass}>
              {MIN_RESULTS} to {MAX_RESULTS_LIMIT}. Default {DEFAULT_MAX_RESULTS}.
            </p>
            {errors.maxResults && (
              <p id="maxResults-error" className={errorClass}>
                {errors.maxResults}
              </p>
            )}
          </div>
        </div>

        <fieldset className="mt-4 rounded border border-surface-border px-3 pb-3 pt-1" disabled={isSubmitting}>
          <legend className="px-1 text-xs font-medium text-ink-600">Analysis options</legend>
          <p id="search-analysis-hint" className="mb-2 text-xs text-ink-400">
            These only save your choice with the search. Nothing is analyzed automatically.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label htmlFor="search-website-analysis" className="inline-flex items-center gap-2 text-sm text-ink">
              <input
                id="search-website-analysis"
                ref={setInputRef('websiteAnalysis')}
                type="checkbox"
                checked={values.websiteAnalysis}
                onChange={(e) => update('websiteAnalysis', e.target.checked)}
                className="h-4 w-4 rounded border-surface-border accent-ink"
                {...a11y('websiteAnalysis', 'search-analysis-hint')}
              />
              Website analysis
            </label>
            <label htmlFor="search-ai-analysis" className="inline-flex items-center gap-2 text-sm text-ink">
              <input
                id="search-ai-analysis"
                ref={setInputRef('aiAnalysis')}
                type="checkbox"
                checked={values.aiAnalysis}
                onChange={(e) => update('aiAnalysis', e.target.checked)}
                className="h-4 w-4 rounded border-surface-border accent-ink"
                {...a11y('aiAnalysis', 'search-analysis-hint')}
              />
              AI analysis
            </label>
          </div>
          {(errors.websiteAnalysis || errors.aiAnalysis) && (
            <p id="websiteAnalysis-error" className={errorClass}>
              {errors.websiteAnalysis ?? errors.aiAnalysis}
            </p>
          )}
        </fieldset>

        <div className="mt-4">
          <Button
            type="submit"
            disabled={isSubmitting}
            icon={isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <SearchIcon className="h-4 w-4" aria-hidden="true" />}
            className="w-full sm:w-auto"
          >
            {isSubmitting ? 'Searching…' : 'Run Search'}
          </Button>
        </div>
      </form>

      {isSubmitting && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-ink-600">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Running your search. This can take a few seconds.
        </p>
      )}

      {requestError && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded border border-danger/20 bg-danger-50 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">{requestError.title}</p>
            <p className="mt-0.5 break-words">{requestError.message}</p>
            {requestError.retryable && (
              <button
                type="button"
                onClick={() => void runSearch()}
                className="mt-2 rounded border border-danger/30 bg-white px-3 py-1 text-xs font-medium text-danger hover:bg-danger-50"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {result && <SearchResultSummary result={result} />}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

/** True only for a well-formed summary -- so a missing/odd one is skipped rather than shown as made-up zeros. */
function isSearchSummary(value: unknown): value is SearchSummary {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.places_returned === 'number' &&
    typeof s.excluded_outside_radius === 'number' &&
    typeof s.results_count === 'number'
  );
}

function SearchResultSummary({ result }: { result: RunSearchResponse }) {
  const { search, businesses } = result;
  const summary = isSearchSummary(result.summary) ? result.summary : null;
  const radiusMeters = typeof search.radius_meters === 'number' ? search.radius_meters : null;

  const resultsCount = summary ? summary.results_count : businesses.length;
  const newCount = businesses.filter((b) => b.isNew).length;
  const existingCount = businesses.length - newCount;

  return (
    <div role="status" aria-label="Search results" className="mt-4 rounded border border-success/20 bg-success-50/40 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-success">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        Search complete
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {search.category && <Stat label="Category" value={search.category} />}
        {search.location && <Stat label="Location" value={search.location} />}
        {search.keyword && <Stat label="Keyword" value={search.keyword} />}
        {radiusMeters !== null && <Stat label="Radius" value={formatRadius(radiusMeters)} />}
        {typeof search.max_results === 'number' && <Stat label="Maximum results" value={search.max_results} />}
        {summary && <Stat label="Places returned" value={summary.places_returned} />}
        <Stat label="Results" value={resultsCount} />
        {summary && radiusMeters !== null && <Stat label="Excluded by radius" value={summary.excluded_outside_radius} />}
      </dl>

      {businesses.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-surface-border bg-white px-4 py-5 text-center">
          <p className="text-sm font-semibold text-ink">No businesses found</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-400">
            {summary && summary.excluded_outside_radius > 0
              ? `Google returned ${summary.places_returned} ${summary.places_returned === 1 ? 'place' : 'places'}, and ${summary.excluded_outside_radius} of them ${summary.excluded_outside_radius === 1 ? 'was' : 'were'} outside the radius. Try a larger radius or search without one.`
              : 'This search returned no businesses. Try a different category, location or keyword, or widen the radius.'}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-600">
            Found <span className="font-medium text-ink">{businesses.length}</span>{' '}
            {businesses.length === 1 ? 'business' : 'businesses'} — <span className="font-medium text-ink">{newCount}</span> new,{' '}
            <span className="font-medium text-ink">{existingCount}</span> already known.
          </p>

          <ul className="mt-3 max-h-80 divide-y divide-surface-border overflow-y-auto rounded border border-surface-border bg-white">
            {businesses.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{b.name}</span>
                  {b.category && <span className="ml-2 text-ink-400">{b.category}</span>}
                  {b.city && <span className="ml-2 text-ink-400">· {b.city}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {b.google_rating != null && (
                    <span className="text-ink-600">
                      ★ {b.google_rating}
                      {b.google_review_count != null ? ` (${b.google_review_count})` : ''}
                    </span>
                  )}
                  <Badge tone={b.isNew ? 'success' : 'neutral'}>{b.isNew ? 'New' : 'Already known'}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
