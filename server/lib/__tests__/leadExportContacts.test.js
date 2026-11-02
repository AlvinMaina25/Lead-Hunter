const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CSV_COLUMNS,
  CSV_CONTACT_COLUMNS,
  joinScrapedValues,
  rowFromExportRecord,
  buildCsv,
} = require('../leadExport');
const { loadLeadsForExport, getLeadsExportCsv } = require('../leadExportService');
const { listLeads, LEGACY_SQL } = require('../leadListService');

const base = (overrides = {}) => ({
  business_name: 'Shop',
  phone: '+254712345678',
  category: 'Cafe',
  city: 'Nairobi',
  country: 'Kenya',
  website_url: 'https://shop.co.ke',
  website_status: 'active',
  lead_score: 70,
  priority: 'high',
  recommended_service: 'SEO',
  ...overrides,
});

// ---------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------

test('contacts are opt-in: default CSV is still exactly the original nine columns', () => {
  assert.equal(CSV_COLUMNS.length, 9);
  const [header, row] = buildCsv([base({ city: null, country: null, emails: ['a@shop.co.ke'] })]).split('\r\n');
  assert.equal(header.split(',').length, 9);
  assert.equal(row.split(',').length, 9);
  assert.ok(!row.includes('a@shop.co.ke'));
});

test('includeContacts appends Email and WhatsApp / Social after the original columns', () => {
  assert.deepEqual(CSV_CONTACT_COLUMNS, ['Email', 'WhatsApp / Social']);
  const [header] = buildCsv([], { includeContacts: true }).split('\r\n');
  assert.equal(header, 'Business,Phone,Category,Location,Website,Website Status,Lead Score,Priority,Recommended Service,Email,WhatsApp / Social');
});

test('includeContacts: a record without contact data gets two empty cells (still rectangular)', () => {
  const fields = rowFromExportRecord(base(), { includeContacts: true });
  assert.equal(fields.length, 11);
  assert.deepEqual(fields.slice(9), ['', '']);
});

test('includeContacts: emails (business email first), WhatsApp and socials are joined, deduped', () => {
  const fields = rowFromExportRecord(
    base({
      business_email: 'Owner@Shop.co.ke',
      emails: ['owner@shop.co.ke', 'sales@shop.co.ke'],
      whatsapp: ['https://wa.me/254712345678'],
      socials: ['https://www.instagram.com/shopke/', 'https://www.facebook.com/ShopKE'],
    }),
    { includeContacts: true }
  );
  assert.equal(fields[9], 'Owner@Shop.co.ke; sales@shop.co.ke');
  assert.equal(fields[10], 'https://wa.me/254712345678; https://www.instagram.com/shopke/; https://www.facebook.com/ShopKE');
});

test('Phone stays unguarded (+254...) even with contacts included', () => {
  assert.equal(rowFromExportRecord(base(), { includeContacts: true })[1], '+254712345678');
});

// ---------------------------------------------------------------------
// Formula-injection sanitisation of scraped values
// ---------------------------------------------------------------------

test('formula injection: scraped email and social cells starting with = + - @ are neutralised', () => {
  for (const lead of ['=', '+', '-', '@']) {
    const fields = rowFromExportRecord(
      base({ emails: [`${lead}cmd|' /C calc'!A0@shop.co.ke`], socials: [`${lead}HYPERLINK("http://evil.example")`] }),
      { includeContacts: true }
    );
    assert.ok(fields[9].startsWith(`'${lead}`) || fields[9].startsWith(`"'${lead}`), `email cell not guarded: ${fields[9]}`);
    assert.ok(fields[10].startsWith(`'${lead}`) || fields[10].startsWith(`"'${lead}`), `social cell not guarded: ${fields[10]}`);
  }
});

test('formula injection: the guard applies to the whole cell, so a business_email-first cell is guarded too', () => {
  const [fieldEmail] = rowFromExportRecord(base({ business_email: '=1+1@x.com' }), { includeContacts: true }).slice(9);
  assert.equal(fieldEmail, "'=1+1@x.com");
});

test('sanitisation: control characters (newline, CR, TAB) in scraped values cannot break out of the cell or lead it', () => {
  const fields = rowFromExportRecord(
    base({ emails: ['a@shop.co.ke\r\n=cmd'], socials: ['\t=HYPERLINK("x")', '\r@evil'] }),
    { includeContacts: true }
  );
  assert.ok(!/[\r\n\t]/.test(fields[9]), 'no raw line break / tab in the email cell');
  assert.ok(!/[\r\n\t]/.test(fields[10]));
  assert.ok(/^"?'=/.test(fields[10]), `a value that only starts with a control char then = is still guarded: ${fields[10]}`);

  const csv = buildCsv([base({ emails: ['a@shop.co.ke\nINJECTED,ROW'] })], { includeContacts: true });
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2, 'still one header + one data row');
});

test('sanitisation: RFC 4180 quoting still applies on top (commas / quotes in values)', () => {
  const cell = rowFromExportRecord(base({ socials: ['https://x.example/a,b"c'] }), { includeContacts: true })[10];
  assert.equal(cell, '"https://x.example/a,b""c"');
});

test('joinScrapedValues: drops non-strings/empties and dedupes case-insensitively', () => {
  assert.equal(joinScrapedValues(['A@x.com', 'a@X.com', '', '  ', null, 5, 'b@x.com']), 'A@x.com; b@x.com');
  assert.equal(joinScrapedValues(null), '');
});

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

function exportPool({ failContactsQuery = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (s.includes('business_contacts')) {
        if (failContactsQuery) throw Object.assign(new Error('missing'), { code: '42P01' });
        return { rows: [base({ business_email: null, emails: ['a@shop.co.ke'], whatsapp: ['https://wa.me/254712345678'], socials: ['https://www.instagram.com/shopke/'] })] };
      }
      return { rows: [base()] };
    },
  };
}

test('service: default load is the original query (no contact join); includeContacts joins once, no N+1', async () => {
  const plain = exportPool();
  const [row] = await loadLeadsForExport(plain);
  assert.equal(plain.calls.length, 1);
  assert.ok(!plain.calls[0].includes('business_contacts'));
  assert.ok(!('emails' in row));

  const rich = exportPool();
  await loadLeadsForExport(rich, { includeContacts: true });
  assert.equal(rich.calls.length, 1, 'a single query');
  assert.ok(rich.calls[0].includes('LEFT JOIN LATERAL') && rich.calls[0].includes('business_contacts'));
  assert.ok(rich.calls[0].includes('b.email AS business_email'));
});

test('service: getLeadsExportCsv({includeContacts}) renders the contact columns end to end', async () => {
  const csv = await getLeadsExportCsv(exportPool(), { includeContacts: true });
  const [header, row] = csv.split('\r\n');
  assert.ok(header.endsWith(',Email,WhatsApp / Social'));
  assert.ok(row.endsWith(',a@shop.co.ke,https://wa.me/254712345678; https://www.instagram.com/shopke/') || row.includes('"https://wa.me/254712345678; '));
});

test('service: before migration 009 (no business_contacts table) the export still works, with empty contact cells', async () => {
  const pool = exportPool({ failContactsQuery: true });
  const csv = await getLeadsExportCsv(pool, { includeContacts: true });
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith(',,'));
});

test('service: other database errors are NOT swallowed', async () => {
  const pool = { query: async () => Promise.reject(Object.assign(new Error('boom'), { code: '57P01' })) };
  await assert.rejects(() => loadLeadsForExport(pool, { includeContacts: true }), /boom/);
});

// ---------------------------------------------------------------------
// GET /api/leads list service (contact flags)
// ---------------------------------------------------------------------

test('listLeads: one query returning has_phone / has_email / has_social flags', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ id: 'l1', has_phone: true, has_email: false, has_social: true, has_whatsapp: false }] };
    },
  };
  const rows = await listLeads(pool);
  assert.equal(calls.length, 1);
  for (const flag of ['has_phone', 'has_email', 'has_social', 'has_whatsapp']) assert.ok(calls[0].includes(`AS ${flag}`), flag);
  assert.deepEqual(rows[0], { id: 'l1', has_phone: true, has_email: false, has_social: true, has_whatsapp: false });
  assert.ok(!calls[0].includes('b.email AS'), 'flags only -- contact values are not returned in the list');
});

test('listLeads: falls back to the legacy query when migration 009 is missing; other errors propagate', async () => {
  const seen = [];
  const pool = {
    async query(sql) {
      seen.push(sql);
      if (sql.includes('business_contacts')) throw Object.assign(new Error('no table'), { code: '42P01' });
      return { rows: [{ id: 'l1', has_phone: true, has_email: false, has_social: false, has_whatsapp: false }] };
    },
  };
  const rows = await listLeads(pool);
  assert.equal(rows.length, 1);
  assert.equal(seen[1], LEGACY_SQL);

  await assert.rejects(() => listLeads({ query: async () => Promise.reject(new Error('db down')) }), /db down/);
});
