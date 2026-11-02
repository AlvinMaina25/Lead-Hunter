const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CSV_COLUMNS,
  csvEscape,
  buildLocation,
  rowFromExportRecord,
  buildCsv,
} = require('../leadExport');

function baseRecord(overrides = {}) {
  return {
    business_name: "John's Cafe",
    phone: '+254712345678',
    category: 'Restaurant',
    city: 'Nairobi',
    country: 'Kenya',
    website_url: 'https://johnscafe.example.com',
    website_status: 'active',
    lead_score: 82,
    priority: 'high',
    recommended_service: 'Website Redesign',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// csvEscape
// ---------------------------------------------------------------------

test('csvEscape: null/undefined become an empty field, never "null"/"undefined"', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape: a plain value with no special characters is returned unquoted', () => {
  assert.equal(csvEscape('Nairobi'), 'Nairobi');
  assert.equal(csvEscape(82), '82');
});

test('csvEscape: a value containing a comma is quoted', () => {
  assert.equal(csvEscape('Nairobi, Kenya'), '"Nairobi, Kenya"');
});

test('csvEscape: a value containing a double quote is quoted and the quote is doubled', () => {
  assert.equal(csvEscape('The "Best" Cafe'), '"The ""Best"" Cafe"');
});

test('csvEscape: a value containing a newline is quoted', () => {
  assert.equal(csvEscape('Line one\nLine two'), '"Line one\nLine two"');
  assert.equal(csvEscape('Line one\r\nLine two'), '"Line one\r\nLine two"');
});

// ---------------------------------------------------------------------
// csvEscape: formula-injection guard (CWE-1236)
// ---------------------------------------------------------------------

test('csvEscape: without guardFormulaInjection, a leading =/+/-/@ is left as-is (existing behavior)', () => {
  assert.equal(csvEscape('=formula'), '=formula');
  assert.equal(csvEscape('+formula'), '+formula');
  assert.equal(csvEscape('-formula'), '-formula');
  assert.equal(csvEscape('@formula'), '@formula');
});

test('csvEscape: guardFormulaInjection prefixes a leading = with a single quote', () => {
  assert.equal(csvEscape('=formula', { guardFormulaInjection: true }), "'=formula");
  assert.equal(csvEscape('=1+1', { guardFormulaInjection: true }), "'=1+1");
});

test('csvEscape: guardFormulaInjection prefixes a leading + with a single quote', () => {
  assert.equal(csvEscape('+formula', { guardFormulaInjection: true }), "'+formula");
});

test('csvEscape: guardFormulaInjection prefixes a leading - with a single quote', () => {
  assert.equal(csvEscape('-formula', { guardFormulaInjection: true }), "'-formula");
});

test('csvEscape: guardFormulaInjection prefixes a leading @ with a single quote', () => {
  assert.equal(csvEscape('@formula', { guardFormulaInjection: true }), "'@formula");
});

test('csvEscape: guardFormulaInjection leaves values with no leading trigger character unchanged', () => {
  assert.equal(csvEscape('Nairobi', { guardFormulaInjection: true }), 'Nairobi');
  assert.equal(csvEscape("John's Cafe", { guardFormulaInjection: true }), "John's Cafe");
});

test('csvEscape: guardFormulaInjection combines correctly with RFC 4180 quoting', () => {
  // Leading "=" triggers the guard prefix; the embedded comma still
  // triggers RFC 4180 quoting on top of that.
  assert.equal(csvEscape('=SUM(A1, A2)', { guardFormulaInjection: true }), '"\'=SUM(A1, A2)"');
});

test('csvEscape: null/undefined are unaffected by guardFormulaInjection', () => {
  assert.equal(csvEscape(null, { guardFormulaInjection: true }), '');
  assert.equal(csvEscape(undefined, { guardFormulaInjection: true }), '');
});

// ---------------------------------------------------------------------
// buildLocation
// ---------------------------------------------------------------------

test('buildLocation: city and country present joins with ", "', () => {
  assert.equal(buildLocation('Nairobi', 'Kenya'), 'Nairobi, Kenya');
});

test('buildLocation: only one of city/country present returns just that one', () => {
  assert.equal(buildLocation('Nairobi', null), 'Nairobi');
  assert.equal(buildLocation(null, 'Kenya'), 'Kenya');
});

test('buildLocation: neither present returns an empty string', () => {
  assert.equal(buildLocation(null, null), '');
  assert.equal(buildLocation(undefined, undefined), '');
});

// ---------------------------------------------------------------------
// rowFromExportRecord / column order
// ---------------------------------------------------------------------

test('CSV_COLUMNS: exactly the nine requested columns, in the stable order', () => {
  assert.deepEqual(CSV_COLUMNS, [
    'Business',
    'Phone',
    'Category',
    'Location',
    'Website',
    'Website Status',
    'Lead Score',
    'Priority',
    'Recommended Service',
  ]);
});

test('rowFromExportRecord: a normal business exports all nine fields correctly', () => {
  const row = rowFromExportRecord(baseRecord());
  assert.deepEqual(row, [
    "John's Cafe",
    '+254712345678',
    'Restaurant',
    '"Nairobi, Kenya"',
    'https://johnscafe.example.com',
    'active',
    '82',
    'high',
    'Website Redesign',
  ]);
});

test('rowFromExportRecord: missing phone exports as an empty field', () => {
  const row = rowFromExportRecord(baseRecord({ phone: null }));
  assert.equal(row[1], '');
});

test('rowFromExportRecord: missing website exports as an empty field', () => {
  const row = rowFromExportRecord(baseRecord({ website_url: null }));
  assert.equal(row[4], '');
});

test('rowFromExportRecord: missing website status exports as an empty field', () => {
  const row = rowFromExportRecord(baseRecord({ website_status: null }));
  assert.equal(row[5], '');
});

test('rowFromExportRecord: missing lead score exports as an empty field', () => {
  const row = rowFromExportRecord(baseRecord({ lead_score: null }));
  assert.equal(row[6], '');
});

test('rowFromExportRecord: missing priority exports as an empty field', () => {
  const row = rowFromExportRecord(baseRecord({ priority: null }));
  assert.equal(row[7], '');
});

test('rowFromExportRecord: missing recommended service exports as an empty field (never invented)', () => {
  const row = rowFromExportRecord(baseRecord({ recommended_service: null }));
  assert.equal(row[8], '');
});

// ---------------------------------------------------------------------
// rowFromExportRecord: formula-injection guard on free-text fields only
// ---------------------------------------------------------------------

test('rowFromExportRecord: a business name starting with "=" is neutralized with a leading single quote', () => {
  const row = rowFromExportRecord(baseRecord({ business_name: '=formula' }));
  assert.equal(row[0], "'=formula");
});

test('rowFromExportRecord: a category starting with "+" is neutralized with a leading single quote', () => {
  const row = rowFromExportRecord(baseRecord({ category: '+formula' }));
  assert.equal(row[2], "'+formula");
});

test('rowFromExportRecord: a recommended service starting with "-" is neutralized with a leading single quote', () => {
  const row = rowFromExportRecord(baseRecord({ recommended_service: '-formula' }));
  assert.equal(row[8], "'-formula");
});

test('rowFromExportRecord: a business name starting with "@" is neutralized with a leading single quote', () => {
  const row = rowFromExportRecord(baseRecord({ business_name: '@formula' }));
  assert.equal(row[0], "'@formula");
});

test('rowFromExportRecord: a legitimate +254 phone number is NEVER guarded and passes through unchanged', () => {
  const row = rowFromExportRecord(baseRecord({ phone: '+254712345678' }));
  assert.equal(row[1], '+254712345678');
});

test('rowFromExportRecord: a phone number is not guarded even if it happens to start with =, -, or @', () => {
  // Not realistic phone data, but proves the guard is genuinely never
  // applied to this column, regardless of its content.
  assert.equal(rowFromExportRecord(baseRecord({ phone: '=254712345678' }))[1], '=254712345678');
  assert.equal(rowFromExportRecord(baseRecord({ phone: '-254712345678' }))[1], '-254712345678');
  assert.equal(rowFromExportRecord(baseRecord({ phone: '@254712345678' }))[1], '@254712345678');
});

test('rowFromExportRecord: no field in the row is ever the string "null" or "undefined"', () => {
  const row = rowFromExportRecord({
    business_name: 'No Data Co',
    phone: null,
    category: undefined,
    city: null,
    country: undefined,
    website_url: null,
    website_status: null,
    lead_score: null,
    priority: null,
    recommended_service: null,
  });
  for (const field of row) {
    assert.notEqual(field, 'null');
    assert.notEqual(field, 'undefined');
  }
});

// ---------------------------------------------------------------------
// buildCsv
// ---------------------------------------------------------------------

test('buildCsv: header row is exactly correct', () => {
  const csv = buildCsv([]);
  const [header] = csv.split('\r\n');
  assert.equal(
    header,
    'Business,Phone,Category,Location,Website,Website Status,Lead Score,Priority,Recommended Service'
  );
});

test('buildCsv: a normal business exports as one correct data row', () => {
  const csv = buildCsv([baseRecord()]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(
    lines[1],
    'John\'s Cafe,+254712345678,Restaurant,"Nairobi, Kenya",https://johnscafe.example.com,active,82,high,Website Redesign'
  );
});

test('buildCsv: multiple rows export correctly, in the order given', () => {
  const csv = buildCsv([
    baseRecord({ business_name: 'Alpha Co' }),
    baseRecord({ business_name: 'Beta Co' }),
    baseRecord({ business_name: 'Gamma Co' }),
  ]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 4); // header + 3 rows
  assert.ok(lines[1].startsWith('Alpha Co,'));
  assert.ok(lines[2].startsWith('Beta Co,'));
  assert.ok(lines[3].startsWith('Gamma Co,'));
});

test('buildCsv: commas inside values are escaped correctly', () => {
  const csv = buildCsv([baseRecord({ category: 'Cafe, Bakery' })]);
  assert.ok(csv.includes('"Cafe, Bakery"'));
});

test('buildCsv: quotes inside values are escaped correctly', () => {
  const csv = buildCsv([baseRecord({ business_name: 'The "Best" Cafe' })]);
  assert.ok(csv.includes('"The ""Best"" Cafe"'));
});

test('buildCsv: newlines inside values are escaped correctly', () => {
  const csv = buildCsv([baseRecord({ recommended_service: 'SEO\nAudit' })]);
  assert.ok(csv.includes('"SEO\nAudit"'));
  // The embedded newline must not be mistaken for a new CSV row.
  const dataLines = csv.split('\r\n').filter(Boolean);
  assert.equal(dataLines.length, 2); // header + exactly one (multi-line) data row
});

// ---------------------------------------------------------------------
// buildCsv: formula-injection guard, end to end
// ---------------------------------------------------------------------

test('buildCsv: =formula in a free-text field is neutralized in the final CSV output', () => {
  const csv = buildCsv([baseRecord({ business_name: '=formula' })]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.ok(lines[1].startsWith("'=formula,"));
});

test('buildCsv: +formula in a free-text field is neutralized in the final CSV output', () => {
  const csv = buildCsv([baseRecord({ category: '+formula' })]);
  assert.ok(csv.includes(",'+formula,"));
});

test('buildCsv: -formula in a free-text field is neutralized in the final CSV output', () => {
  const csv = buildCsv([baseRecord({ recommended_service: '-formula' })]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.ok(lines[1].endsWith(",'-formula"));
});

test('buildCsv: @formula in a free-text field is neutralized in the final CSV output', () => {
  const csv = buildCsv([baseRecord({ category: '@formula' })]);
  assert.ok(csv.includes(",'@formula,"));
});

test('buildCsv: a legitimate +254 phone number is preserved unchanged in the final CSV output', () => {
  const csv = buildCsv([baseRecord({ phone: '+254712345678' })]);
  assert.ok(csv.includes(',+254712345678,'));
  assert.ok(!csv.includes(",'+254712345678,"));
});

test('buildCsv: an empty dataset still returns just the header row', () => {
  const csv = buildCsv([]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 1);
});
