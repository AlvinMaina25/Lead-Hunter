const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HIGH_PRIORITY_VALUES,
  POOR_SCORE_MAX,
  isPoorWebsiteAnalysis,
  countHighPriorityLeads,
  countPipelineFunnelMetrics,
  buildAnalyticsResponse,
} = require('../analytics');

// ---------------------------------------------------------------------
// isPoorWebsiteAnalysis (poor_website_businesses definition)
// ---------------------------------------------------------------------

test('isPoorWebsiteAnalysis: null/undefined (no completed analysis) is never poor', () => {
  assert.equal(isPoorWebsiteAnalysis(null), false);
  assert.equal(isPoorWebsiteAnalysis(undefined), false);
});

test('isPoorWebsiteAnalysis: all scores comfortably above the threshold is not poor', () => {
  assert.equal(
    isPoorWebsiteAnalysis({ performance_score: 90, seo_score: 85, accessibility_score: 95, best_practices_score: 80 }),
    false
  );
});

test('isPoorWebsiteAnalysis: a single score at or below the threshold is poor', () => {
  assert.equal(
    isPoorWebsiteAnalysis({ performance_score: POOR_SCORE_MAX, seo_score: 90, accessibility_score: 90, best_practices_score: 90 }),
    true
  );
});

test('isPoorWebsiteAnalysis: threshold boundary is inclusive at 49, exclusive at 50', () => {
  assert.equal(isPoorWebsiteAnalysis({ performance_score: 49, seo_score: null, accessibility_score: null, best_practices_score: null }), true);
  assert.equal(isPoorWebsiteAnalysis({ performance_score: 50, seo_score: null, accessibility_score: null, best_practices_score: null }), false);
});

test('isPoorWebsiteAnalysis: each of the four score fields can independently trigger poor', () => {
  assert.equal(isPoorWebsiteAnalysis({ performance_score: 10, seo_score: null, accessibility_score: null, best_practices_score: null }), true);
  assert.equal(isPoorWebsiteAnalysis({ performance_score: null, seo_score: 10, accessibility_score: null, best_practices_score: null }), true);
  assert.equal(isPoorWebsiteAnalysis({ performance_score: null, seo_score: null, accessibility_score: 10, best_practices_score: null }), true);
  assert.equal(isPoorWebsiteAnalysis({ performance_score: null, seo_score: null, accessibility_score: null, best_practices_score: 10 }), true);
});

test('isPoorWebsiteAnalysis: a completed analysis with every score NULL (PageSpeed failure) is not poor', () => {
  assert.equal(
    isPoorWebsiteAnalysis({ performance_score: null, seo_score: null, accessibility_score: null, best_practices_score: null }),
    false
  );
});

// ---------------------------------------------------------------------
// countHighPriorityLeads (high_priority_leads definition)
// ---------------------------------------------------------------------

test('countHighPriorityLeads: sums high and very_high, ignores low and medium', () => {
  const breakdown = [
    { priority: 'low', count: 20 },
    { priority: 'medium', count: 15 },
    { priority: 'high', count: 8 },
    { priority: 'very_high', count: 6 },
  ];
  assert.equal(countHighPriorityLeads(breakdown), 14);
});

test('countHighPriorityLeads: an unknown/retired priority value (e.g. legacy "urgent") is never counted', () => {
  const breakdown = [
    { priority: 'high', count: 3 },
    { priority: 'urgent', count: 100 },
  ];
  assert.equal(countHighPriorityLeads(breakdown), 3);
});

test('countHighPriorityLeads: empty breakdown is zero', () => {
  assert.equal(countHighPriorityLeads([]), 0);
});

test('HIGH_PRIORITY_VALUES never includes the retired "urgent" value', () => {
  assert.deepEqual(HIGH_PRIORITY_VALUES, ['high', 'very_high']);
});

// ---------------------------------------------------------------------
// countPipelineFunnelMetrics (contacted/responses/meetings/proposals/won)
// ---------------------------------------------------------------------

test('countPipelineFunnelMetrics: maps each recognized stage to its own metric', () => {
  const breakdown = [
    { stage: 'new', count: 12 },
    { stage: 'researched', count: 4 },
    { stage: 'contacted', count: 8 },
    { stage: 'responded', count: 4 },
    { stage: 'meeting', count: 2 },
    { stage: 'proposal', count: 1 },
    { stage: 'won', count: 1 },
    { stage: 'lost', count: 3 },
  ];
  assert.deepEqual(countPipelineFunnelMetrics(breakdown), {
    contacted_leads: 8,
    responses: 4,
    meetings: 2,
    proposals: 1,
    won_deals: 1,
  });
});

test('countPipelineFunnelMetrics: an unrecognized stage value does not crash and is not counted anywhere', () => {
  const breakdown = [
    { stage: 'contacted', count: 5 },
    { stage: 'some_future_stage', count: 999 },
  ];
  assert.deepEqual(countPipelineFunnelMetrics(breakdown), {
    contacted_leads: 5,
    responses: 0,
    meetings: 0,
    proposals: 0,
    won_deals: 0,
  });
});

test('countPipelineFunnelMetrics: empty breakdown is all zero', () => {
  assert.deepEqual(countPipelineFunnelMetrics([]), {
    contacted_leads: 0,
    responses: 0,
    meetings: 0,
    proposals: 0,
    won_deals: 0,
  });
});

// ---------------------------------------------------------------------
// buildAnalyticsResponse (full contract)
// ---------------------------------------------------------------------

test('buildAnalyticsResponse: empty database produces valid zero metrics, not an error', () => {
  const result = buildAnalyticsResponse({
    businessesDiscovered: 0,
    noWebsiteBusinesses: 0,
    poorWebsiteBusinesses: 0,
    leadPriorityBreakdown: [],
    pipelineStageBreakdown: [],
    websiteStatusBreakdown: [],
  });

  assert.deepEqual(result.metrics, {
    businesses_discovered: 0,
    no_website_businesses: 0,
    poor_website_businesses: 0,
    high_priority_leads: 0,
    contacted_leads: 0,
    responses: 0,
    meetings: 0,
    proposals: 0,
    won_deals: 0,
  });
  assert.deepEqual(result.lead_priority_breakdown, {});
  assert.deepEqual(result.pipeline_stage_breakdown, {});
  assert.deepEqual(result.website_status_breakdown, {});
});

test('buildAnalyticsResponse: assembles the full nine-metric contract from populated data', () => {
  const result = buildAnalyticsResponse({
    businessesDiscovered: 100,
    noWebsiteBusinesses: 35,
    poorWebsiteBusinesses: 21,
    leadPriorityBreakdown: [
      { priority: 'low', count: 20 },
      { priority: 'medium', count: 15 },
      { priority: 'high', count: 8 },
      { priority: 'very_high', count: 6 },
    ],
    pipelineStageBreakdown: [
      { stage: 'new', count: 40 },
      { stage: 'contacted', count: 8 },
      { stage: 'responded', count: 4 },
      { stage: 'meeting', count: 2 },
      { stage: 'proposal', count: 1 },
      { stage: 'won', count: 1 },
    ],
    websiteStatusBreakdown: [
      { website_status: 'no_website', count: 35 },
      { website_status: 'reachable', count: 50 },
      { website_status: 'unreachable', count: 10 },
      { website_status: 'unknown', count: 5 },
    ],
  });

  assert.deepEqual(result.metrics, {
    businesses_discovered: 100,
    no_website_businesses: 35,
    poor_website_businesses: 21,
    high_priority_leads: 14,
    contacted_leads: 8,
    responses: 4,
    meetings: 2,
    proposals: 1,
    won_deals: 1,
  });
  assert.deepEqual(result.lead_priority_breakdown, { low: 20, medium: 15, high: 8, very_high: 6 });
  assert.deepEqual(result.website_status_breakdown, { no_website: 35, reachable: 50, unreachable: 10, unknown: 5 });
});
