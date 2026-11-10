/**
 * Client & Project Finance: Main-Admin-only access (employees and the Claude agent token
 * get 403), client/project CRUD, manual payments (multiple deposits, partial + final,
 * overpayment and duplicate guards, voiding), invoices kept separate from payments,
 * file uploads checked by content, dashboard figures, reports + CSV/Excel export and the
 * audit trail. In-memory SQLite — never touches server/.env's DB.
 *   npm --prefix server run test:finance
 */
process.env.DATABASE_URL = process.env.TEST_DB_URL || '';
process.env.DB_DIALECT = process.env.TEST_DB_URL ? (process.env.TEST_DB_URL.startsWith('postgres') ? 'postgres' : 'mysql') : 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const finance = require('../services/financeService');
const app = require('../app');

const { sequelize, User, AuditLog, ProjectPayment, ClientDocument } = db;

let server;
let base;
const u = {};
const tok = {};
const ids = {};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function call(method, p, token, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(base + p, {
    method,
    headers: { ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const admin = (m, p, b) => call(m, p, tok.admin, b);
const form = (fields, file) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.append(k, String(v));
  if (file) f.append(file.field, new Blob([file.data]), file.name);
  return f;
};
const projectOf = async (id) => (await admin('GET', `/finance/projects/${id}`)).body.data.project;

test.before(async () => {
  await sequelize.sync({ force: true });
  const pw = await User.hashPassword('Password123');
  u.admin = await User.create({ name: 'Main Admin', email: 'admin@test.local', password_hash: pw, role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'manager@test.local', password_hash: pw, role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'bde@test.local', password_hash: pw, role: 'agent' });
  u.viewer = await User.create({ name: 'Vik Viewer', email: 'viewer@test.local', password_hash: pw, role: 'viewer' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

test('money is parsed exactly in paise', () => {
  assert.equal(finance.toPaise('1,00,000.50', 'x'), 10000050);
  assert.equal(finance.toPaise(0.1, 'x') + finance.toPaise(0.2, 'x'), 30);
  assert.throws(() => finance.toPaise('10.005', 'x'));
  assert.throws(() => finance.toPaise('-5', 'x'));
  assert.throws(() => finance.toPaise('0', 'x'));
  assert.equal(finance.toPaise('0', 'x', { allowZero: true }), 0);
});

test('finance API is Main Admin only — employees, anonymous and the agent token are refused', async () => {
  for (const who of ['manager', 'bde', 'viewer']) {
    for (const [m, p] of [['GET', '/finance/dashboard'], ['GET', '/finance/clients'], ['POST', '/finance/clients'], ['GET', '/finance/payments'], ['GET', '/finance/reports/monthly?format=csv'], ['GET', '/finance/documents/1/file']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(m, p, tok[who], m === 'POST' ? { name: 'X' } : undefined);
      assert.equal(r.status, 403, `${who} ${m} ${p}`);
    }
  }
  assert.equal((await call('GET', '/finance/clients')).status, 401);
  const issued = await admin('POST', '/agent/token');
  const agent = await call('GET', '/finance/dashboard', issued.body.data.token);
  assert.equal(agent.status, 403);
  const me = await admin('GET', '/auth/me');
  assert.ok(me.body.data.permissions.includes('finance.manage'));
  const bdeMe = await call('GET', '/auth/me', tok.bde);
  assert.ok(!bdeMe.body.data.permissions.includes('finance.manage'));
});

test('clients: create, validate, edit, archive and restore', async () => {
  assert.equal((await admin('POST', '/finance/clients', { company_name: 'No name' })).status, 400);
  assert.equal((await admin('POST', '/finance/clients', { name: 'Bad', email: 'not-an-email' })).status, 400);
  const r = await admin('POST', '/finance/clients', { name: 'Asha Mehta', company_name: 'Sunrise Dental', email: 'asha@sunrise.example', phone: '+91 98200 00000', address: 'Pune' });
  assert.equal(r.status, 201);
  ids.client = r.body.data.client.id;
  ids.other = (await admin('POST', '/finance/clients', { name: 'Other Co' })).body.data.client.id;

  const up = await admin('PUT', `/finance/clients/${ids.client}`, { contact_person: 'Asha', notes: 'Prefers UPI' });
  assert.equal(up.body.data.client.contact_person, 'Asha');
  assert.equal(up.body.data.client.name, 'Asha Mehta');

  assert.equal((await admin('POST', `/finance/clients/${ids.other}/archive`)).status, 200);
  const active = (await admin('GET', '/finance/clients')).body.data.items.map((c) => c.id);
  assert.ok(active.includes(ids.client) && !active.includes(ids.other));
  const archived = (await admin('GET', '/finance/clients?archived=true')).body.data.items.map((c) => c.id);
  assert.deepEqual(archived, [ids.other]);
  assert.equal((await admin('POST', '/finance/projects', { client_id: ids.other, name: 'Blocked', project_value: 10 })).status, 400);
  await admin('POST', `/finance/clients/${ids.other}/restore`);
  assert.equal((await admin('GET', '/finance/clients?search=sunrise')).body.data.items.length, 1);
});

test('projects: create, status, value cannot drop below what was received', async () => {
  const r = await admin('POST', '/finance/projects', { client_id: ids.client, name: 'Clinic website', project_value: '100000', status: 'CONFIRMED', start_date: '2026-01-05', expected_delivery_date: '2026-03-01' });
  assert.equal(r.status, 201);
  ids.project = r.body.data.project.id;
  assert.equal(r.body.data.project.remaining_balance, '100000.00');
  assert.equal(r.body.data.project.completion_percent, 0);
  assert.equal((await admin('POST', '/finance/projects', { client_id: ids.client, name: 'Bad status', project_value: 5, status: 'DONE' })).status, 400);
  ids.otherProject = (await admin('POST', '/finance/projects', { client_id: ids.other, name: 'Other project', project_value: 5000 })).body.data.project.id;
  const del = (await admin('POST', '/finance/projects', { client_id: ids.client, name: 'Scratch', project_value: 1 })).body.data.project.id;
  assert.equal((await admin('DELETE', `/finance/projects/${del}`)).status, 200);
});

test('payments: multiple deposits, partial and final; totals derived from valid payments only', async () => {
  const pay = (fields, file) => admin('POST', '/finance/payments', form({ client_id: ids.client, project_id: ids.project, payment_method: 'UPI', ...fields }, file));

  const d1 = await pay({ payment_date: '2026-01-05', amount: '20000', payment_type: 'ADVANCE_DEPOSIT', transaction_reference: 'UPI-001' }, { field: 'receipt', data: PNG, name: 'receipt.png' });
  assert.equal(d1.status, 201, JSON.stringify(d1.body));
  assert.equal(d1.body.data.receipt.mime_type, 'image/png');
  ids.receipt = d1.body.data.receipt.id;
  assert.equal((await pay({ payment_date: '2026-01-20', amount: '10000.50', payment_type: 'ADVANCE_DEPOSIT', transaction_reference: 'UPI-002' })).status, 201);
  const partial = await pay({ payment_date: '2026-02-10', amount: '30000', payment_type: 'PARTIAL', payment_method: 'BANK_TRANSFER' });
  assert.equal(partial.status, 201);
  ids.partial = partial.body.data.payment.id;

  let p = await projectOf(ids.project);
  assert.equal(p.total_received, '60000.50');
  assert.equal(p.total_deposits, '30000.50');
  assert.equal(p.remaining_balance, '39999.50');
  assert.equal(p.completion_percent, 60);

  // Guards: wrong client, overpayment, duplicate reference, same project/date/amount, future date
  assert.equal((await admin('POST', '/finance/payments', form({ client_id: ids.other, project_id: ids.project, payment_date: '2026-02-11', amount: 1, payment_type: 'OTHER', payment_method: 'CASH' }))).status, 400);
  const over = await pay({ payment_date: '2026-02-12', amount: '40000', payment_type: 'FINAL' });
  assert.equal(over.status, 400);
  assert.match(over.body.message, /remaining balance \(39999\.50\)/);
  assert.equal((await pay({ payment_date: '2026-02-12', amount: '5', payment_type: 'OTHER', transaction_reference: 'UPI-001' })).status, 409);
  const same = await pay({ payment_date: '2026-02-10', amount: '30000', payment_type: 'PARTIAL', payment_method: 'BANK_TRANSFER' });
  assert.equal(same.status, 409);
  assert.equal(same.body.details.needs_confirmation, true);
  assert.equal((await pay({ payment_date: '2099-01-01', amount: '5', payment_type: 'OTHER' })).status, 400);
  assert.equal((await pay({ payment_date: '2026-02-12', amount: '12.345', payment_type: 'OTHER' })).status, 400);
  assert.equal((await pay({ payment_date: '2026-02-12', amount: '5', payment_type: 'GIFT' })).status, 400);

  // Void a payment: excluded from totals, history kept, can't be edited
  const v = await admin('POST', `/finance/payments/${ids.partial}/void`, { reason: 'Entered on the wrong project' });
  assert.equal(v.status, 200);
  assert.equal((await admin('POST', `/finance/payments/${ids.partial}/void`, { reason: 'again' })).status, 409);
  assert.equal((await admin('PUT', `/finance/payments/${ids.partial}`, form({ amount: 1 }))).status, 409);
  p = await projectOf(ids.project);
  assert.equal(p.total_received, '30000.50');
  assert.equal(await ProjectPayment.count(), 3);

  // Re-recording the voided amount is fine now (no duplicate with a voided row)
  const again = await pay({ payment_date: '2026-02-10', amount: '30000', payment_type: 'MILESTONE', payment_method: 'BANK_TRANSFER' });
  assert.equal(again.status, 201);
  // Explicitly confirmed genuine repeat
  assert.equal((await pay({ payment_date: '2026-02-10', amount: '30000', payment_type: 'PARTIAL', payment_method: 'CHEQUE', confirm_duplicate: true })).status, 201);
  p = await projectOf(ids.project);
  assert.equal(p.remaining_balance, '9999.50');

  // Edit amount (re-checked against the balance), then the final payment clears it exactly
  const edit = await admin('PUT', `/finance/payments/${again.body.data.payment.id}`, form({ amount: '29999.50' }));
  assert.equal(edit.status, 200);
  assert.equal((await admin('PUT', `/finance/payments/${again.body.data.payment.id}`, form({ amount: '50000' }))).status, 400);
  assert.equal((await pay({ payment_date: '2026-03-01', amount: '10000', payment_type: 'FINAL', payment_method: 'CASH' })).status, 201);
  p = await projectOf(ids.project);
  assert.equal(p.total_received, '100000.00');
  assert.equal(p.remaining_balance, '0.00');
  assert.equal(p.completion_percent, 100);

  // Project value can't go below received; raising it reopens the balance
  assert.equal((await admin('PUT', `/finance/projects/${ids.project}`, { project_value: '90000' })).status, 400);
  const raised = await admin('PUT', `/finance/projects/${ids.project}`, { project_value: '120000', status: 'IN_PROGRESS' });
  assert.equal(raised.body.data.project.remaining_balance, '20000.00');
  assert.equal((await admin('DELETE', `/finance/projects/${ids.project}`)).status, 409);
});

test('invoices are separate records: status never creates or counts as a payment', async () => {
  const before = await projectOf(ids.project);
  const r = await admin('POST', '/finance/invoices', form({ invoice_number: 'CF-2026-001', client_id: ids.client, project_id: ids.project, invoice_date: '2026-02-01', due_date: '2026-02-15', amount: '20000', tax_amount: '3600', status: 'SENT' }, { field: 'pdf', data: PDF, name: 'inv.pdf' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.invoice.total_amount, '23600.00');
  assert.equal(r.body.data.invoice.is_overdue, true);
  ids.invoice = r.body.data.invoice.id;
  ids.invoicePdf = r.body.data.pdf.id;

  assert.equal((await admin('POST', '/finance/invoices', form({ invoice_number: 'CF-2026-001', client_id: ids.client, invoice_date: '2026-02-01', amount: 1 }))).status, 409);
  assert.equal((await admin('POST', '/finance/invoices', form({ invoice_number: 'CF-X', client_id: ids.client, project_id: ids.otherProject, invoice_date: '2026-02-01', amount: 1 }))).status, 400);
  assert.equal((await admin('POST', '/finance/invoices', form({ invoice_number: 'CF-PNG', client_id: ids.client, invoice_date: '2026-02-01', amount: 1 }, { field: 'pdf', data: PNG, name: 'x.pdf' }))).status, 400);

  const paid = await admin('PUT', `/finance/invoices/${ids.invoice}`, form({ status: 'PAID' }));
  assert.equal(paid.body.data.invoice.status, 'PAID');
  assert.equal(paid.body.data.invoice.total_amount, '23600.00');
  const after = await projectOf(ids.project);
  assert.equal(after.total_received, before.total_received);
  assert.equal(after.payments_count, before.payments_count);

  assert.equal((await admin('DELETE', `/finance/invoices/${ids.invoice}`)).status, 409);
  const draft = (await admin('POST', '/finance/invoices', form({ invoice_number: 'CF-DRAFT', client_id: ids.client, invoice_date: '2026-02-02', amount: 50 }))).body.data.invoice.id;
  assert.equal((await admin('DELETE', `/finance/invoices/${draft}`)).status, 200);

  const list = (await admin('GET', '/finance/invoices?search=CF-2026')).body.data.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].documents.length, 1);
  assert.equal((await admin('GET', '/finance/invoices?status=DRAFT')).body.data.items.length, 0);
});

test('documents: content-checked uploads, private download, receipts are kept', async () => {
  const fake = await admin('POST', '/finance/documents', form({ client_id: ids.client }, { field: 'file', data: Buffer.from('<script>alert(1)</script>'), name: 'contract.pdf' }));
  assert.equal(fake.status, 400);
  const up = await admin('POST', '/finance/documents', form({ client_id: ids.client, notes: 'Signed SOW' }, { field: 'file', data: PDF, name: 'SOW "final".pdf' }));
  assert.equal(up.status, 201);
  assert.equal(up.body.data.document.data, undefined);

  const dl = await admin('GET', `/finance/documents/${up.body.data.document.id}/file?inline=1`);
  assert.equal(dl.status, 200);
  assert.ok(dl.body.equals(PDF));
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /^inline/);
  assert.equal((await call('GET', `/finance/documents/${up.body.data.document.id}/file`, tok.manager)).status, 403);

  assert.equal((await admin('DELETE', `/finance/documents/${ids.receipt}`)).status, 409);
  assert.equal((await admin('DELETE', `/finance/documents/${up.body.data.document.id}`)).status, 200);
  assert.equal(await ClientDocument.count({ where: { client_id: ids.client } }), 2); // receipt + invoice PDF
});

test('client profile shows the full financial history and timeline', async () => {
  const r = await admin('GET', `/finance/clients/${ids.client}`);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.summary.total_value, '120000.00');
  assert.equal(d.summary.total_received, '100000.00');
  assert.equal(d.summary.total_deposits, '30000.50');
  assert.equal(d.summary.remaining_balance, '20000.00');
  assert.equal(d.payments.length, 6); // includes the voided one, flagged
  assert.equal(d.payments.filter((p) => p.voided_at).length, 1);
  assert.equal(d.invoices.length, 1);
  assert.ok(d.timeline.some((t) => t.type === 'payment_void'));
  assert.ok(d.timeline[0].date >= d.timeline[d.timeline.length - 1].date);
  const list = (await admin('GET', '/finance/clients')).body.data.items.find((c) => c.id === ids.client);
  assert.equal(list.total_received, '100000.00');
});

test('dashboard figures come from the recorded data', async () => {
  const r = await admin('GET', '/finance/dashboard?from=2026-01-01&to=2026-03-31');
  assert.equal(r.status, 200);
  const { cards, monthly, received_vs_pending: rvp, project_revenue: pr } = r.body.data;
  assert.equal(cards.total_clients, 2);
  assert.equal(cards.total_projects, 2);
  assert.equal(cards.total_project_value, '125000.00');
  assert.equal(cards.total_received, '100000.00');
  assert.equal(cards.total_deposits, '30000.50');
  assert.equal(cards.pending_payments, '25000.00');
  assert.equal(cards.active_projects, 1);
  assert.deepEqual(monthly.map((m) => m.month), ['2026-01', '2026-02', '2026-03']);
  assert.equal(monthly[0].deposits, 30000.5);
  assert.equal(monthly[2].cumulative, 100000);
  assert.deepEqual(rvp, [{ name: 'Received', value: 100000 }, { name: 'Pending', value: 25000 }]);
  assert.equal(pr[0].project, 'Clinic website');
  const jan = await admin('GET', '/finance/dashboard?from=2026-01-01&to=2026-01-31');
  assert.equal(jan.body.data.cards.received_in_range, '30000.50');
  assert.equal((await admin('GET', '/finance/dashboard?from=2026-05-01&to=2026-01-01')).status, 400);
});

test('reports: every type as JSON, CSV and Excel', async () => {
  for (const type of Object.keys(finance.REPORTS)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await admin('GET', `/finance/reports/${type}?from=2026-01-01&to=2026-12-31`);
    assert.equal(r.status, 200, type);
    assert.ok(Array.isArray(r.body.data.rows) && r.body.data.columns.length, type);
  }
  const monthly = (await admin('GET', '/finance/reports/monthly?from=2026-01-01&to=2026-03-31')).body.data.rows;
  assert.deepEqual(monthly.map((m) => m.received), ['30000.50', '59999.50', '10000.00']);
  const pending = (await admin('GET', '/finance/reports/pending')).body.data.rows;
  assert.deepEqual(pending.map((p) => p.remaining), ['20000.00', '5000.00']);
  const clients = (await admin('GET', '/finance/reports/clients?from=2026-01-01&to=2026-12-31')).body.data.rows;
  assert.equal(clients[0].received, '100000.00');

  const csv = await admin('GET', '/finance/reports/deposits?from=2026-01-01&to=2026-12-31&format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /deposits-report-2026-01-01-to-2026-12-31\.csv/);
  assert.match(csv.body.toString(), /UPI-001/);
  const xlsx = await admin('GET', '/finance/reports/invoices?from=2026-01-01&to=2026-12-31&format=xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  assert.equal((await admin('GET', '/finance/reports/nope')).status, 404);
});

test('every money change is in the audit trail, with no contact values', async () => {
  const rows = await AuditLog.findAll({ where: { resource_type: ['client', 'client_project', 'project_payment', 'project_invoice', 'client_document', 'finance_report'] } });
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['finance.client_created', 'finance.client_updated', 'finance.client_archived', 'finance.client_restored', 'finance.project_created', 'finance.project_value_changed', 'finance.project_deleted', 'finance.payment_created', 'finance.payment_updated', 'finance.payment_voided', 'finance.invoice_created', 'finance.invoice_updated', 'finance.invoice_deleted', 'finance.document_uploaded', 'finance.document_deleted', 'finance.report_exported']) {
    assert.ok(actions.has(a), a);
  }
  assert.ok(rows.every((r) => r.actor_user_id === u.admin.id));
  const text = JSON.stringify(rows.map((r) => r.metadata));
  assert.ok(!text.includes('asha@sunrise.example') && !text.includes('98200'));
  const valueChange = rows.find((r) => r.action === 'finance.project_value_changed');
  assert.deepEqual(valueChange.metadata, { from: '100000.00', to: '120000.00' });
});
