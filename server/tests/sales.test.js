/**
 * AI Sales Intelligence: admin-only access, per-focus task queueing and duplicate
 * prevention, playbook validation (only Codefloor services, no unknown fields),
 * versioned history with carry-over, sales-pack drafts (purpose/channel), admin edits,
 * approval -> mark as sent, follow-up scheduling, dashboard and the auto schedule.
 * In-memory SQLite by default; TEST_DB_URL runs it on MySQL/TiDB or Postgres.
 *   npm --prefix server run test:sales
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
const app = require('../app');

const { sequelize, User, Company, CompanyContact, Lead, AgentTask, SalesPlaybook, Outreach, Task, Activity, AuditLog } = db;

let server;
let base;
let agentToken;
const u = {};
const tok = {};
const ids = {};

async function call(method, p, token, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const admin = (m, p, b) => call(m, p, tok.admin, b);
const bot = (m, p, b) => call(m, p, agentToken, b, { 'X-Agent-Session': 'sales-session', 'X-Agent-Tool': 'test' });

const FULL = {
  intelligence: {
    industry: 'Dental clinic',
    business_model: 'Appointment-based local healthcare practice',
    services: ['General dentistry'],
    website_findings: ['No website found by discovery'],
    software_opportunities: ['Online appointment booking'],
    relevant_services: ['Business website development', 'Custom web application development'],
    lead_quality: { rating: 'high', reasons: ['Score 72', 'No website'] },
    missing_information: ['Decision-maker name'],
  },
  sales_angle: { best_angle: 'Patients cannot book online', primary_pain_point: 'Bookings only by phone', recommended_solution: 'Website with appointment booking', conversation_opener: 'I could not find a website for Sunrise Dental.', why_codefloor: 'Codefloor IT builds business websites and custom web applications.' },
  closing: { recommended_next_step: 'Call the clinic and offer a short demo' },
  follow_up_schedule: [{ day: 3, channel: 'EMAIL', action: 'Follow up on the cold email' }, { day: 7, channel: 'PHONE', action: 'Call reception' }],
};

test.before(async () => {
  await sequelize.sync({ force: true });
  const pw = await User.hashPassword('Password123');
  u.admin = await User.create({ name: 'Main Admin', email: 'admin@test.local', password_hash: pw, role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'manager@test.local', password_hash: pw, role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'bde@test.local', password_hash: pw, role: 'agent' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);
  const c = await Company.create({ company_name: 'Sunrise Dental', source: 'csv', industry: 'Dental clinic', city: 'Pune' });
  await CompanyContact.create({ company_id: c.id, type: 'phone', value: '+91 98765 43210' });
  ids.lead = (await Lead.create({ company_id: c.id, lead_score: 72 })).id;
  const c2 = await Company.create({ company_name: 'Alpha Bakery', source: 'csv' });
  ids.lead2 = (await Lead.create({ company_id: c2.id, lead_score: 65 })).id;
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  agentToken = (await admin('POST', '/agent/token')).body.data.token;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

test('sales intelligence is Main Admin only; the agent token cannot reach the admin side', async () => {
  for (const who of ['manager', 'bde']) {
    assert.equal((await call('GET', '/agent/sales/overview', tok[who])).status, 403, who);
    assert.equal((await call('POST', `/agent/sales/leads/${ids.lead}/queue`, tok[who], { focus: 'full' })).status, 403, who);
  }
  assert.equal((await bot('GET', '/agent/sales/overview')).status, 403);
  assert.equal((await bot('POST', `/agent/sales/leads/${ids.lead}/queue`, { focus: 'full' })).status, 403);
  assert.equal((await call('POST', '/agent/bridge/playbooks', tok.admin, { lead_id: ids.lead })).status, 403, 'a browser session cannot write as the agent');
});

test('buttons queue one sales_strategy task per lead and focus; duplicates are refused', async () => {
  const r = await admin('POST', `/agent/sales/leads/${ids.lead}/queue`, { focus: 'full' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.type, 'sales_strategy');
  assert.equal(r.body.data.input.focus, 'full');
  assert.equal(r.body.data.title, 'Full sales strategy: Sunrise Dental');
  ids.task = r.body.data.id;
  assert.equal((await admin('POST', `/agent/sales/leads/${ids.lead}/queue`, { focus: 'full' })).status, 409, 'same focus twice');
  assert.equal((await admin('POST', `/agent/sales/leads/${ids.lead}/queue`, { focus: 'whatsapp' })).status, 201, 'a different focus can wait alongside');
  assert.equal((await admin('POST', `/agent/sales/leads/${ids.lead}/queue`, { focus: 'delete_everything' })).status, 400);
  assert.ok(await AuditLog.findOne({ where: { action: 'sales.task_queued' } }));
});

test('the agent claims the task and saves a validated playbook', async () => {
  await admin('PUT', '/agent/config', { min_lead_score: 0 });
  await bot('POST', '/agent/bridge/heartbeat', { client: 'test' });
  assert.equal((await admin('POST', '/agent/control', { action: 'start' })).status, 200);
  const claim = await bot('POST', '/agent/bridge/tasks/claim');
  assert.equal(claim.body.data.task.id, ids.task, 'the full strategy was queued first');

  const notOurs = await bot('POST', '/agent/bridge/playbooks', { lead_id: ids.lead, task_id: ids.task, confidence: 70, sections: { intelligence: { relevant_services: ['SEO and digital marketing'] } } });
  assert.equal(notOurs.status, 400, 'services Codefloor does not offer are refused');
  assert.match(notOurs.body.message, /relevant_services/);
  const unknown = await bot('POST', '/agent/bridge/playbooks', { lead_id: ids.lead, task_id: ids.task, confidence: 70, sections: { testimonials: ['Great work!'] } });
  assert.equal(unknown.status, 400, 'unknown sections are refused, not stored');
  assert.equal((await bot('POST', '/agent/bridge/playbooks', { lead_id: ids.lead, task_id: ids.task, confidence: 70, sections: { follow_up_schedule: [{ day: 3, channel: 'FAX', action: 'x' }] } })).status, 400);

  const r = await bot('POST', '/agent/bridge/playbooks', { lead_id: ids.lead, task_id: ids.task, confidence: 70, source_urls: ['https://www.openstreetmap.org/node/1'], sections: FULL });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.version, 1);
  assert.equal(r.body.data.lead_quality, 'high');
  assert.equal(r.body.data.next_step, 'Call the clinic and offer a short demo');
  ids.pb1 = r.body.data.id;
});

test('sales-pack drafts carry a purpose that must match the channel', async () => {
  const mismatch = await bot('POST', '/agent/bridge/outreach', { lead_id: ids.lead, task_id: ids.task, channel: 'EMAIL', purpose: 'whatsapp', body: 'Hi', evidence: [] });
  assert.equal(mismatch.status, 400);
  const wa = await bot('POST', '/agent/bridge/outreach', { lead_id: ids.lead, task_id: ids.task, playbook_id: ids.pb1, channel: 'WHATSAPP', purpose: 'whatsapp', body: 'Hi, this is Codefloor IT. I could not find a website for Sunrise Dental…', evidence: ['No website found by discovery'] });
  assert.equal(wa.status, 201);
  assert.equal(wa.body.data.status, 'PENDING_APPROVAL');
  ids.wa = wa.body.data.id;
  const call_ = await bot('POST', '/agent/bridge/outreach', { lead_id: ids.lead, task_id: ids.task, playbook_id: ids.pb1, channel: 'PHONE_TALKING_POINTS', purpose: 'call_script', body: '1. Introduce Codefloor IT\n2. Ask how patients book today', evidence: [] });
  assert.equal(call_.status, 201);
  assert.equal((await bot('POST', '/agent/bridge/outreach', { lead_id: ids.lead, playbook_id: 999999, channel: 'WHATSAPP', purpose: 'whatsapp', body: 'x', evidence: [] })).status, 400, 'foreign playbook');
  assert.equal((await bot('POST', `/agent/bridge/tasks/${ids.task}/complete`, { summary: 'Playbook v1 + 2 drafts' })).status, 200);
});

test('a focused task saves a new version and keeps the earlier sections', async () => {
  const claim = await bot('POST', '/agent/bridge/tasks/claim');
  const t = claim.body.data.task;
  assert.equal(t.input.focus, 'whatsapp');
  const ctx = await bot('GET', `/agent/bridge/playbooks/${ids.lead}`);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.data.playbook.version, 1);
  assert.equal(ctx.body.data.codefloor_services.length, 5);
  assert.equal(ctx.body.data.drafts.length, 2);
  const r = await bot('POST', '/agent/bridge/playbooks', { lead_id: ids.lead, task_id: t.id, confidence: 60, sections: { objections: [{ objection: 'Your price is too high', response: 'Ask which outcome matters most and scope a smaller first phase.', next_action: 'Offer a phased quote' }] } });
  assert.equal(r.body.data.version, 2);
  assert.equal(r.body.data.content.intelligence.industry, 'Dental clinic', 'carried over');
  assert.equal(r.body.data.content.objections.length, 1);
  assert.deepEqual(r.body.data.source_urls, ['https://www.openstreetmap.org/node/1'], 'sources carried over');
  await bot('POST', `/agent/bridge/tasks/${t.id}/complete`, { summary: 'objections' });
  assert.equal(await SalesPlaybook.count({ where: { lead_id: ids.lead } }), 2, 'history kept');
});

test('admin sees history, edits a playbook (validated, audited)', async () => {
  const r = await admin('GET', `/agent/sales/leads/${ids.lead}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.playbooks.map((p) => p.version), [2, 1]);
  assert.equal(r.body.data.drafts.length, 2);
  assert.ok(r.body.data.focus.call_script);

  const e = await admin('PUT', `/agent/sales/playbooks/${ids.pb1}`, { sections: { closing: { recommended_next_step: 'Visit the clinic in person' } } });
  assert.equal(e.status, 200);
  assert.equal(e.body.data.next_step, 'Visit the clinic in person');
  assert.equal(e.body.data.edited_by_user_id, u.admin.id);
  assert.equal(e.body.data.content.sales_angle.best_angle, 'Patients cannot book online', 'other sections untouched');
  assert.equal((await admin('PUT', `/agent/sales/playbooks/${ids.pb1}`, { sections: { intelligence: { relevant_services: ['Mobile apps'] } } })).status, 400);
  assert.ok(await AuditLog.findOne({ where: { action: 'sales.playbook_edited' } }));
});

test('only an approved draft can be marked sent, once; it records contact activity', async () => {
  assert.equal((await admin('POST', `/agent/outreach/${ids.wa}/sent`)).status, 409, 'still pending approval');
  assert.equal((await admin('POST', `/agent/outreach/${ids.wa}/approve`, {})).status, 200);
  const r = await admin('POST', `/agent/outreach/${ids.wa}/sent`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.sent_at);
  assert.equal((await admin('POST', `/agent/outreach/${ids.wa}/sent`)).status, 409, 'not twice');
  const lead = await Lead.findByPk(ids.lead);
  assert.equal(lead.contact_status, 'CONTACTED');
  assert.equal(lead.contact_method, 'WHATSAPP');
  assert.ok(await Activity.findOne({ where: { lead_id: ids.lead, type: 'contacted', title: 'whatsapp sent by Main Admin' } }));
});

test('the follow-up schedule becomes follow-up tasks, without duplicates on re-run', async () => {
  const r = await admin('POST', `/agent/sales/playbooks/${ids.pb1}/follow-ups`);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data, { created: 2, skipped: 0 });
  const again = await admin('POST', `/agent/sales/playbooks/${ids.pb1}/follow-ups`);
  assert.deepEqual(again.body.data, { created: 0, skipped: 2 });
  const tasks = await Task.findAll({ where: { lead_id: ids.lead, is_follow_up: true } });
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((t) => t.follow_up_method === 'PHONE').title, 'Follow-up (phone): Call reception');
});

test('dashboard counts', async () => {
  const r = await admin('GET', '/agent/sales/overview');
  assert.equal(r.status, 200);
  const t = r.body.data.totals;
  assert.equal(t.leads_with_playbook, 1);
  assert.equal(t.high_potential, 1, 'v2 carries over the high rating from v1');
  assert.equal(t.leads_with_pitches, 1);
  assert.equal(t.leads_awaiting_approval, 1, 'the call script is still pending');
  assert.equal(t.pending_sales_actions, 0, 'the approved WhatsApp draft was sent');
  assert.equal(r.body.data.last_30_days.drafts_sent, 1);
  assert.equal(r.body.data.history.length, 2);
});

test('auto schedule queues a full strategy for new uncontacted leads only, once', async () => {
  await admin('PUT', '/agent/config', { schedules: { auto_sales_new_leads: true }, auto_sales_per_day: 5 });
  await bot('POST', '/agent/bridge/tasks/claim'); // claiming runs the schedule
  const auto = await AgentTask.findAll({ where: { type: 'sales_strategy', created_by_user_id: null } });
  assert.deepEqual(auto.map((t) => t.lead_id), [ids.lead2], 'the contacted lead is skipped');
  assert.equal(auto[0].input.focus, 'full');
  await bot('POST', '/agent/bridge/tasks/claim');
  assert.equal(await AgentTask.count({ where: { type: 'sales_strategy', created_by_user_id: null } }), 1, 'not queued twice');
  assert.equal((await admin('PUT', '/agent/config', { auto_sales_per_day: 0 })).status, 400);
});
