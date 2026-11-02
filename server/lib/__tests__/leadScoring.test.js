const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priorityForScore,
  scoreWebsitePresence,
  scorePerformance,
  scoreMobileExperience,
  scoreSeo,
  scoreAccessibility,
  scoreFit,
  scoreReviews,
  calculateLeadScore,
} = require('../leadScoring');

/** A fully "clean" input: reachable, top scores everywhere, no reviews. Total = 0. */
function baseInput(overrides = {}) {
  return {
    websiteStatus: 'reachable',
    performanceScore: 100,
    seoScore: 100,
    accessibilityScore: 100,
    viewportPresent: true,
    googleReviewCount: 0,
    ...overrides,
  };
}

function factorPoints(result, code) {
  const f = result.factors.find((x) => x.code === code);
  return f ? f.points : undefined;
}

function sumPoints(result) {
  return result.factors.reduce((sum, f) => sum + f.points, 0);
}

// ---------------------------------------------------------------------
// 1-4. Website presence
// ---------------------------------------------------------------------

test('1. No website -> +25', () => {
  const f = scoreWebsitePresence('no_website');
  assert.equal(f.points, 25);
  assert.equal(f.code, 'no_website');
});

test('2. Unreachable website -> +20', () => {
  const f = scoreWebsitePresence('unreachable');
  assert.equal(f.points, 20);
  assert.equal(f.code, 'unreachable_website');
});

test('3. Reachable website -> +0', () => {
  const f = scoreWebsitePresence('reachable');
  assert.equal(f.points, 0);
  assert.equal(f.code, 'reachable_website');
});

test('4. Unknown website status -> +10', () => {
  const f = scoreWebsitePresence('unknown');
  assert.equal(f.points, 10);
  assert.equal(f.code, 'unknown_website_status');
});

test('Website presence: no_website and unreachable are mutually exclusive (single status in, single factor out)', () => {
  // website_status is a single column; there is no code path that can
  // produce both a no_website AND an unreachable factor for one score.
  const result = calculateLeadScore(baseInput({ websiteStatus: 'no_website' }));
  const websiteFactors = result.factors.filter((f) => f.code === 'no_website' || f.code === 'unreachable_website');
  assert.equal(websiteFactors.length, 1);
});

// ---------------------------------------------------------------------
// 5-10. Performance boundaries
// ---------------------------------------------------------------------

test('5. Performance 49 -> +20', () => assert.equal(scorePerformance(49).points, 20));
test('6. Performance 50 -> +15', () => assert.equal(scorePerformance(50).points, 15));
test('7. Performance 69 -> +15', () => assert.equal(scorePerformance(69).points, 15));
test('8. Performance 70 -> +8', () => assert.equal(scorePerformance(70).points, 8));
test('9. Performance 84 -> +8', () => assert.equal(scorePerformance(84).points, 8));
test('10. Performance 85 -> +0', () => assert.equal(scorePerformance(85).points, 0));
test('Performance 100 -> +0', () => assert.equal(scorePerformance(100).points, 0));
test('Performance 0 -> +20', () => assert.equal(scorePerformance(0).points, 20));

// ---------------------------------------------------------------------
// 11. SEO boundary values
// ---------------------------------------------------------------------

test('11. SEO boundaries: 49/50/69/70/84/85', () => {
  assert.equal(scoreSeo(49).points, 15);
  assert.equal(scoreSeo(50).points, 10);
  assert.equal(scoreSeo(69).points, 10);
  assert.equal(scoreSeo(70).points, 5);
  assert.equal(scoreSeo(84).points, 5);
  assert.equal(scoreSeo(85).points, 0);
});

// ---------------------------------------------------------------------
// 12. Accessibility boundary values
// ---------------------------------------------------------------------

test('12. Accessibility boundaries: 49/50/69/70/84/85', () => {
  assert.equal(scoreAccessibility(49).points, 10);
  assert.equal(scoreAccessibility(50).points, 7);
  assert.equal(scoreAccessibility(69).points, 7);
  assert.equal(scoreAccessibility(70).points, 4);
  assert.equal(scoreAccessibility(84).points, 4);
  assert.equal(scoreAccessibility(85).points, 0);
});

// ---------------------------------------------------------------------
// 13. Mobile boundary values
// ---------------------------------------------------------------------

test('13. Mobile: viewport missing (false) -> +15', () => {
  const f = scoreMobileExperience(false);
  assert.equal(f.points, 15);
  assert.equal(f.code, 'missing_viewport');
});

test('13. Mobile: viewport present (true) -> +0, and does not reuse performance_score', () => {
  const f = scoreMobileExperience(true);
  assert.equal(f.points, 0);
  assert.equal(f.code, 'viewport_present');
});

test('13. Mobile: unknown (null) -> +0, never assumed to be a problem', () => {
  const f = scoreMobileExperience(null);
  assert.equal(f.points, 0);
  assert.equal(f.code, 'mobile_experience_unknown');
});

test('Mobile factor never double-counts a poor performance_score as a mobile problem', () => {
  // Even with a terrible performance score, viewport present -> mobile factor is 0.
  const result = calculateLeadScore(baseInput({ performanceScore: 10, viewportPresent: true }));
  assert.equal(factorPoints(result, 'viewport_present'), 0);
  // Performance factor alone accounts for the poor score.
  assert.equal(factorPoints(result, 'poor_performance'), 20);
});

// ---------------------------------------------------------------------
// 14 & 15. Review count boundaries + no review count
// ---------------------------------------------------------------------

test('14. Review count boundaries', () => {
  assert.equal(scoreReviews(0).points, 0);
  assert.equal(scoreReviews(1).points, 1);
  assert.equal(scoreReviews(20).points, 1);
  assert.equal(scoreReviews(21).points, 2);
  assert.equal(scoreReviews(50).points, 2);
  assert.equal(scoreReviews(51).points, 3);
  assert.equal(scoreReviews(100).points, 3);
  assert.equal(scoreReviews(101).points, 4);
  assert.equal(scoreReviews(250).points, 4);
  assert.equal(scoreReviews(251).points, 5);
  assert.equal(scoreReviews(1000).points, 5);
});

test('15. No review count on file -> treated as 0 reviews, +0 (never invented)', () => {
  const f = scoreReviews(null);
  assert.equal(f.points, 0);
  assert.equal(f.code, 'no_reviews');
  assert.match(f.reason, /No Google review count is on file/);
});

// ---------------------------------------------------------------------
// 16-19. Missing data cases
// ---------------------------------------------------------------------

test('16. Missing website analysis entirely -> performance/seo/accessibility/mobile all "unknown", 0 points each', () => {
  const result = calculateLeadScore({
    websiteStatus: 'reachable',
    performanceScore: null,
    seoScore: null,
    accessibilityScore: null,
    viewportPresent: null,
    googleReviewCount: null,
  });
  assert.equal(factorPoints(result, 'performance_unknown'), 0);
  assert.equal(factorPoints(result, 'seo_unknown'), 0);
  assert.equal(factorPoints(result, 'accessibility_unknown'), 0);
  assert.equal(factorPoints(result, 'mobile_experience_unknown'), 0);
  assert.equal(result.score, 0);
});

test('17. Missing mobile data (viewport null) does not invent a mobile problem', () => {
  const f = scoreMobileExperience(undefined);
  assert.equal(f.points, 0);
});

test('18. Missing SEO data (null) -> +0, not treated as 0/100', () => {
  const f = scoreSeo(null);
  assert.equal(f.points, 0);
  assert.equal(f.code, 'seo_unknown');
});

test('19. Missing accessibility data (null) -> +0, not treated as 0/100', () => {
  const f = scoreAccessibility(null);
  assert.equal(f.points, 0);
  assert.equal(f.code, 'accessibility_unknown');
});

test('Missing performance data (null) is distinguished from a real 0 score', () => {
  const missing = scorePerformance(null);
  const zero = scorePerformance(0);
  assert.equal(missing.points, 0);
  assert.equal(zero.points, 20);
  assert.notEqual(missing.code, zero.code);
});

// ---------------------------------------------------------------------
// 20-23. Score bounds
// ---------------------------------------------------------------------

test('20. Maximum possible score = 100', () => {
  const result = calculateLeadScore({
    websiteStatus: 'no_website',
    performanceScore: 0,
    seoScore: 0,
    accessibilityScore: 0,
    viewportPresent: false,
    googleReviewCount: 300,
  });
  assert.equal(result.score, 100);
  assert.equal(result.priority, 'very_high');
});

test('21. Minimum possible score = 0', () => {
  const result = calculateLeadScore(baseInput());
  assert.equal(result.score, 0);
  assert.equal(result.priority, 'low');
});

test('22. Score never exceeds 100 even given implausible/out-of-range input', () => {
  const result = calculateLeadScore({
    websiteStatus: 'no_website',
    performanceScore: -999,
    seoScore: -999,
    accessibilityScore: -999,
    viewportPresent: false,
    googleReviewCount: 999999,
  });
  assert.ok(result.score <= 100);
});

test('23. Score never falls below 0', () => {
  const result = calculateLeadScore({
    websiteStatus: 'reachable',
    performanceScore: 500,
    seoScore: 500,
    accessibilityScore: 500,
    viewportPresent: true,
    googleReviewCount: 0,
  });
  assert.ok(result.score >= 0);
});

// ---------------------------------------------------------------------
// 24-26. Priority boundaries
// ---------------------------------------------------------------------

test('24. Priority boundary 24/25: low vs medium', () => {
  assert.equal(priorityForScore(24), 'low');
  assert.equal(priorityForScore(25), 'medium');
});

test('25. Priority boundary 49/50: medium vs high', () => {
  assert.equal(priorityForScore(49), 'medium');
  assert.equal(priorityForScore(50), 'high');
});

test('26. Priority boundary 74/75: high vs very_high', () => {
  assert.equal(priorityForScore(74), 'high');
  assert.equal(priorityForScore(75), 'very_high');
});

test('Priority boundary 0/100 sanity', () => {
  assert.equal(priorityForScore(0), 'low');
  assert.equal(priorityForScore(100), 'very_high');
});

// ---------------------------------------------------------------------
// 27. Determinism
// ---------------------------------------------------------------------

test('27. Same input produces an identical score every time (no randomness, no clock dependence)', () => {
  const input = baseInput({ websiteStatus: 'unreachable', performanceScore: 65, seoScore: 92, googleReviewCount: 129 });
  const results = Array.from({ length: 20 }, () => calculateLeadScore(input));
  const first = JSON.stringify(results[0]);
  for (const r of results) {
    assert.equal(JSON.stringify(r), first);
  }
});

// ---------------------------------------------------------------------
// 28. AI analysis never influences the score
// ---------------------------------------------------------------------

test('28. Unrelated/AI-shaped fields on the input object are ignored -- the engine only reads its documented input keys', () => {
  const clean = calculateLeadScore(baseInput());
  const withAiNoise = calculateLeadScore({
    ...baseInput(),
    recommended_service: 'new_website',
    confidence: 99,
    ai_opportunity_score: 100,
    sales_angle: 'This business desperately needs help!',
  });
  assert.equal(withAiNoise.score, clean.score);
  assert.deepEqual(withAiNoise.factors, clean.factors);
});

test('leadScoring.js has no dependency on aiOpportunityAnalysis.js', () => {
  const path = require.resolve('../leadScoring.js');
  delete require.cache[path];
  const Module = require('node:module');
  const originalLoad = Module._load;
  const requiredPaths = [];
  Module._load = function (request, parent, isMain) {
    requiredPaths.push(request);
    return originalLoad.apply(this, arguments);
  };
  try {
    require('../leadScoring.js');
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(
    !requiredPaths.some((p) => p.includes('aiOpportunityAnalysis')),
    'leadScoring.js must never require aiOpportunityAnalysis.js'
  );
});

// ---------------------------------------------------------------------
// 30. Factors explain the score
// ---------------------------------------------------------------------

test('30. Factors always sum exactly to the returned score (for in-range inputs)', () => {
  const cases = [
    baseInput(),
    baseInput({ websiteStatus: 'no_website' }),
    baseInput({ websiteStatus: 'unreachable', performanceScore: 40, seoScore: 60, accessibilityScore: 90, viewportPresent: false, googleReviewCount: 40 }),
    baseInput({ websiteStatus: 'unknown', performanceScore: null, seoScore: null, accessibilityScore: null, viewportPresent: null, googleReviewCount: null }),
  ];
  for (const input of cases) {
    const result = calculateLeadScore(input);
    assert.equal(sumPoints(result), result.score, `factors should sum to score for input ${JSON.stringify(input)}`);
  }
});

test('30. Every factor object exposes code/label/points/reason', () => {
  const result = calculateLeadScore(baseInput({ websiteStatus: 'unreachable', performanceScore: 65 }));
  for (const f of result.factors) {
    assert.equal(typeof f.code, 'string');
    assert.equal(typeof f.label, 'string');
    assert.equal(typeof f.points, 'number');
    assert.equal(typeof f.reason, 'string');
    assert.ok(f.reason.length > 0);
  }
});

// ---------------------------------------------------------------------
// Fit factor (F) -- deterministic, evidence-based only
// ---------------------------------------------------------------------

test('Fit: no website -> clear_fit +10', () => {
  const f = scoreFit({ websiteStatus: 'no_website', performancePoints: 0, seoPoints: 0, accessibilityPoints: 0, mobilePoints: 0 });
  assert.equal(f.points, 10);
  assert.equal(f.code, 'clear_fit');
});

test('Fit: unreachable website -> clear_fit +10', () => {
  const f = scoreFit({ websiteStatus: 'unreachable', performancePoints: 0, seoPoints: 0, accessibilityPoints: 0, mobilePoints: 0 });
  assert.equal(f.points, 10);
});

test('Fit: poor performance alone -> clear_fit +10', () => {
  const f = scoreFit({ websiteStatus: 'reachable', performancePoints: 20, seoPoints: 0, accessibilityPoints: 0, mobilePoints: 0 });
  assert.equal(f.points, 10);
});

test('Fit: unknown website status ALONE does not trigger fit', () => {
  const f = scoreFit({ websiteStatus: 'unknown', performancePoints: 0, seoPoints: 0, accessibilityPoints: 0, mobilePoints: 0 });
  assert.equal(f.points, 0);
  assert.equal(f.code, 'no_clear_fit');
});

test('Fit: everything strong -> no_clear_fit +0', () => {
  const f = scoreFit({ websiteStatus: 'reachable', performancePoints: 0, seoPoints: 0, accessibilityPoints: 0, mobilePoints: 0 });
  assert.equal(f.points, 0);
  assert.equal(f.code, 'no_clear_fit');
});

// ---------------------------------------------------------------------
// Realistic end-to-end example (matches docs/lead-scoring.md)
// ---------------------------------------------------------------------

test('Realistic example: unreachable + moderate scores + established reviews', () => {
  const result = calculateLeadScore({
    websiteStatus: 'unreachable',
    performanceScore: 65,
    seoScore: 92,
    accessibilityScore: 78,
    viewportPresent: true,
    googleReviewCount: 129,
  });
  // unreachable(20) + below_average_performance(15) + viewport_present(0)
  // + strong_seo(0) + moderate_accessibility(4) + clear_fit(10) + established_reviews(4) = 53
  assert.equal(result.score, 53);
  assert.equal(result.priority, 'high');
});
