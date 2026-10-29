/**
 * Excel lead export tests. Runs against an in-memory SQLite database through the
 * real models, service, routes and auth middleware — never touches server/.env's DB.
 *   npm run test:export
 */
process.env.DATABASE_URL = '';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');

const db = require('../models');
const svc = require('../services/leadExportService');
const exportCtrl = require('../controllers/leadExportController');
const { signToken } = require('../middleware/auth');
const app = require('../app');

const { sequelize, User, Company, Lead, CompanyContact, CompanyWebsite, DetectedSignal, LeadSource, SearchRun, Note, LeadExport } = db;

let server;
let base;
let admin;
let agent;
let token;
const ids = {};

const at = (iso) => new Date(iso);

async function makeLead(company, lead, createdAt) {
  const c = await Company.create({ source: 'csv', ...company });
  const l = await Lead.create({ company_id: c.id, ...lead });
  // Same UTC text format Sequelize's SQLite dialect stores (raw Date replacements would use local time).
  const utc = createdAt && createdAt.toISOString().replace('T', ' ').replace('Z', ' +00:00');
  if (createdAt) await sequelize.query('UPDATE leads SET created_at = ? WHERE id = ?', { replacements: [utc, l.id] });
  return { c, l };
}

// Writes the workbook into memory and parses it back with ExcelJS — proves the file is a valid .xlsx.
async function exportToWorkbook(body) {
  const req = svc.parseExportRequest(body);
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (d) => chunks.push(d));
  const done = new Promise((r) => sink.on('end', r));
  const written = await svc.writeWorkbook(req, sink, { exportedBy: 'Tester' });
  await done;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return { wb, written, ws: wb.getWorksheet('Leads') };
}

const headers = (ws) => ws.getRow(1).values.slice(1);
const column = (ws, header) => {
  const idx = headers(ws).indexOf(header) + 1;
  const out = [];
  ws.eachRow((row, n) => n > 1 && out.push(row.getCell(idx).value));
  return out;
};
const exportedIds = (ws) => column(ws, 'Lead ID');

async function post(path, body, tok = token) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

test.before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', password_hash: 'x', role: 'admin' });
  agent = await User.create({ name: 'Agent Smith', email: 'agent@test.local', password_hash: 'x', role: 'agent' });
  token = signToken(admin);

  const run = await SearchRun.create({ triggered_by: 'manual' });
  ids.run = run.id;

  // A: Ahmedabad hotel, score 72, created 1 Oct 2026 00:00 IST (= 30 Sep 18:30 UTC)
  ids.a = await makeLead(
    { company_name: 'Ahmedabad Grand Hotel', city: 'Ahmedabad', state: 'Gujarat', industry: 'Hotels', company_category: 'Hospitality', employee_count: 40, has_website: true, website: 'https://grandhotel.example', normalized_domain: 'grandhotel.example' },
    { lead_score: 72, status: 'NEW', contact_status: 'NOT_CONTACTED', source: 'automation', priority: 'HIGH', lead_temperature: 'WARM', assigned_user_id: agent.id },
    at('2026-09-30T18:30:00Z')
  );
  // B: Ahmedabad hotel, score 55 — fails min_score 60
  ids.b = await makeLead(
    { company_name: 'Budget Inn', city: 'Ahmedabad', state: 'Gujarat', industry: 'Hotels', has_website: false },
    { lead_score: 55, status: 'NEW', source: 'manual' },
    at('2026-10-15T10:00:00Z')
  );
  // C: created 29 Oct 2026 23:59:59 IST — inclusive end date
  ids.c = await makeLead(
    { company_name: '=HYPERLINK("http://evil","x")', city: 'Ahmedabad', state: 'Gujarat', industry: 'Hotels', cin: '00123' },
    { lead_score: 90, status: 'NEW', source: 'manual', contact_status: 'CONTACTED', ever_contacted: true },
    at('2026-10-29T18:29:59Z')
  );
  // D: created 30 Oct 2026 00:00 IST — just outside the range
  ids.d = await makeLead(
    { company_name: 'Day After Ltd', city: 'Ahmedabad', state: 'Gujarat', industry: 'Hotels' },
    { lead_score: 80, status: 'NEW', source: 'manual' },
    at('2026-10-29T18:30:00Z')
  );
  // E: Mumbai software co, created 30 Sep 2026 IST — just before the range
  ids.e = await makeLead(
    { company_name: 'Mumbai Soft', city: 'Mumbai', state: 'Maharashtra', industry: 'Software' },
    { lead_score: 65, status: 'QUALIFIED', lead_status: 'QUALIFIED', source: 'manual', next_follow_up_at: at('2020-01-01T00:00:00Z') },
    at('2026-09-30T18:29:59Z')
  );

  const A = ids.a.c.id;
  // Several one-to-many rows for A — must not duplicate the lead.
  await CompanyContact.bulkCreate([
    { company_id: A, type: 'email', value: 'info@grandhotel.example', is_primary: true, contact_name: 'Ravi Patel', job_title: 'Owner' },
    { company_id: A, type: 'email', value: 'sales@grandhotel.example' },
    { company_id: A, type: 'phone', value: '07912345678' },
    { company_id: A, type: 'phone', value: '+91 98765 43210' },
  ]);
  await CompanyWebsite.bulkCreate([
    { company_id: A, url: 'https://grandhotel.example', status: 'live', health: 'poor', meta_description: 'Best stay in town' },
    { company_id: A, url: 'https://old.grandhotel.example', status: 'down' },
  ]);
  await DetectedSignal.bulkCreate([
    { company_id: A, signal_type: 'OUTDATED_WEBSITE', signal_description: 'x', signal_strength: 'HIGH', signal_source: 'website_audit' },
    { company_id: A, signal_type: 'ONLINE_BOOKING_GAP', signal_description: 'y', signal_strength: 'MEDIUM', signal_source: 'website_audit' },
  ]);
  await LeadSource.bulkCreate([
    { company_id: A, provider: 'osm', search_run_id: ids.run },
    { company_id: A, provider: 'serper', search_run_id: ids.run },
  ]);
  await Note.bulkCreate([
    { lead_id: ids.a.l.id, company_id: A, body: 'Called, wants a quote' },
    { lead_id: ids.a.l.id, company_id: A, body: '@SUM(1,2)' },
  ]);

  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

const OCT = { date_from: '2026-10-01', date_to: '2026-10-29', timezone: 'Asia/Kolkata' };

/* ---------------- pure helpers ---------------- */

test('zonedMidnightUtc converts calendar days in the user timezone', () => {
  assert.equal(svc.zonedMidnightUtc('2026-10-01', 'Asia/Kolkata').toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(svc.zonedMidnightUtc('2026-10-01', 'UTC').toISOString(), '2026-10-01T00:00:00.000Z');
  // DST: New York is UTC-4 before 1 Nov 2026 and UTC-5 after.
  assert.equal(svc.zonedMidnightUtc('2026-10-31', 'America/New_York').toISOString(), '2026-10-31T04:00:00.000Z');
  assert.equal(svc.zonedMidnightUtc('2026-11-02', 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
});

test('safeText neutralises formula injection but keeps phone numbers', () => {
  assert.equal(svc.safeText('=1+1'), "'=1+1");
  assert.equal(svc.safeText('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(svc.safeText('+cmd|calc'), "'+cmd|calc");
  assert.equal(svc.safeText('-2+3*cmd'), "'-2+3*cmd");
  assert.equal(svc.safeText('+91 98765 43210'), '+91 98765 43210');
  assert.equal(svc.safeText('Normal text'), 'Normal text');
  assert.equal(svc.safeText(''), null);
  assert.equal(svc.safeText(null), null);
});

test('request validation rejects bad input', () => {
  const bad = (body, re) => assert.throws(() => svc.parseExportRequest(body), (e) => e.statusCode === 400 && re.test(e.message));
  bad({ date_from: '2026-10-29', date_to: '2026-10-01' }, /start date cannot be later/);
  bad({ date_from: '2026-10-01' }, /both start and end date/);
  bad({ date_from: '2026-02-30', date_to: '2026-03-01' }, /valid YYYY-MM-DD/);
  bad({ date_field: 'deleted_at' }, /date_field/);
  bad({ timezone: 'Mars/Base' }, /timezone/);
  bad({ filters: { nope: 1 } }, /unknown filter/);
  bad({ filters: { status: ['BOGUS'] } }, /invalid value/);
  bad({ filters: { min_score: 80, max_score: 20 } }, /minimum score/);
  bad({ filters: { min_score: 101 } }, /between 0 and 100/);
  bad({ columns: [] }, /at least one column/);
  bad({ columns: ['lead_id', 'ssn'] }, /unknown column/);
  // No dates = all time; never a silent "today".
  const all = svc.parseExportRequest({});
  assert.equal(all.dateFrom, undefined);
  assert.equal(svc.utcRange(all), null);
});

/* ---------------- query semantics ---------------- */

const count = (body) => svc.countMatching(svc.parseExportRequest(body));

test('all-time export covers every lead', async () => {
  assert.equal(await count({}), 5);
});

test('custom date range is inclusive of the whole end date, in the user timezone', async () => {
  assert.equal(await count(OCT), 3); // A (start boundary), B, C (23:59:59 on end date); not D or E
  const { ws } = await exportToWorkbook(OCT);
  assert.deepEqual(exportedIds(ws).sort(), [ids.a.l.id, ids.b.l.id, ids.c.l.id].sort());
  // Same range in UTC shifts which records fall inside.
  assert.equal(await count({ date_from: '2026-10-01', date_to: '2026-10-29', timezone: 'UTC' }), 3); // B, C, D
});

test('each filter narrows correctly', async () => {
  const cases = [
    [{ city: 'ahmedabad' }, 4],
    [{ state: 'Maharashtra' }, 1],
    [{ industry: 'Hotel' }, 4],
    [{ category: 'Hospitality' }, 1],
    [{ company_name: 'Budget' }, 1],
    [{ website: 'grandhotel' }, 1],
    [{ email: 'SALES@' }, 1],
    [{ phone: '98765' }, 1],
    [{ employees_min: 10, employees_max: 50 }, 1],
    [{ source: ['automation'] }, 1],
    [{ provider: 'osm' }, 1],
    [{ search_run_id: ids.run }, 1],
    [{ status: ['QUALIFIED'] }, 1],
    [{ contact_status: ['CONTACTED'] }, 1],
    [{ contacted: 'yes' }, 1],
    [{ contacted: 'no' }, 4],
    [{ assigned_user_id: agent.id }, 1],
    [{ assigned_user_id: 'unassigned' }, 4],
    [{ follow_up: 'due' }, 1],
    [{ follow_up: 'none' }, 4],
    [{ min_score: 60 }, 4],
    [{ max_score: 60 }, 1],
    [{ priority: ['HIGH'] }, 1],
    [{ lead_temperature: ['WARM'] }, 1],
    [{ lead_status: ['QUALIFIED'] }, 1],
    [{ has_website: 'yes' }, 1],
    [{ has_website: 'no' }, 4],
    [{ website_status: ['live'] }, 1],
    [{ signal_types: ['OUTDATED_WEBSITE', 'ONLINE_BOOKING_GAP'] }, 1],
  ];
  for (const [filters, expected] of cases) {
    assert.equal(await count({ filters }), expected, `filters ${JSON.stringify(filters)}`);
  }
});

test('multiple filters combine with AND (spec example)', async () => {
  const body = { ...OCT, filters: { city: 'Ahmedabad', industry: 'Hotels', min_score: 60, status: ['NEW'] } };
  assert.equal(await count(body), 2); // A and C
  const { ws, written } = await exportToWorkbook(body);
  assert.equal(written, 2);
  assert.deepEqual(exportedIds(ws).sort(), [ids.a.l.id, ids.c.l.id].sort());
});

test('zero matches exports only the header row', async () => {
  const body = { filters: { city: 'Nowhere' } };
  assert.equal(await count(body), 0);
  const { ws, written } = await exportToWorkbook(body);
  assert.equal(written, 0);
  assert.equal(ws.actualRowCount, 1);
});

/* ---------------- workbook content ---------------- */

test('workbook is valid, formatted, and holds the right data', async () => {
  const { wb, ws, written } = await exportToWorkbook({ ...OCT, filters: { company_name: 'Grand' } });
  assert.equal(written, 1);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Leads', 'Export Info']);
  assert.equal(headers(ws).length, svc.COLUMNS.length);
  assert.deepEqual(ws.views[0], { ...ws.views[0], state: 'frozen', ySplit: 1 });
  assert.ok(ws.autoFilter, 'header row has an autofilter');

  // One-to-many relations collapse into one row (no duplicate lead).
  assert.equal(ws.actualRowCount, 2);
  const cell = (h) => column(ws, h)[0];
  assert.equal(cell('Email'), 'info@grandhotel.example');
  assert.equal(cell('Other Emails'), 'sales@grandhotel.example');
  assert.equal(cell('Phone Number'), '07912345678'); // leading zero kept, stored as text
  assert.equal(typeof cell('Phone Number'), 'string');
  assert.equal(cell('Alternative Phone'), '+91 98765 43210');
  assert.equal(cell('Contact Person'), 'Ravi Patel');
  assert.equal(cell('Detected Signals'), 'OUTDATED_WEBSITE (HIGH); ONLINE_BOOKING_GAP (MEDIUM)');
  assert.equal(cell('Discovery Providers'), 'osm; serper');
  assert.equal(cell('Search Run IDs'), String(ids.run));
  assert.equal(cell('Website Audit Status'), 'live');
  assert.equal(cell('Assigned User'), 'Agent Smith');
  assert.equal(cell('Lead Score'), 72);
  assert.equal(cell('Created Date'), '2026-10-01 00:00:00'); // rendered in Asia/Kolkata
  assert.match(cell('Notes'), /Called, wants a quote/);
  assert.ok(cell('Notes').includes('---\n@SUM(1,2)')); // mid-cell text can't trigger a formula; stays a text cell
  // Missing optional values stay blank — nothing fabricated.
  assert.equal(cell('Last Contacted Date'), null);
  assert.equal(cell('Lost Reason'), null);

  const info = wb.getWorksheet('Export Info');
  const infoMap = {};
  info.eachRow((r, n) => n > 1 && (infoMap[r.getCell(1).value] = r.getCell(2).value));
  assert.equal(infoMap['Total Leads Exported'], 1);
  assert.equal(infoMap['Date Range'], 'October 1, 2026 – October 29, 2026');
  assert.match(infoMap['Applied Filters'], /Company: Grand/);
});

test('formula-like company names are written as inert text', async () => {
  const { ws } = await exportToWorkbook({ filters: { company_name: 'HYPERLINK' } });
  const v = column(ws, 'Company Name')[0];
  assert.equal(v, `'=HYPERLINK("http://evil","x")`);
  assert.equal(column(ws, 'CIN')[0], '00123');
});

test('selected columns only, in canonical order', async () => {
  const { ws } = await exportToWorkbook({ columns: ['lead_score', 'company_name', 'lead_id'] });
  assert.deepEqual(headers(ws), ['Lead ID', 'Company Name', 'Lead Score']);
  assert.equal(ws.actualRowCount, 6);
});

test('large datasets page through every batch with no duplicates or truncation', async () => {
  const n = svc.BATCH_SIZE * 2 + 37;
  const companies = await Company.bulkCreate(Array.from({ length: n }, (_, i) => ({ company_name: `Bulk ${i}`, city: 'Bulkville', source: 'csv' })));
  await Lead.bulkCreate(companies.map((c) => ({ company_id: c.id, lead_score: 10 })));
  // Extra contacts on every company must not multiply rows.
  await CompanyContact.bulkCreate(companies.flatMap((c) => [
    { company_id: c.id, type: 'email', value: `a${c.id}@x.test` },
    { company_id: c.id, type: 'email', value: `b${c.id}@x.test` },
  ]));

  const body = { filters: { city: 'Bulkville' }, columns: ['lead_id', 'email'] };
  assert.equal(await count(body), n);
  const { ws, written } = await exportToWorkbook(body);
  assert.equal(written, n);
  const got = exportedIds(ws);
  assert.equal(got.length, n);
  assert.equal(new Set(got).size, n);
});

/* ---------------- HTTP: auth, preview, download, errors ---------------- */

test('endpoints require authentication', async () => {
  assert.equal((await post('/leads/export/preview', {}, null)).status, 401);
  assert.equal((await post('/leads/export', {}, null)).status, 401);
  assert.equal((await post('/leads/export', {}, 'not-a-token')).status, 401);
  const inactive = await User.create({ name: 'Gone', email: 'gone@test.local', password_hash: 'x', is_active: false });
  assert.equal((await post('/leads/export', {}, signToken(inactive))).status, 401);
});

test('preview returns the real count and a summary', async () => {
  const r = await post('/leads/export/preview', { ...OCT, filters: { city: 'Ahmedabad', min_score: 60 } });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.count, 2);
  assert.equal(data.summary.dateRange, 'October 1, 2026 – October 29, 2026');
  assert.deepEqual(data.summary.filters, ['City: Ahmedabad', 'Score >= 60']);
});

test('POST /leads/export downloads a valid xlsx and records history', async () => {
  const r = await post('/leads/export', { ...OCT, filters: { city: 'Ahmedabad' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="leads-export-.*\.xlsx"/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.equal(wb.getWorksheet('Leads').actualRowCount, 4); // header + A, B, C

  const last = await LeadExport.findOne({ order: [['id', 'DESC']] });
  assert.equal(last.status, 'SUCCESS');
  assert.equal(last.row_count, 3);
  assert.equal(last.user_id, admin.id);
  assert.deepEqual(last.filters, { city: 'Ahmedabad' });
  // Metadata only — no lead data stored.
  assert.ok(!JSON.stringify(last.toJSON()).includes('Grand Hotel'));

  const h = await fetch(`${base}/leads/export/history`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await h.json()).data.items[0].row_count, 3);
});

test('export errors return clear JSON', async () => {
  let r = await post('/leads/export', { date_from: '2026-10-29', date_to: '2026-10-01' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /start date cannot be later/);

  r = await post('/leads/export', { filters: { city: 'Nowhere' } });
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /No leads match/);

  exportCtrl._inFlight.add(admin.id);
  r = await post('/leads/export', {});
  exportCtrl._inFlight.delete(admin.id);
  assert.equal(r.status, 429);
});

test('export never modifies lead records', async () => {
  const before = await Lead.findAll({ order: [['id', 'ASC']], raw: true });
  await post('/leads/export', {}).then((r) => r.arrayBuffer());
  const after = await Lead.findAll({ order: [['id', 'ASC']], raw: true });
  assert.deepEqual(after, before);
});

test('meta lists real columns and options', async () => {
  const r = await fetch(`${base}/leads/export/meta`, { headers: { Authorization: `Bearer ${token}` } });
  const { data } = await r.json();
  assert.equal(data.columns.length, svc.COLUMNS.length);
  assert.ok(data.providers.includes('osm'));
  assert.ok(data.sources.includes('automation'));
  assert.equal(data.search_runs[0].id, ids.run);
});
