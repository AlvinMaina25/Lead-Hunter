/**
 * These types mirror the Neon PostgreSQL schema defined in
 * migrations/001_init_schema.sql (Phase 3). They exist purely as a
 * frontend contract — nothing here changes the database.
 */

/**
 * Matches the businesses.website_status CHECK constraint added in
 * migrations/002_add_website_checked_at.sql (Phase 9A). The older
 * 'active' | 'inactive' | 'broken' vocabulary was never actually
 * written by any code path and the constraint no longer allows it.
 */
export type WebsiteStatus = 'no_website' | 'reachable' | 'unreachable' | 'unknown';

export interface Business {
  id: string;
  external_place_id: string | null;
  name: string;
  category: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  google_maps_url: string | null;
  /**
   * The `pg` driver returns PostgreSQL NUMERIC columns (see
   * google_rating NUMERIC(2,1) in migrations/001_init_schema.sql) as
   * strings, not numbers, to avoid silent float precision loss. Callers
   * must coerce before doing arithmetic — see `toRatingNumber` in
   * BusinessesTable.tsx.
   */
  google_rating: number | string | null;
  google_review_count: number | null;
  website_url: string | null;
  website_status: WebsiteStatus;
  /** When website_status was last (re)computed by a real reachability check. NULL = never checked. */
  website_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 9C2: request/response shapes for the website-check endpoints
 * (server/routes/businesses.js).
 */
export interface WebsiteCheckResult {
  id: string;
  name: string;
  website_url: string | null;
  website_status: WebsiteStatus;
  website_checked_at: string | null;
  http_status: number | null;
}

export interface BatchWebsiteCheckResult {
  checked: number;
  reachable: number;
  unreachable: number;
  no_website: number;
  unknown: number;
}

/**
 * Phase 10: matches the website_analysis.analysis_status CHECK
 * constraint in migrations/003_website_analysis_results.sql. This is a
 * different vocabulary than businesses.website_status (WebsiteStatus,
 * above) -- do not conflate the two.
 */
export type WebsiteAnalysisStatus =
  | 'completed'
  | 'failed'
  | 'rate_limited'
  | 'blocked'
  | 'timeout'
  | 'unavailable';

/**
 * A single row from `website_analysis` (migrations/003_website_analysis_results.sql),
 * as returned as-is by POST /api/businesses/:id/website-analysis and
 * POST /api/businesses/website-analysis (server/routes/businesses.js).
 * Multiple rows can exist per business over time; the API only ever
 * hands back the row for the analysis attempt just performed -- there
 * is no historical-list endpoint yet (Phase 10C intentionally does not
 * invent one).
 *
 * Every *_score/technical/page field is a genuine measured value or
 * `null` when PageSpeed/the homepage fetch didn't produce it -- never
 * defaulted to 0 or invented. See the column notes in the migration.
 */
export interface WebsiteAnalysis {
  id: string;
  business_id: string;
  analyzed_url: string;
  analyzed_at: string;
  performance_score: number | null;
  accessibility_score: number | null;
  seo_score: number | null;
  best_practices_score: number | null;
  mobile_indicator: string | null;
  https_enabled: boolean | null;
  page_title: string | null;
  meta_description: string | null;
  viewport_present: boolean | null;
  html_size_bytes: number | null;
  response_time_ms: number | null;
  http_status: number | null;
  analysis_status: WebsiteAnalysisStatus;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

/**
 * Error-shaped response from POST /api/businesses/:id/website-analysis
 * when the business is ineligible (400 no_website, 409 not_reachable)
 * or wasn't found (404) -- as opposed to a 200/429/503 response, which
 * always carries a full WebsiteAnalysis row instead, even when the
 * analysis attempt itself didn't fully succeed.
 */
export interface WebsiteAnalysisErrorResponse {
  error: string;
  business_id?: string;
  website_status?: WebsiteStatus;
}

/**
 * Response shape for POST /api/businesses/website-analysis
 * (server/lib/websiteAnalysisService.js#analyzeBusinessBatch).
 */
export interface BatchWebsiteAnalysisResult {
  requested_limit: number;
  businesses_found: number;
  results: Array<{
    business_id: string;
    ok: boolean;
    analysis_status: WebsiteAnalysisStatus | null;
    error_code: string | null;
  }>;
}

export interface AiAnalysis {
  id: string;
  business_id: string;
  summary: string | null;
  problems: string[] | null;
  opportunities: string[] | null;
  recommended_service: string | null;
  reasoning: string | null;
  confidence: number | null;
  ai_model: string | null;
  created_at: string;
}

/**
 * Phase 12: matches the leads.priority CHECK constraint replaced in
 * migrations/005_lead_scoring.sql. The original 'urgent' value was
 * never actually written by any code path and has been replaced with
 * the four-tier 'very_high' the deterministic scoring engine
 * (server/lib/leadScoring.js) produces. Display formatting into
 * "Very High" happens in Badge.tsx.
 */
export type LeadPriority = 'low' | 'medium' | 'high' | 'very_high';
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted' | 'lost';

/**
 * Phase 12: one entry of leads.scoring_factors, exactly as produced by
 * server/lib/leadScoring.js and returned by
 * POST /api/businesses/:id/lead-score / GET /api/leads.
 */
export interface ScoringFactor {
  code: string;
  label: string;
  points: number;
  reason: string;
}

export interface Lead {
  id: string;
  business_id: string;
  lead_score: number | null;
  priority: LeadPriority;
  lead_status: LeadStatus;
  estimated_opportunity: number | null;
  sales_notes: string | null;
  /** Phase 12. Ordered factor breakdown explaining lead_score. NULL until scored at least once. */
  scoring_factors: ScoringFactor[] | null;
  /** Phase 12. When lead_score/priority/scoring_factors were last computed. NULL = never scored. */
  scored_at: string | null;
  created_at: string;
  updated_at: string;

  // Convenience fields the API is expected to join in for list views.
  // Optional because a raw `leads` row alone won't have them.
  business_name?: string;
  business_category?: string | null;
  business_city?: string | null;
  business_country?: string | null;
  recommended_service?: string | null;

  // Contact summary flags joined in by GET /api/leads (flags only, never
  // the contact values). Optional: an older server omits them, and the
  // UI then shows no indicators instead of guessing.
  has_phone?: boolean;
  has_email?: boolean;
  has_social?: boolean;
  has_whatsapp?: boolean;
}

/** Where a stored contact was found, and when. */
export interface ContactProvenance {
  source_url: string | null;
  found_at: string | null;
}

export type SocialPlatform = 'instagram' | 'facebook' | 'tiktok' | 'x' | 'linkedin' | 'youtube';

/**
 * The `contacts` block of GET /api/leads/:id
 * (server/lib/contactService.js#buildContactsSummary). Every URL in it
 * is data from a third party and is validated by lib/safeLinks.ts
 * before the UI renders it as a link.
 */
export interface LeadContacts {
  /** Google's phone for the business. wa.me link exists only with an international number ("try it", not verified). */
  phone: {
    national: string | null;
    international: string | null;
    tel_href: string | null;
    whatsapp_href: string | null;
  } | null;
  emails: Array<{ value: string; href: string } & ContactProvenance>;
  /** tel: numbers found on the business's website. */
  phones: Array<{ value: string; href: string } & ContactProvenance>;
  /** WhatsApp links found on the business's website. */
  whatsapp: Array<{ url: string } & ContactProvenance>;
  socials: Array<{ platform: SocialPlatform; url: string } & ContactProvenance>;
  contact_page: ({ url: string } & ContactProvenance) | null;
  /** Present only for a business with no website. */
  search_links: { google: string; instagram: string } | null;
  summary: { has_phone: boolean; has_email: boolean; has_social: boolean; has_whatsapp: boolean };
}

/**
 * Phase 12: the subset of an ai_analysis row that
 * loadLatestAiAnalysis (server/lib/leadScoringService.js) selects for
 * display alongside a lead score -- deliberately not the full
 * AiAnalysis shape, since this query selects fewer columns. This data
 * is sales intelligence shown NEXT TO the score; it never influences
 * lead_score/priority.
 */
export interface LeadScoreAiSummary {
  recommended_service: string | null;
  reasoning: string | null;
  sales_angle: string | null;
  confidence: number | null;
  status: string;
  created_at: string;
}

/**
 * Phase 12: response shape for POST /api/businesses/:id/lead-score
 * (server/lib/leadScoringService.js#scoreBusiness).
 */
export interface LeadScoreResult {
  business_id: string;
  lead_score: number;
  priority: LeadPriority;
  scoring_factors: ScoringFactor[];
  scored_at: string;
  ai_analysis: LeadScoreAiSummary | null;
}

/**
 * Phase 12: response shape for POST /api/businesses/lead-score
 * (server/lib/leadScoringService.js#scoreBusinessBatch).
 */
export interface BatchLeadScoreResult {
  requested_limit: number;
  businesses_found: number;
  results: Array<{
    business_id: string;
    ok: boolean;
    lead_score: number | null;
    priority: LeadPriority | null;
  }>;
}

/**
 * Body of POST /api/businesses/lead-score. `only_unscored` limits the
 * batch to businesses that have never been scored (no lead yet); without
 * it the batch is the oldest businesses whether or not they have a lead.
 */
export interface ScoreLeadBatchInput {
  limit?: number;
  only_unscored?: boolean;
}

/** Response of GET /api/businesses/unscored-count. */
export interface UnscoredBusinessCount {
  unscored_count: number;
}

export type PipelineStage =
  | 'new'
  | 'contacted'
  | 'responded'
  | 'meeting_scheduled'
  | 'proposal_sent'
  | 'negotiation'
  | 'won'
  | 'lost';

export interface SalesPipelineEntry {
  id: string;
  lead_id: string;
  stage: PipelineStage;
  contacted_at: string | null;
  response_at: string | null;
  meeting_at: string | null;
  proposal_at: string | null;
  won_at: string | null;
  lost_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type SearchStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Phase 20: the two "analysis" choices stored with a search. The backend
 * persists them (searches.website_analysis_requested /
 * ai_analysis_requested) and, once the search completes, the post-search
 * pipeline runs the requested analyses in the background for that
 * search's businesses (see SearchPipeline).
 */
export interface SearchAnalysisOptions {
  website_analysis: boolean;
  ai_analysis: boolean;
}

/**
 * A `searches` row as returned by GET /api/searches and as the `search`
 * object of POST /api/searches (server/lib/searchService.js
 * #toSearchRecord).
 *
 * The four Phase 20 fields are optional AND nullable on purpose: the
 * backend always sends them now, but rows created before migration
 * 007 carry no keyword / radius (NULL) and the defaults for the rest,
 * and older payloads / demo data omit them entirely. Readers must
 * treat "missing" and null the same way.
 */
export interface SearchRecord {
  id: string;
  search_query: string;
  category: string | null;
  location: string | null;
  /** Phase 20. NULL on rows created before the keyword was stored on its own. */
  keyword?: string | null;
  results_count: number;
  started_at: string;
  completed_at: string | null;
  status: SearchStatus;
  /** Phase 20. Metres. NULL = no radius was requested. */
  radius_meters?: number | null;
  /** Phase 20. 1..20; pre-Phase-20 searches always asked for 20. */
  max_results?: number | null;
  /** Phase 20. Both false on pre-Phase-20 rows. */
  analysis_options?: SearchAnalysisOptions | null;
  /**
   * Post-search pipeline state (migration 008). Missing on older
   * payloads and demo data; 'not_run' on searches that predate it.
   */
  pipeline?: SearchPipeline | null;
}

/**
 * Where the post-search pipeline stands for one search
 * (server/lib/searchPipelineService.js). 'running' is the state POST
 * /api/searches returns -- the pipeline finishes after the response.
 * 'interrupted' means the server restarted while it was running.
 */
export type SearchPipelineStatus =
  | 'not_run'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'interrupted';

/** One stage that failed for one business. `code` is a short error code, never raw error text. */
export interface SearchPipelineFailure {
  business_id: string;
  stage: 'website_check' | 'website_analysis' | 'ai_analysis' | 'lead_scoring' | 'pipeline';
  code: string;
}

/** Counts for a finished pipeline run. Null until it finishes. */
export interface SearchPipelineSummary {
  businesses_total: number;
  /** Of businesses_total, how many were already in the database before this search. */
  businesses_already_known?: number;
  /** Known businesses skipped entirely: everything requested was already done and they were already scored. */
  businesses_skipped?: number;
  website_checked: number;
  website_analyzed: number;
  website_analysis_skipped: number;
  ai_analyzed: number;
  scored: number;
  businesses_with_failures: number;
}

export interface SearchPipeline {
  status: SearchPipelineStatus;
  started_at: string | null;
  completed_at: string | null;
  summary: SearchPipelineSummary | null;
  failures: SearchPipelineFailure[];
}

/**
 * Phase 20: body of POST /api/searches. Only category and location are
 * required; every other field is optional and gets a backend default
 * (no radius, max_results 20, both analysis options off). The backend
 * validation (server/lib/validation.js#validateSearchConfiguration) is
 * authoritative -- the form validates the same limits only for UX.
 */
export interface SearchConfiguration {
  category: string;
  location: string;
  keyword?: string;
  /** Metres, 0 < r <= 50000 on the server (the form enforces 1..50000). null/omitted = no radius. */
  radius_meters?: number | null;
  /** Integer 1..20. */
  max_results?: number;
  analysis_options?: Partial<SearchAnalysisOptions>;
}

/**
 * Phase 7: request/response shapes for POST /api/searches (Google Places
 * business discovery). See server/routes/searches.js. Phase 20 extends
 * the request to a full SearchConfiguration.
 */
export type RunSearchInput = SearchConfiguration;

export interface DiscoveredBusiness extends Business {
  /** true if this business was newly inserted by this search; false if it already existed. */
  isNew: boolean;
}

/**
 * Phase 20: counts computed by the backend for one manual search
 * (server/lib/searchService.js). The frontend displays them as
 * returned and never derives its own.
 */
export interface SearchSummary {
  /** How many places Google returned before any radius filtering. */
  places_returned: number;
  /** Places dropped because they were outside the requested radius (0 when no radius). */
  excluded_outside_radius: number;
  /** Businesses actually kept and linked to the search (after the radius filter and max_results cap). */
  results_count: number;
}

export interface RunSearchResponse {
  search: SearchRecord;
  businesses: DiscoveredBusiness[];
  summary: SearchSummary;
}

export interface DashboardMetrics {
  totalBusinesses: number;
  totalLeads: number;
  businessesWithNoWebsite: number;
  websitesNeedingImprovement: number;
  highPriorityLeads: number;
  leadsContacted: number;
  leadsWon: number;
}

/**
 * Phase 21 Part 1: shape of the `metrics` object in GET /api/analytics
 * (server/lib/analytics.js#buildAnalyticsResponse). contacted_leads/
 * responses/meetings/proposals/won_deals are CURRENT-STAGE snapshots
 * of sales_pipeline.stage, not lifetime funnel totals -- see
 * server/lib/analytics.js's PIPELINE_STAGE_METRIC comment. The
 * frontend must not present them as cumulative counts or compute a
 * conversion rate from them (Phase 21 Part 2 spec, Step 9).
 */
export interface AnalyticsMetrics {
  businesses_discovered: number;
  no_website_businesses: number;
  poor_website_businesses: number;
  high_priority_leads: number;
  contacted_leads: number;
  responses: number;
  meetings: number;
  proposals: number;
  won_deals: number;
}

/**
 * Full response body of GET /api/analytics. The three breakdown
 * objects are deliberately Record<string, number> rather than a fixed
 * union of keys -- the backend returns exactly whatever its GROUP BY
 * query produced (see analyticsService.js's load*Breakdown functions),
 * so the frontend renders whatever keys are actually present instead
 * of assuming a fixed category list (AnalyticsPage.tsx).
 */
export interface AnalyticsData {
  metrics: AnalyticsMetrics;
  lead_priority_breakdown: Record<string, number>;
  pipeline_stage_breakdown: Record<string, number>;
  website_status_breakdown: Record<string, number>;
}

/**
 * Phase 13B1B: shapes for GET /api/leads/:id
 * (server/lib/leadDetailService.js#getLeadDetail). These are
 * deliberately narrower than some of the shared types above -- each
 * mirrors exactly the column list that leadDetailService.js selects,
 * not the full underlying table.
 */

/**
 * The `website_analysis` row leadDetailService.js loads
 * (loadLatestCompletedWebsiteAnalysis) -- a subset of the full
 * WebsiteAnalysis columns. Notably it does NOT select
 * html_size_bytes, error_code, or error_message, so those are not
 * part of this type; only ever a genuinely completed analysis is
 * returned here (see the service's SQL WHERE clause).
 */
export interface LeadDetailWebsiteAnalysis {
  id: string;
  business_id: string;
  analyzed_url: string;
  analyzed_at: string;
  performance_score: number | null;
  accessibility_score: number | null;
  seo_score: number | null;
  best_practices_score: number | null;
  mobile_indicator: string | null;
  https_enabled: boolean | null;
  page_title: string | null;
  meta_description: string | null;
  viewport_present: boolean | null;
  http_status: number | null;
  response_time_ms: number | null;
  analysis_status: WebsiteAnalysisStatus;
  created_at: string;
}

/**
 * The `ai_analysis` row leadDetailService.js loads
 * (loadLatestCompletedAiAnalysis) -- includes `sales_angle`, unlike
 * the shared AiAnalysis type above, and only ever a genuinely
 * completed analysis (see the service's SQL WHERE clause).
 */
/**
 * A single problem/opportunity entry as the AI opportunity analysis
 * actually returns it (server/lib/aiOpportunityAnalysis.js) -- an
 * object with a title, a description, and the verified-data evidence
 * backing it, not a plain string.
 */
export interface AiAnalysisFindingItem {
  title: string;
  description: string;
  evidence?: Array<{ field: string; value: string | number | boolean }> | null;
}

export interface LeadDetailAiAnalysis {
  id: string;
  business_id: string;
  summary: string | null;
  problems: AiAnalysisFindingItem[] | null;
  opportunities: AiAnalysisFindingItem[] | null;
  recommended_service: string | null;
  reasoning: string | null;
  sales_angle: string | null;
  confidence: number | null;
  ai_model: string | null;
  created_at: string;
}

/** leadDetailService.js's `scoring` sub-object -- lead_score/priority/scoring_factors/scored_at, duplicated from the lead row for convenience. */
export interface LeadDetailScoring {
  lead_score: number | null;
  priority: LeadPriority;
  scoring_factors: ScoringFactor[] | null;
  scored_at: string | null;
}

/**
 * Matches the sales_pipeline.stage CHECK constraint in
 * migrations/006_pipeline_stage_realignment.sql -- a different, newer
 * vocabulary than the existing `PipelineStage` type above (which
 * predates that migration).
 */
export type LeadPipelineStage =
  | 'new'
  | 'researched'
  | 'contacted'
  | 'responded'
  | 'meeting'
  | 'proposal'
  | 'won'
  | 'lost';

/**
 * leadDetailService.js's `pipeline` sub-object. When a lead has never
 * had its pipeline stage set, this is a virtual, never-persisted
 * default (id/created_at/updated_at all null, stage 'new') rather
 * than a missing section -- see virtualDefaultPipeline in the
 * service.
 */
export interface LeadDetailPipeline {
  id: string | null;
  lead_id: string;
  stage: LeadPipelineStage;
  contacted_at: string | null;
  response_at: string | null;
  meeting_at: string | null;
  proposal_at: string | null;
  won_at: string | null;
  lost_at: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Full response body of GET /api/leads/:id. */
export interface LeadDetailResponse {
  lead: Lead;
  business: Business;
  website_analysis: LeadDetailWebsiteAnalysis | null;
  ai_analysis: LeadDetailAiAnalysis | null;
  scoring: LeadDetailScoring;
  pipeline: LeadDetailPipeline;
  /** Optional so an older server (or a response without it) simply shows no contact panel. */
  contacts?: LeadContacts;
}

/**
 * Phase 19 Part 1: shapes for GET /api/leads/:id/intelligence
 * (server/lib/salesIntelligenceService.js#getSalesIntelligence). The
 * whole point of this endpoint is that these three things are never
 * merged into one list -- a VerifiedObservation is a deterministic
 * fact, an AiInterpretationItem is the model's (already
 * anti-hallucination-filtered) reading of those facts, and a
 * ServiceMatch is a potential resulting service recommendation.
 */

/**
 * A single deterministic fact pulled straight from businesses /
 * website_analysis -- never AI-generated. `source` names where it was
 * actually measured: 'business_record' for a plain `businesses`
 * column, 'website_analyzer' for anything that only exists once a
 * website_analysis row has been produced.
 */
export interface VerifiedObservation {
  fact: string;
  source: 'business_record' | 'website_analyzer';
}

/**
 * One AI-generated problem or opportunity from the latest COMPLETED
 * ai_analysis row, explicitly labeled and kept separate from
 * VerifiedObservation. `service` is only ever set on an 'opportunity'
 * item, matching one of aiOpportunityAnalysis.js's ALLOWED_SERVICES.
 * `evidence` is carried through unchanged from the underlying
 * problem/opportunity (see AiAnalysisFindingItem above) so the
 * interpretation stays traceable to the verified fields it cites.
 */
export interface AiInterpretationItem {
  type: 'problem' | 'opportunity';
  interpretation: string;
  service: string | null;
  evidence: Array<{ field: string; value: string | number | boolean }>;
}

/**
 * High/medium/low bucket of ai_analysis.confidence (0-100 integer);
 * see salesIntelligenceService.js#bucketConfidence. Applies only to AI
 * interpretation/service match -- a VerifiedObservation has no
 * confidence, it's either measured or it isn't.
 */
export type SalesIntelligenceConfidence = 'high' | 'medium' | 'low';

/**
 * A potential Alvin Solutions service match. `service` is null when
 * the verified evidence didn't support recommending a specific
 * service -- `reason` is still populated in that case, explaining why,
 * per the Phase 19 Part 1 spec's "no forced recommendations" rule.
 */
export interface ServiceMatch {
  service: string | null;
  reason: string | null;
  confidence: SalesIntelligenceConfidence | null;
}

/** Full response body of GET /api/leads/:id/intelligence. */
export interface SalesIntelligenceResponse {
  lead_id: string;
  business_id: string;
  /** Whether a completed ai_analysis row exists yet for this lead's business. */
  has_analysis: boolean;
  verified_observations: VerifiedObservation[];
  ai_interpretation: AiInterpretationItem[];
  service_match: ServiceMatch | null;
  /** Short explanation of why the lead may be relevant (ai_analysis.sales_angle, falling back to .summary). */
  relevance_summary: string | null;
  ai_model: string | null;
  analyzed_at: string | null;
}
