/**
 * Data-access layer for real Alvin Lead Hunter data.
 *
 * Phase 6: these functions now call the backend API (see /server), which
 * is the only thing that talks to Neon. The browser never sees
 * DATABASE_URL or any database credentials — every call below is a
 * plain same-origin fetch to /api/*.
 *
 * In dev, Vite proxies /api to the backend on port 3001 (see
 * vite.config.ts). In production, the backend serves the built
 * frontend itself, so /api is already same-origin.
 */
import type {
  AnalyticsData,
  AnalyticsMetrics,
  BatchLeadScoreResult,
  BatchWebsiteAnalysisResult,
  BatchWebsiteCheckResult,
  Business,
  DashboardMetrics,
  Lead,
  LeadDetailPipeline,
  LeadDetailResponse,
  LeadPipelineStage,
  LeadScoreResult,
  RunSearchInput,
  RunSearchResponse,
  SalesIntelligenceResponse,
  ScoreLeadBatchInput,
  SearchRecord,
  UnscoredBusinessCount,
  WebsiteAnalysis,
  WebsiteCheckResult,
} from '../types';
import { ApiError } from './apiError';

export { ApiError };

/**
 * Deployment fix: frontend (Render Static Site) and backend (Render Web
 * Service) are now deployed separately, so plain same-origin `/api/...`
 * requests from the frontend 404. VITE_API_URL, set in the frontend's
 * Render environment, points requests at the backend instead.
 *
 * Left unset (e.g. local dev), API_BASE_URL is '' and apiUrl()/fetchApi()
 * fall back to the existing relative /api/... requests, so the Vite dev
 * proxy to the backend continues to work unchanged.
 */
const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
  });
}

async function readErrorMessage(res: Response, path: string): Promise<string> {
  let message = `Request to ${path} failed (${res.status})`;
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // Response wasn't JSON — keep the generic message above.
  }
  return message;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetchApi(path);

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<T>;
}

export async function fetchDashboardMetrics(): Promise<DashboardMetrics> {
  return getJson<DashboardMetrics>('/api/dashboard/metrics');
}

export async function fetchLeads(): Promise<Lead[]> {
  return getJson<Lead[]>('/api/leads');
}

export async function fetchBusinesses(): Promise<Business[]> {
  return getJson<Business[]>('/api/businesses');
}

export async function fetchSearches(): Promise<SearchRecord[]> {
  return getJson<SearchRecord[]>('/api/searches');
}

/**
 * Phase 21 Part 1: metric keys every `metrics` object in a valid
 * GET /api/analytics response must have (see
 * server/lib/analytics.js#AnalyticsMetrics). Used only by
 * isAnalyticsData below to validate a 200 response's shape -- kept as
 * a list, not re-derived from the type, since TypeScript types don't
 * exist at runtime.
 */
const ANALYTICS_METRIC_KEYS: Array<keyof AnalyticsMetrics> = [
  'businesses_discovered',
  'no_website_businesses',
  'poor_website_businesses',
  'high_priority_leads',
  'contacted_leads',
  'responses',
  'meetings',
  'proposals',
  'won_deals',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Type guard for a GET /api/analytics 200 response body. A real
 * response always has a `metrics` object with all nine numeric
 * fields, plus the three breakdown objects (each may legitimately be
 * `{}` when there's no data yet -- see Phase 21 Part 2 Step 12).
 * Anything else -- null, an array, a differently-shaped object, a
 * `metrics` field missing or with the wrong type -- is treated as a
 * malformed response rather than trusted and rendered.
 */
function isAnalyticsData(body: unknown): body is AnalyticsData {
  if (!isPlainRecord(body)) return false;

  const metrics = body.metrics;
  if (!isPlainRecord(metrics)) return false;
  if (!ANALYTICS_METRIC_KEYS.every((key) => typeof metrics[key] === 'number')) return false;

  return (
    isPlainRecord(body.lead_priority_breakdown) &&
    isPlainRecord(body.pipeline_stage_breakdown) &&
    isPlainRecord(body.website_status_breakdown)
  );
}

/**
 * Phase 21 Part 1/2: fetches the real, backend-calculated analytics
 * (server/routes/analytics.js `GET /api/analytics`). The frontend
 * never calculates or duplicates any of these numbers itself -- this
 * only reads and validates the shape of what the backend already
 * computed from Neon.
 *
 * Throws (rejects) on a network failure, a non-2xx response, an
 * unparsable body, or a 200 body that doesn't match the expected
 * shape -- see useAnalytics in ../hooks/useData.ts, which turns any
 * of these into the page's error state rather than silently falling
 * back to zero metrics.
 */
export async function fetchAnalytics(): Promise<AnalyticsData> {
  const path = '/api/analytics';
  const res = await fetchApi(path);

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  const body: unknown = await res.json();
  if (!isAnalyticsData(body)) {
    throw new Error('The server returned an unexpected analytics response.');
  }

  return body;
}

/**
 * Phase 13B1B: response payload for GET /api/leads/:id
 * (server/lib/leadDetailService.js), typed per section (see
 * LeadDetailResponse and its component types in ../types). The
 * runtime shape check below (isLeadDetailResponse) only verifies
 * `lead.id`, so `business`/`website_analysis`/`ai_analysis`/`scoring`/
 * `pipeline` are still read defensively when rendering -- a malformed
 * or partial 200 response is never assumed to fully match this type.
 */
export type LeadDetail = LeadDetailResponse;

/**
 * Phase 13B1A-1B-B2: result of a GET /api/leads/:id request. `ok: true`
 * means the response was a 200 with a body that actually looks like a
 * lead detail payload. `ok: false` covers every other case -- a 404
 * (`notFound: true`), any other HTTP error, a network failure, or a 200
 * whose body doesn't match the expected shape (`status` is 0 for a
 * network failure).
 */
export type LeadDetailResult =
  | { ok: true; detail: LeadDetail }
  | { ok: false; status: number; notFound: boolean; error: string };

/**
 * Type guard for a GET /api/leads/:id 200 response body: a real lead
 * detail payload always has a `lead` object with an `id`. Anything
 * else -- null, an array, a differently-shaped object -- is treated as
 * an unexpected response rather than trusted and rendered.
 */
function isLeadDetailResponse(body: unknown): body is LeadDetail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const lead = (body as { lead?: unknown }).lead;
  return !!lead && typeof lead === 'object' && !Array.isArray(lead) && 'id' in lead;
}

/**
 * Phase 13B1A-1B-B2: fetches the full detail payload for one lead
 * (server/routes/leads.js `GET /api/leads/:id`). Never throws --
 * network errors, non-2xx responses (including 404), unparsable
 * bodies, and unexpectedly-shaped 200 bodies are all reported back as
 * `{ ok: false, ... }` so the page can show an appropriate state
 * instead of crashing or displaying fabricated data.
 */
export async function fetchLeadDetail(id: string): Promise<LeadDetailResult> {
  const path = `/api/leads/${id}`;

  let res: Response;
  try {
    res = await fetchApi(path);
  } catch {
    return {
      ok: false,
      status: 0,
      notFound: false,
      error: 'Could not reach the server. Check your connection and try again.',
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      status: res.status,
      notFound: false,
      error: `Request to ${path} failed (${res.status}).`,
    };
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request to ${path} failed (${res.status}).`;
    return { ok: false, status: res.status, notFound: res.status === 404, error: message };
  }

  if (!isLeadDetailResponse(body)) {
    return {
      ok: false,
      status: res.status,
      notFound: false,
      error: 'The server returned an unexpected response.',
    };
  }

  return { ok: true, detail: body };
}

/**
 * Phase 19 Part 2: result of a GET /api/leads/:id/intelligence request.
 * Same shape as LeadDetailResult on purpose: `ok: true` means a 200
 * whose body looks like a Sales Intelligence payload; `ok: false`
 * covers every other case (404, other HTTP errors, a network failure
 * -- `status` is 0 -- or a 200 with an unexpected body).
 */
export type SalesIntelligenceResult =
  | { ok: true; intelligence: SalesIntelligenceResponse }
  | { ok: false; status: number; notFound: boolean; error: string };

/**
 * Type guard for a GET /api/leads/:id/intelligence 200 response body
 * (server/lib/salesIntelligenceService.js#getSalesIntelligence). The
 * server always returns both lists as arrays (possibly empty) and
 * `service_match` as an object or null, so anything else is treated
 * as an unexpected response instead of being trusted and rendered.
 */
function isSalesIntelligenceResponse(body: unknown): body is SalesIntelligenceResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  const serviceMatch = b.service_match;
  return (
    Array.isArray(b.verified_observations) &&
    Array.isArray(b.ai_interpretation) &&
    (serviceMatch === null ||
      serviceMatch === undefined ||
      (typeof serviceMatch === 'object' && !Array.isArray(serviceMatch)))
  );
}

/**
 * Phase 19 Part 2: fetches the structured Sales Intelligence for one
 * lead (server/routes/leads.js `GET /api/leads/:id/intelligence`). The
 * backend does all the work -- this only reads the result -- and the
 * browser never sees a Gemini/API key. Never throws: network errors,
 * non-2xx responses, unparsable bodies and unexpectedly-shaped 200
 * bodies are all reported back as `{ ok: false, ... }`, so a failure
 * here can be shown in its own panel without affecting the rest of the
 * lead page.
 */
export async function fetchLeadIntelligence(id: string): Promise<SalesIntelligenceResult> {
  const path = `/api/leads/${encodeURIComponent(id)}/intelligence`;
  const networkError = 'Could not reach the server. Check your connection and try again.';

  try {
    const res = await fetchApi(path);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: res.status, notFound: false, error: `Request to ${path} failed (${res.status}).` };
    }

    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `Request to ${path} failed (${res.status}).`;
      return { ok: false, status: res.status, notFound: res.status === 404, error: message };
    }

    if (!isSalesIntelligenceResponse(body)) {
      return { ok: false, status: res.status, notFound: false, error: 'The server returned an unexpected response.' };
    }

    return { ok: true, intelligence: body };
  } catch {
    return { ok: false, status: 0, notFound: false, error: networkError };
  }
}

/**
 * Generic result wrapper for the two Phase 13B2 write endpoints below.
 * `ok: true` carries the persisted row; `ok: false` covers a network
 * failure, a non-2xx response, or an unparsable body.
 */
export type LeadWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

async function patchJson<T>(path: string, body: unknown): Promise<LeadWriteResult<T>> {
  let res: Response;
  try {
    res = await fetchApi(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.' };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `Request to ${path} failed (${res.status}).` };
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `Request to ${path} failed (${res.status}).`;
    return { ok: false, status: res.status, error: message };
  }

  return { ok: true, data: parsed as T };
}

/**
 * Phase 13B2: sets a lead's sales pipeline stage via the backend
 * (server/routes/leads.js `PATCH /api/leads/:id/pipeline`). Never
 * advances a stage automatically -- always sends exactly the stage the
 * user picked. Returns the persisted sales_pipeline row.
 */
export async function updateLeadPipelineStage(
  id: string,
  stage: LeadPipelineStage,
): Promise<LeadWriteResult<LeadDetailPipeline>> {
  return patchJson<LeadDetailPipeline>(`/api/leads/${id}/pipeline`, { stage });
}

/**
 * Phase 13B2: saves a lead's free-text sales notes via the backend
 * (server/routes/leads.js `PATCH /api/leads/:id/notes`). Returns the
 * persisted `leads` row.
 */
export async function updateLeadSalesNotes(id: string, salesNotes: string): Promise<LeadWriteResult<Lead>> {
  return patchJson<Lead>(`/api/leads/${id}/notes`, { sales_notes: salesNotes });
}

/**
 * Phase 9C2: checks one business's stored website_url via the backend's
 * safe reachability checker (server/lib/httpChecker.js) and persists the
 * result to Neon. The frontend never supplies a URL — the backend always
 * re-reads whatever is already stored on that business's row.
 */
export async function checkBusinessWebsite(id: string): Promise<WebsiteCheckResult> {
  const path = `/api/businesses/${id}/website-check`;
  const res = await fetchApi(path, { method: 'POST' });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<WebsiteCheckResult>;
}

/**
 * Phase 9C2: runs a bounded batch of website checks (server/routes/
 * businesses.js `POST /api/businesses/website-check`), covering
 * businesses that have never been checked before. `limit` is optional —
 * the backend defaults and caps it (see websiteCheckService.BATCH_LIMIT)
 * so this can never fire an unbounded number of requests.
 */
export async function checkWebsiteBatch(input: { limit?: number } = {}): Promise<BatchWebsiteCheckResult> {
  const path = '/api/businesses/website-check';
  const res = await fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<BatchWebsiteCheckResult>;
}

/**
 * Result of a single-business analysis request. `ok: true` covers every
 * case where the backend actually attempted analysis and persisted a
 * `website_analysis` row -- which includes the 429 (PageSpeed rate
 * limited) and 503 (site/PageSpeed unavailable) HTTP statuses, since
 * those still return the real stored row (see
 * server/lib/websiteAnalysisService.js#classifyAnalyzedResult). `ok:
 * false` covers the cases where no row was ever written: the business
 * has no website on file (400), its website isn't currently marked
 * reachable (409), the business doesn't exist (404), or a network/server
 * error prevented the request from completing at all.
 */
export type AnalyzeWebsiteResult =
  | { ok: true; analysis: WebsiteAnalysis }
  | { ok: false; status: number; error: string };

/**
 * Type guard for a POST /api/businesses/:id/website-analysis response
 * body: a real `website_analysis` row always has both `id` and
 * `analysis_status`, while every error response
 * (WebsiteAnalysisErrorResponse) only ever has `error` (plus optional
 * `business_id`/`website_status`) and never `analysis_status`.
 */
function isWebsiteAnalysisRow(body: unknown): body is WebsiteAnalysis {
  return (
    !!body &&
    typeof body === 'object' &&
    'id' in body &&
    'analysis_status' in body
  );
}

/**
 * Phase 10C: runs a Phase 10B homepage analysis for one business via the
 * backend (server/routes/businesses.js `POST
 * /api/businesses/:id/website-analysis`). The frontend never supplies a
 * URL -- the backend always re-reads whatever is already stored on that
 * business's row, and only ever analyzes businesses already marked
 * 'reachable' by Phase 9's website check.
 */
export async function analyzeBusinessWebsite(id: string): Promise<AnalyzeWebsiteResult> {
  const path = `/api/businesses/${id}/website-analysis`;

  let res: Response;
  try {
    res = await fetchApi(path, { method: 'POST' });
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.' };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `Request to ${path} failed (${res.status}).` };
  }

  if (isWebsiteAnalysisRow(body)) {
    return { ok: true, analysis: body };
  }

  const message =
    body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `Request to ${path} failed (${res.status}).`;

  return { ok: false, status: res.status, error: message };
}

/**
 * Phase 10C: runs a bounded batch of Phase 10B analyses (server/routes/
 * businesses.js `POST /api/businesses/website-analysis`), covering
 * businesses currently marked 'reachable'. `limit` is optional -- the
 * backend defaults to 20 and caps it at 50 (see
 * websiteAnalysisService.BATCH_LIMIT via websiteCheckService), so this
 * can never fire an unbounded number of requests.
 */
export async function analyzeWebsiteBatch(input: { limit?: number } = {}): Promise<BatchWebsiteAnalysisResult> {
  const path = '/api/businesses/website-analysis';
  const res = await fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<BatchWebsiteAnalysisResult>;
}

/**
 * Phase 12: deterministically (re)calculates one business's lead score
 * via the backend (server/routes/businesses.js `POST
 * /api/businesses/:id/lead-score`). The frontend never supplies
 * scoring facts -- the backend always re-reads whatever is already
 * verified and stored in Neon. Persists lead_score/priority/
 * scoring_factors/scored_at on that business's single `leads` row.
 */
export async function scoreBusinessLead(id: string): Promise<LeadScoreResult> {
  const path = `/api/businesses/${id}/lead-score`;
  const res = await fetchApi(path, { method: 'POST' });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<LeadScoreResult>;
}

/**
 * Phase 12: runs a bounded batch of deterministic lead scoring passes
 * (server/routes/businesses.js `POST /api/businesses/lead-score`).
 * `limit` is optional -- the backend defaults to 20 and caps it at 50
 * (server/lib/leadScoringService.js BATCH_LIMIT), so this can never
 * fire an unbounded number of requests. Never calls AI or any external
 * API -- scores only from data already stored in Neon.
 */
export async function scoreLeadBatch(input: ScoreLeadBatchInput = {}): Promise<BatchLeadScoreResult> {
  const path = '/api/businesses/lead-score';
  const res = await fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  return res.json() as Promise<BatchLeadScoreResult>;
}

/**
 * How many businesses have never been scored (GET
 * /api/businesses/unscored-count) -- exactly the set
 * scoreLeadBatch({ only_unscored: true }) works through. The response is
 * checked rather than trusted, so an unexpected body surfaces as an error
 * instead of a nonsense count.
 */
export async function fetchUnscoredBusinessCount(): Promise<number> {
  const path = '/api/businesses/unscored-count';
  const res = await fetchApi(path);

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  const data = (await res.json()) as Partial<UnscoredBusinessCount> | null;
  const count = data?.unscored_count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error('The server returned an unexpected unscored-count response.');
  }
  return count;
}

const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and try again.';

/**
 * Reads the JSON error body of a failed POST /api/searches. Keeps the
 * backend's own `error` message whenever there is one (validation, the
 * radius-location 422, the Google configuration 503, ...) and falls
 * back to a generic status message only when there is not. Also picks
 * up `searchId`, which the backend includes when it recorded the
 * failed search.
 */
async function readSearchError(res: Response, path: string): Promise<{ message: string; searchId?: string }> {
  let message = `Request to ${path} failed (${res.status}).`;
  let searchId: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const { error, searchId: id } = body as { error?: unknown; searchId?: unknown };
      if (typeof error === 'string' && error.trim()) message = error;
      if (typeof id === 'string') searchId = id;
    }
  } catch {
    // Response wasn't JSON -- keep the generic message above.
  }
  return { message, searchId };
}

/**
 * Phase 22 Part 2: downloads the backend-generated leads CSV
 * (server/routes/leads.js `GET /api/leads/export.csv`, Phase 22 Part 1).
 * The frontend never reconstructs the CSV -- this only requests the
 * file, receives it as a Blob, and triggers a browser download via a
 * temporary object URL + anchor, then cleans both up.
 *
 * Throws (rejects) on a network failure or a non-2xx response -- reusing
 * the same NETWORK_ERROR_MESSAGE and readErrorMessage() used elsewhere in
 * this file -- so the caller can show an error instead of downloading
 * nothing.
 */
export async function exportLeadsCsv(): Promise<void> {
  const path = '/api/leads/export.csv';

  let res: Response;
  try {
    res = await fetchApi(path);
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path));
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'alvin-leads.csv';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  URL.revokeObjectURL(url);
}

/**
 * Runs a Google Places business-discovery search via the backend
 * (server/routes/searches.js `POST /api/searches`). The backend is the
 * only thing that ever talks to Google -- this is a plain same-origin
 * POST, same as every other call in this file.
 *
 * Phase 20: `input` is a full search configuration (category, location,
 * keyword, radius, max results, analysis options). The backend
 * validates and applies it; nothing is duplicated here.
 *
 * Failures reject with an ApiError (still an Error carrying the
 * backend's message) whose `status` is the HTTP status -- 400 invalid
 * configuration, 422 radius location not found, 503 Google Places not
 * configured, ... -- or 0 when the server could not be reached.
 */
export async function runBusinessSearch(input: RunSearchInput): Promise<RunSearchResponse> {
  const path = '/api/searches';

  let res: Response;
  try {
    res = await fetchApi(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }

  if (!res.ok) {
    const { message, searchId } = await readSearchError(res, path);
    throw new ApiError(message, res.status, searchId);
  }

  try {
    return (await res.json()) as RunSearchResponse;
  } catch {
    throw new ApiError('The server returned an unexpected response.', res.status);
  }
}