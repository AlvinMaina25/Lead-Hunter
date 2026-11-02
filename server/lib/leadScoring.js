/**
 * Deterministic Lead Scoring Engine (Phase 12).
 *
 * This module is pure: no database access, no network access, no AI/
 * LLM calls of any kind. Given the same verified input, it always
 * returns the same output -- no randomness, no clocks, no external
 * state. server/lib/leadScoringService.js is the only thing that
 * loads real data (from Neon) and calls into this module; keeping the
 * two separate is what makes the scoring RULES independently testable
 * from the data-loading plumbing.
 *
 * See docs/lead-scoring.md for the full human-readable rulebook this
 * file implements. The two must be kept in sync.
 *
 * IMPORTANT: this module must never import or call anything related to
 * Gemini/AI opportunity analysis. AI output (recommended_service,
 * opportunities, confidence, ...) is sales intelligence displayed
 * ALONGSIDE the score, never an input to it.
 */

'use strict';

// ---------------------------------------------------------------------
// Priority thresholds (Section 5 of the Phase 12 spec)
// ---------------------------------------------------------------------

/**
 * Ordered low -> high. Each entry's `max` is inclusive. Values use the
 * codebase's existing lowercase snake_case enum convention (compare
 * website_status, lead_status, recommended_service); "Very High" style
 * capitalization is a presentation-layer concern for the frontend.
 */
const PRIORITY_THRESHOLDS = Object.freeze([
  { max: 24, priority: 'low' },
  { max: 49, priority: 'medium' },
  { max: 74, priority: 'high' },
  { max: 100, priority: 'very_high' },
]);

/**
 * @param {number} score - already clamped to [0, 100]
 * @returns {'low'|'medium'|'high'|'very_high'}
 */
function priorityForScore(score) {
  for (const tier of PRIORITY_THRESHOLDS) {
    if (score <= tier.max) return tier.priority;
  }
  // Unreachable given the clamp in calculateLeadScore, but keeps this
  // function total/safe if ever called directly with a bad value.
  return 'very_high';
}

// ---------------------------------------------------------------------
// Small shared helper: threshold ladders used by B/D/E (Performance,
// SEO, Accessibility all share the exact same 0-49/50-69/70-84/85-100
// shape from the spec, just with different point values).
// ---------------------------------------------------------------------

/**
 * @param {number} value - a 0-100 score
 * @param {[number, number][]} tiers - ascending [inclusiveMax, points] pairs;
 *   the last tier's max should be 100.
 * @returns {number} points for the tier `value` falls into
 */
function tieredPoints(value, tiers) {
  for (const [max, points] of tiers) {
    if (value <= max) return points;
  }
  return tiers[tiers.length - 1][1];
}

const PERFORMANCE_TIERS = [[49, 20], [69, 15], [84, 8], [100, 0]];
const SEO_TIERS = [[49, 15], [69, 10], [84, 5], [100, 0]];
const ACCESSIBILITY_TIERS = [[49, 10], [69, 7], [84, 4], [100, 0]];

// ---------------------------------------------------------------------
// A. Website presence -- MAX 25
// ---------------------------------------------------------------------

/**
 * @param {'no_website'|'reachable'|'unreachable'|'unknown'|null|undefined} websiteStatus
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreWebsitePresence(websiteStatus) {
  switch (websiteStatus) {
    case 'no_website':
      return {
        code: 'no_website',
        label: 'No website on file',
        points: 25,
        reason: 'Verified business record has no stored website_url.',
      };
    case 'unreachable':
      return {
        code: 'unreachable_website',
        label: 'Website unreachable',
        points: 20,
        reason: 'Verified website_status is "unreachable".',
      };
    case 'reachable':
      return {
        code: 'reachable_website',
        label: 'Website is reachable',
        points: 0,
        reason: 'Verified website_status is "reachable".',
      };
    case 'unknown':
    default:
      return {
        code: 'unknown_website_status',
        label: 'Website status unknown',
        points: 10,
        reason: 'Verified website_status is "unknown" (not yet checked, or check inconclusive).',
      };
  }
}

// ---------------------------------------------------------------------
// B. Performance -- MAX 20
// ---------------------------------------------------------------------

/**
 * @param {number|null|undefined} performanceScore - from the latest
 *   COMPLETED website_analysis row (null when no such score exists --
 *   never treated as 0).
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scorePerformance(performanceScore) {
  if (performanceScore === null || performanceScore === undefined) {
    return {
      code: 'performance_unknown',
      label: 'No verified performance score',
      points: 0,
      reason: 'No completed website performance score is on file.',
    };
  }

  const points = tieredPoints(performanceScore, PERFORMANCE_TIERS);
  const codeByPoints = { 20: 'poor_performance', 15: 'below_average_performance', 8: 'moderate_performance', 0: 'strong_performance' };
  const labelByPoints = {
    20: 'Poor website performance',
    15: 'Below-average website performance',
    8: 'Moderate website performance',
    0: 'Strong website performance',
  };
  return {
    code: codeByPoints[points],
    label: labelByPoints[points],
    points,
    reason: `Verified performance score is ${performanceScore}/100.`,
  };
}

// ---------------------------------------------------------------------
// C. Mobile experience -- MAX 15
// ---------------------------------------------------------------------

/**
 * The schema's only mobile-specific, non-performance signal is
 * `viewport_present` (whether a homepage <meta name="viewport"> tag was
 * found). `performance_score` is already the MOBILE Lighthouse score
 * (server/lib/pagespeedInsights.js requests strategy "mobile" by
 * default, and `mobile_indicator` records that same strategy string --
 * it is not a distinct "mobile problem" flag), and it is already fully
 * credited under the Performance factor above. Re-using it here would
 * double-count the exact same measurement under two different factor
 * labels, which the spec explicitly forbids -- so this factor
 * deliberately never looks at performance_score at all.
 *
 * @param {boolean|null|undefined} viewportPresent - from the latest
 *   COMPLETED website_analysis row.
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreMobileExperience(viewportPresent) {
  if (viewportPresent === false) {
    return {
      code: 'missing_viewport',
      label: 'Missing mobile viewport tag',
      points: 15,
      reason: 'Verified homepage analysis found no <meta name="viewport"> tag.',
    };
  }

  if (viewportPresent === true) {
    return {
      code: 'viewport_present',
      label: 'Mobile viewport tag present',
      points: 0,
      reason:
        'Verified homepage analysis found a viewport tag. (The site\'s mobile performance score is the same measurement already credited under "Performance" -- not double-counted here.)',
    };
  }

  return {
    code: 'mobile_experience_unknown',
    label: 'No verified mobile data',
    points: 0,
    reason: 'No completed website analysis with viewport information is on file.',
  };
}

// ---------------------------------------------------------------------
// D. SEO -- MAX 15
// ---------------------------------------------------------------------

/**
 * @param {number|null|undefined} seoScore - from the latest COMPLETED
 *   website_analysis row.
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreSeo(seoScore) {
  if (seoScore === null || seoScore === undefined) {
    return {
      code: 'seo_unknown',
      label: 'No verified SEO score',
      points: 0,
      reason: 'No completed SEO score is on file.',
    };
  }

  const points = tieredPoints(seoScore, SEO_TIERS);
  const codeByPoints = { 15: 'poor_seo', 10: 'below_average_seo', 5: 'moderate_seo', 0: 'strong_seo' };
  const labelByPoints = {
    15: 'Poor SEO score',
    10: 'Below-average SEO score',
    5: 'Moderate SEO score',
    0: 'Strong SEO score',
  };
  return {
    code: codeByPoints[points],
    label: labelByPoints[points],
    points,
    reason: `Verified SEO score is ${seoScore}/100.`,
  };
}

// ---------------------------------------------------------------------
// E. Accessibility -- MAX 10
// ---------------------------------------------------------------------

/**
 * @param {number|null|undefined} accessibilityScore - from the latest
 *   COMPLETED website_analysis row.
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreAccessibility(accessibilityScore) {
  if (accessibilityScore === null || accessibilityScore === undefined) {
    return {
      code: 'accessibility_unknown',
      label: 'No verified accessibility score',
      points: 0,
      reason: 'No completed accessibility score is on file.',
    };
  }

  const points = tieredPoints(accessibilityScore, ACCESSIBILITY_TIERS);
  const codeByPoints = { 10: 'poor_accessibility', 7: 'below_average_accessibility', 4: 'moderate_accessibility', 0: 'strong_accessibility' };
  const labelByPoints = {
    10: 'Poor accessibility score',
    7: 'Below-average accessibility score',
    4: 'Moderate accessibility score',
    0: 'Strong accessibility score',
  };
  return {
    code: codeByPoints[points],
    label: labelByPoints[points],
    points,
    reason: `Verified accessibility score is ${accessibilityScore}/100.`,
  };
}

// ---------------------------------------------------------------------
// F. Clear fit for Alvin Solutions -- MAX 10
// ---------------------------------------------------------------------

/**
 * Deterministic, evidence-based only -- never asks AI, never uses
 * subjective judgment. Triggered by ANY confirmed, objectively-measured
 * weakness already established by factors A-E above: a missing/
 * unreachable website, or a sub-85 performance/SEO/accessibility score,
 * or a missing viewport tag. Deliberately does NOT trigger on
 * website_status === 'unknown' alone (factor A), since "we haven't
 * checked yet" is not itself a confirmed weakness the way "no website"
 * or "unreachable" are.
 *
 * @param {{
 *   websiteStatus: string|null|undefined,
 *   performancePoints: number,
 *   seoPoints: number,
 *   accessibilityPoints: number,
 *   mobilePoints: number,
 * }} signals
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreFit(signals) {
  const reasons = [];
  if (signals.websiteStatus === 'no_website') reasons.push('no website on file');
  if (signals.websiteStatus === 'unreachable') reasons.push('website is unreachable');
  if (signals.performancePoints > 0) reasons.push('sub-par verified performance score');
  if (signals.seoPoints > 0) reasons.push('sub-par verified SEO score');
  if (signals.accessibilityPoints > 0) reasons.push('sub-par verified accessibility score');
  if (signals.mobilePoints > 0) reasons.push('missing mobile viewport tag');

  if (reasons.length === 0) {
    return {
      code: 'no_clear_fit',
      label: 'No objectively-confirmed service opportunity',
      points: 0,
      reason: 'No verified technical weakness (website presence, performance, SEO, accessibility, or mobile viewport) was found.',
    };
  }

  return {
    code: 'clear_fit',
    label: 'Clear fit for Alvin Solutions',
    points: 10,
    reason: `At least one verified technical weakness supports a service opportunity: ${reasons.join('; ')}.`,
  };
}

// ---------------------------------------------------------------------
// G. Business presence / reviews -- MAX 5
// ---------------------------------------------------------------------

const REVIEW_TIERS = [[0, 0], [20, 1], [50, 2], [100, 3], [250, 4], [Infinity, 5]];

/**
 * Business-presence signal only -- never interpreted as revenue,
 * quality, or buying intent.
 *
 * @param {number|null|undefined} googleReviewCount
 * @returns {{code: string, label: string, points: number, reason: string}}
 */
function scoreReviews(googleReviewCount) {
  const count = googleReviewCount === null || googleReviewCount === undefined ? 0 : Number(googleReviewCount);
  const points = tieredPoints(count, REVIEW_TIERS.map(([max, pts]) => [max, pts]));

  if (points === 0) {
    return {
      code: 'no_reviews',
      label: 'No Google reviews',
      points: 0,
      reason:
        googleReviewCount === null || googleReviewCount === undefined
          ? 'No Google review count is on file.'
          : 'Business has 0 Google reviews.',
    };
  }

  return {
    code: 'established_reviews',
    label: 'Established Google presence',
    points,
    reason: `Business has ${count} Google reviews.`,
  };
}

// ---------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------

/**
 * @typedef {Object} LeadScoringInput
 * @property {'no_website'|'reachable'|'unreachable'|'unknown'|null} websiteStatus
 *   - businesses.website_status, verbatim.
 * @property {number|null} performanceScore - website_analysis.performance_score
 *   from the latest analysis_status = 'completed' row, or null if none.
 * @property {number|null} seoScore - website_analysis.seo_score, same rule.
 * @property {number|null} accessibilityScore - website_analysis.accessibility_score, same rule.
 * @property {boolean|null} viewportPresent - website_analysis.viewport_present, same rule.
 * @property {number|null} googleReviewCount - businesses.google_review_count, verbatim.
 *
 * @typedef {Object} ScoringFactor
 * @property {string} code
 * @property {string} label
 * @property {number} points
 * @property {string} reason
 *
 * @typedef {Object} LeadScoringResult
 * @property {number} score - integer, clamped to [0, 100]
 * @property {'low'|'medium'|'high'|'very_high'} priority
 * @property {ScoringFactor[]} factors
 */

/**
 * Calculates a deterministic 0-100 lead score from verified input only.
 * Same input always produces the same output: no randomness, no
 * clock/date dependence, no I/O, no AI/LLM call of any kind.
 *
 * @param {LeadScoringInput} input
 * @returns {LeadScoringResult}
 */
function calculateLeadScore(input = {}) {
  const websitePresence = scoreWebsitePresence(input.websiteStatus);
  const performance = scorePerformance(input.performanceScore);
  const mobile = scoreMobileExperience(input.viewportPresent);
  const seo = scoreSeo(input.seoScore);
  const accessibility = scoreAccessibility(input.accessibilityScore);
  const fit = scoreFit({
    websiteStatus: input.websiteStatus,
    performancePoints: performance.points,
    seoPoints: seo.points,
    accessibilityPoints: accessibility.points,
    mobilePoints: mobile.points,
  });
  const reviews = scoreReviews(input.googleReviewCount);

  const factors = [websitePresence, performance, mobile, seo, accessibility, fit, reviews];

  const rawTotal = factors.reduce((sum, f) => sum + f.points, 0);
  // Defensive clamp -- the tiers above can never actually produce a
  // total outside [0, 100] given MAX 25+20+15+15+10+10+5 = 100, but the
  // spec requires this be enforced explicitly and unconditionally.
  const score = Math.max(0, Math.min(100, Math.round(rawTotal)));

  return {
    score,
    priority: priorityForScore(score),
    factors,
  };
}

module.exports = {
  PRIORITY_THRESHOLDS,
  priorityForScore,
  scoreWebsitePresence,
  scorePerformance,
  scoreMobileExperience,
  scoreSeo,
  scoreAccessibility,
  scoreFit,
  scoreReviews,
  calculateLeadScore,
};
