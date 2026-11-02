const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLeadsForExport, getLeadsExportCsv } = require('../leadExportService');

/**
 * A minimal fake Postgres pool understanding only the exact export
 * query leadExportService.js issues. Deliberately does NOT touch a
 * real database -- matches the pattern already used in
 * analyticsService.test.js / leadDetailService.test.js.
 */
function makeFakePool({ leads = [], businesses = [], aiAnalyses = [] } = {}) {
  const businessRows = new Map(businesses.map((b) => [b.id, { ...b }]));
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT b.name AS business_name')) {
      const rows = [...leads]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((lead) => {
          const business = businessRows.get(lead.business_id) || {};
          const completed = aiAnalyses
            .filter((a) => a.business_id === lead.business_id && a.status === 'completed')
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          const latest = completed[0] || null;

          return {
            business_name: business.name ?? null,
            phone: business.phone ?? null,
            category: business.category ?? null,
            city: business.city ?? null,
            country: business.country ?? null,
            website_url: business.website_url ?? null,
            website_status: business.website_status ?? null,
            lead_score: lead.lead_score ?? null,
            priority: lead.priority ?? null,
            recommended_service: latest ? latest.recommended_service ?? null : null,
          };
        });
      return { rows };
    }

    throw new Error(`FakePool: unrecognized query: ${s}`);
  }

  return { query, calls };
}

// ---------------------------------------------------------------------
// loadLeadsForExport
// ---------------------------------------------------------------------

test('loadLeadsForExport: issues exactly one query (no N+1)', async () => {
  const pool = makeFakePool({
    leads: [
      { id: 'l1', business_id: 'b1', lead_score: 90, priority: 'high', created_at: '2026-01-01T00:00:00Z' },
      { id: 'l2', business_id: 'b2', lead_score: 50, priority: 'medium', created_at: '2026-01-02T00:00:00Z' },
    ],
    businesses: [
      { id: 'b1', name: 'Alpha Co', phone: '111', category: 'Cafe', city: 'Nairobi', country: 'Kenya', website_url: 'https://alpha.example', website_status: 'active' },
      { id: 'b2', name: 'Beta Co', phone: '222', category: 'Salon', city: 'Mombasa', country: 'Kenya', website_url: null, website_status: 'no_website' },
    ],
  });

  const rows = await loadLeadsForExport(pool);
  assert.equal(pool.calls.length, 1);
  assert.equal(rows.length, 2);
});

test('loadLeadsForExport: recommended_service comes from the latest COMPLETED ai_analysis only', async () => {
  const pool = makeFakePool({
    leads: [{ id: 'l1', business_id: 'b1', lead_score: 70, priority: 'high', created_at: '2026-01-01T00:00:00Z' }],
    businesses: [{ id: 'b1', name: 'Alpha Co', phone: '111', category: 'Cafe', city: 'Nairobi', country: 'Kenya', website_url: 'https://alpha.example', website_status: 'active' }],
    aiAnalyses: [
      { business_id: 'b1', status: 'completed', created_at: '2026-01-01T00:00:00Z', recommended_service: 'Old Service' },
      { business_id: 'b1', status: 'completed', created_at: '2026-02-01T00:00:00Z', recommended_service: 'New Service' },
      { business_id: 'b1', status: 'pending', created_at: '2026-03-01T00:00:00Z', recommended_service: 'Should Not Appear' },
    ],
  });

  const [row] = await loadLeadsForExport(pool);
  assert.equal(row.recommended_service, 'New Service');
});

test('loadLeadsForExport: no completed ai_analysis yields an empty (null) recommended_service, never invented', async () => {
  const pool = makeFakePool({
    leads: [{ id: 'l1', business_id: 'b1', lead_score: 70, priority: 'high', created_at: '2026-01-01T00:00:00Z' }],
    businesses: [{ id: 'b1', name: 'Alpha Co', phone: '111', category: 'Cafe', city: 'Nairobi', country: 'Kenya', website_url: 'https://alpha.example', website_status: 'active' }],
    aiAnalyses: [{ business_id: 'b1', status: 'pending', created_at: '2026-01-01T00:00:00Z', recommended_service: 'Not Yet' }],
  });

  const [row] = await loadLeadsForExport(pool);
  assert.equal(row.recommended_service, null);
});

test('loadLeadsForExport: only the nine underlying export fields are present on each row', async () => {
  const pool = makeFakePool({
    leads: [{ id: 'l1', business_id: 'b1', lead_score: 70, priority: 'high', created_at: '2026-01-01T00:00:00Z' }],
    businesses: [{ id: 'b1', name: 'Alpha Co', phone: '111', category: 'Cafe', city: 'Nairobi', country: 'Kenya', website_url: 'https://alpha.example', website_status: 'active' }],
  });

  const [row] = await loadLeadsForExport(pool);
  assert.deepEqual(Object.keys(row).sort(), [
    'business_name',
    'category',
    'city',
    'country',
    'lead_score',
    'phone',
    'priority',
    'recommended_service',
    'website_status',
    'website_url',
  ]);
});

// ---------------------------------------------------------------------
// getLeadsExportCsv
// ---------------------------------------------------------------------

test('getLeadsExportCsv: an empty dataset still returns a valid CSV with just the header', async () => {
  const pool = makeFakePool({});
  const csv = await getLeadsExportCsv(pool);
  assert.equal(
    csv,
    'Business,Phone,Category,Location,Website,Website Status,Lead Score,Priority,Recommended Service\r\n'
  );
});

test('getLeadsExportCsv: renders real rows into a downloadable CSV document', async () => {
  const pool = makeFakePool({
    leads: [{ id: 'l1', business_id: 'b1', lead_score: 90, priority: 'urgent', created_at: '2026-01-01T00:00:00Z' }],
    businesses: [{ id: 'b1', name: 'Alpha Co', phone: '111', category: 'Cafe', city: 'Nairobi', country: 'Kenya', website_url: 'https://alpha.example', website_status: 'active' }],
    aiAnalyses: [{ business_id: 'b1', status: 'completed', created_at: '2026-01-01T00:00:00Z', recommended_service: 'Website Redesign' }],
  });

  const csv = await getLeadsExportCsv(pool);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'Alpha Co,111,Cafe,"Nairobi, Kenya",https://alpha.example,active,90,urgent,Website Redesign');
});

test('getLeadsExportCsv: propagates a database error rather than swallowing it', async () => {
  const pool = { query: async () => { throw new Error('connection lost'); } };
  await assert.rejects(() => getLeadsExportCsv(pool), /connection lost/);
});
