const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadBusinessCounts,
  loadLatestCompletedAnalysisScores,
  loadLeadPriorityBreakdown,
  loadPipelineStageBreakdown,
  loadWebsiteStatusBreakdown,
  getAnalytics,
} = require('../analyticsService');

/**
 * A minimal fake Postgres pool understanding only the exact aggregate
 * queries analyticsService.js issues. Deliberately does NOT touch a
 * real database -- matches the pattern already used in
 * leadScoringService.test.js / websiteCheckService.test.js. Each
 * branch below reproduces, in plain JS, exactly what the real SQL
 * aggregate would compute for the given fixture rows, so these tests
 * verify analyticsService.js issues the right query and shapes the
 * result correctly, independent of an actual Postgres instance.
 */
function makeFakePool({ businesses = [], websiteAnalyses = [], leads = [], pipeline = [] } = {}) {
  const calls = [];

  async function query(sql) {
    calls.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT COUNT(*)::int AS businesses_discovered')) {
      return {
        rows: [
          {
            businesses_discovered: businesses.length,
            no_website_businesses: businesses.filter((b) => b.website_status === 'no_website').length,
          },
        ],
      };
    }

    if (s.includes('DISTINCT ON (business_id)') && s.includes('FROM website_analysis')) {
      const completed = websiteAnalyses.filter((a) => a.analysis_status === 'completed');
      const latestByBusiness = new Map();
      for (const a of completed) {
        const existing = latestByBusiness.get(a.business_id);
        if (!existing || new Date(a.analyzed_at) > new Date(existing.analyzed_at)) {
          latestByBusiness.set(a.business_id, a);
        }
      }
      return {
        rows: [...latestByBusiness.values()].map((a) => ({
          business_id: a.business_id,
          performance_score: a.performance_score ?? null,
          seo_score: a.seo_score ?? null,
          accessibility_score: a.accessibility_score ?? null,
          best_practices_score: a.best_practices_score ?? null,
        })),
      };
    }

    if (s.includes('FROM leads') && s.includes('GROUP BY priority')) {
      const counts = {};
      for (const l of leads) counts[l.priority] = (counts[l.priority] || 0) + 1;
      return { rows: Object.entries(counts).map(([priority, count]) => ({ priority, count })) };
    }

    if (s.includes('FROM leads l') && s.includes('LEFT JOIN sales_pipeline')) {
      const stageByLead = new Map(pipeline.map((p) => [p.lead_id, p.stage]));
      const counts = {};
      for (const l of leads) {
        const stage = stageByLead.get(l.id) || 'new';
        counts[stage] = (counts[stage] || 0) + 1;
      }
      return { rows: Object.entries(counts).map(([stage, count]) => ({ stage, count })) };
    }

    if (s.includes('FROM businesses') && s.includes('GROUP BY website_status')) {
      const counts = {};
      for (const b of businesses) counts[b.website_status] = (counts[b.website_status] || 0) + 1;
      return { rows: Object.entries(counts).map(([website_status, count]) => ({ website_status, count })) };
    }

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls };
}

// ---------------------------------------------------------------------
// Individual loaders
// ---------------------------------------------------------------------

test('loadBusinessCounts: counts businesses and no-website businesses without duplication', async () => {
  const pool = makeFakePool({
    businesses: [
      { id: 'b1', website_status: 'no_website' },
      { id: 'b2', website_status: 'reachable' },
      { id: 'b3', website_status: 'no_website' },
    ],
  });
  const result = await loadBusinessCounts(pool);
  assert.deepEqual(result, { businesses_discovered: 3, no_website_businesses: 2 });
});

test('loadLatestCompletedAnalysisScores: only completed rows count, and only the latest per business', async () => {
  const pool = makeFakePool({
    websiteAnalyses: [
      { business_id: 'b1', analysis_status: 'completed', analyzed_at: '2026-01-01T00:00:00Z', performance_score: 90, seo_score: 90, accessibility_score: 90, best_practices_score: 90 },
      { business_id: 'b1', analysis_status: 'completed', analyzed_at: '2026-02-01T00:00:00Z', performance_score: 10, seo_score: 10, accessibility_score: 10, best_practices_score: 10 },
      { business_id: 'b2', analysis_status: 'failed', analyzed_at: '2026-02-01T00:00:00Z', performance_score: null, seo_score: null, accessibility_score: null, best_practices_score: null },
    ],
  });
  const result = await loadLatestCompletedAnalysisScores(pool);
  assert.equal(result.length, 1);
  assert.equal(result[0].business_id, 'b1');
  assert.equal(result[0].performance_score, 10);
});

test('loadLeadPriorityBreakdown / loadPipelineStageBreakdown / loadWebsiteStatusBreakdown shape rows correctly', async () => {
  const pool = makeFakePool({
    businesses: [{ id: 'b1', website_status: 'unreachable' }],
    leads: [
      { id: 'l1', priority: 'high' },
      { id: 'l2', priority: 'high' },
    ],
    pipeline: [{ lead_id: 'l1', stage: 'contacted' }],
  });

  assert.deepEqual(await loadLeadPriorityBreakdown(pool), [{ priority: 'high', count: 2 }]);
  const stageBreakdown = await loadPipelineStageBreakdown(pool);
  assert.deepEqual(
    stageBreakdown.sort((a, b) => a.stage.localeCompare(b.stage)),
    [
      { stage: 'contacted', count: 1 },
      { stage: 'new', count: 1 },
    ]
  );
  assert.deepEqual(await loadWebsiteStatusBreakdown(pool), [{ website_status: 'unreachable', count: 1 }]);
});

// ---------------------------------------------------------------------
// getAnalytics (full orchestration)
// ---------------------------------------------------------------------

test('getAnalytics: empty database returns valid zero metrics rather than erroring', async () => {
  const pool = makeFakePool({});
  const result = await getAnalytics(pool);

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
});

test('getAnalytics: full example matching the Phase 21 response contract', async () => {
  const businesses = [
    { id: 'b1', website_status: 'no_website' },
    { id: 'b2', website_status: 'no_website' },
    { id: 'b3', website_status: 'reachable' }, // has a poor completed analysis
    { id: 'b4', website_status: 'reachable' }, // has a healthy completed analysis
    { id: 'b5', website_status: 'unreachable' },
  ];
  const websiteAnalyses = [
    { business_id: 'b3', analysis_status: 'completed', analyzed_at: '2026-03-01T00:00:00Z', performance_score: 20, seo_score: 90, accessibility_score: 90, best_practices_score: 90 },
    { business_id: 'b4', analysis_status: 'completed', analyzed_at: '2026-03-01T00:00:00Z', performance_score: 95, seo_score: 90, accessibility_score: 90, best_practices_score: 90 },
  ];
  const leads = [
    { id: 'l1', priority: 'high' },
    { id: 'l2', priority: 'very_high' },
    { id: 'l3', priority: 'low' },
    { id: 'l4', priority: 'medium' },
  ];
  const pipeline = [
    { lead_id: 'l1', stage: 'contacted' },
    { lead_id: 'l2', stage: 'won' },
  ];

  const pool = makeFakePool({ businesses, websiteAnalyses, leads, pipeline });
  const result = await getAnalytics(pool);

  assert.deepEqual(result.metrics, {
    businesses_discovered: 5,
    no_website_businesses: 2,
    poor_website_businesses: 1,
    high_priority_leads: 2,
    contacted_leads: 1,
    responses: 0,
    meetings: 0,
    proposals: 0,
    won_deals: 1,
  });
});
