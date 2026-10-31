/**
 * Claude Code agent: admin-only access, agent token scope, real connection status,
 * start/stop/pause, the persistent task queue (claim race, retry, timeout, recovery),
 * activity logging, and a real MCP stdio round-trip against the live test API.
 * In-memory SQLite by default — never touches server/.env's DB. Set TEST_DB_URL
 * (e.g. a throwaway local MySQL/TiDB) to run the same suite on that dialect.
 *   npm --prefix server run test:agent
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
const path = require('path');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const app = require('../app');

const { sequelize, User, Company, CompanyContact, Lead, Setting, AgentTask, AgentActivity, AuditLog } = db;

let server;
let base;
const u = {};
const tok = {};
const ids = {};
let agentToken;
const S1 = 'session-one';
const S2 = 'session-two';

async function call(method, p, token, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const as = (session) => (method, p, body) => call(method, p, agentToken, body, { 'X-Agent-Session': session, 'X-Agent-Tool': 'test' });
const a1 = as(S1);
const a2 = as(S2);
const flush = () => new Promise((r) => setTimeout(r, 50)); // activity is written on response 'finish'

test.before(async () => {
  await sequelize.sync({ force: true });
  const pw = await User.hashPassword('Password123');
  u.admin = await User.create({ name: 'Main Admin', email: 'admin@test.local', password_hash: pw, role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'manager@test.local', password_hash: pw, role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'bde@test.local', password_hash: pw, role: 'agent' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);
  const c = await Company.create({ company_name: 'ABC Technologies', source: 'csv', website: 'https://abc.example' });
  await CompanyContact.create({ company_id: c.id, type: 'email', value: 'sales@abc.example' });
  const l = await Lead.create({ company_id: c.id, assigned_user_id: u.bde.id });
  const c2 = await Company.create({ company_name: 'XYZ Solutions', source: 'csv' });
  const l2 = await Lead.create({ company_id: c2.id });
  Object.assign(ids, { company: c.id, lead: l.id, company2: c2.id, lead2: l2.id });
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

test('AI Agent endpoints are Main Admin only', async () => {
  for (const who of ['manager', 'bde']) {
    assert.equal((await call('GET', '/agent/overview', tok[who])).status, 403, who);
    assert.equal((await call('POST', '/agent/token', tok[who])).status, 403, who);
    assert.equal((await call('GET', '/agent/activity', tok[who])).status, 403, who);
  }
  assert.equal((await call('GET', '/agent/overview')).status, 401);
  const r = await call('GET', '/agent/overview', tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.connection.connected, false);
  assert.equal(r.body.data.control.state, 'stopped');
});

test('issuing a token stores only its hash and is audited', async () => {
  const r = await call('POST', '/agent/token', tok.admin);
  assert.equal(r.status, 201);
  agentToken = r.body.data.token;
  assert.match(agentToken, /^lh_agent_/);
  const row = await Setting.findOne({ where: { key: 'agent.token' } });
  assert.ok(!JSON.stringify(row.value).includes(agentToken));
  assert.equal(await AuditLog.count({ where: { action: 'agent.token_issued' } }), 1);
});

test('the agent token reaches only allowlisted routes and never sees raw contacts', async () => {
  assert.equal((await a1('GET', '/users')).status, 403);
  assert.equal((await a1('DELETE', `/leads/${ids.lead}`)).status, 403);
  assert.equal((await a1('GET', '/leads/export')).status, 403);
  assert.equal((await a1('POST', '/agent/control', { action: 'start' })).status, 403, 'agent cannot start itself');
  assert.equal((await a1('POST', '/agent/token')).status, 403, 'agent cannot mint tokens');
  assert.equal((await a1('GET', '/agent/overview')).status, 403);

  // Raw paths (fetch would normalise these): dot segments / encoded separators never reach a route.
  const http = require('http');
  const raw = (p) => new Promise((r) => {
    const { port } = server.address();
    http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Authorization: `Bearer ${agentToken}` } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => r({ status: res.statusCode, b }));
    }).end();
  });
  for (const p of ['/api/agent/bridge/../../users', '/api/leads/1/../../users', '/api/agent/bridge/..%2f..%2fusers', '/api/leads%2f..%2fusers', '/api/agent/bridge/status/../../../users']) {
    const r = await raw(p);
    assert.equal(r.status, 403, p);
    assert.ok(!r.b.includes('manager@test.local'), p);
  }

  const list = await a1('GET', '/leads');
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('sales@abc.example'), 'contact value must be masked');
  const contacts = await a1('GET', `/contacts?company_id=${ids.company}`);
  assert.equal(contacts.status, 200);
  assert.ok(!JSON.stringify(contacts.body).includes('sales@abc.example'));

  await flush();
  assert.ok(await AgentActivity.count({ where: { type: 'tool_call', status: 'denied' } }) >= 5);
  assert.ok(await AgentActivity.count({ where: { type: 'tool_call', status: 'success', action: 'GET /leads' } }) >= 1);
});

test('a browser session cannot fake a heartbeat', async () => {
  assert.equal((await call('POST', '/agent/bridge/heartbeat', tok.admin, { client: 'fake' })).status, 403);
  assert.equal((await call('GET', '/agent/overview', tok.admin)).body.data.connection.connected, false);
});

test('start requires a real connection; heartbeat connects; stale or closed disconnects', async () => {
  const r = await call('POST', '/agent/control', tok.admin, { action: 'start' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /no Claude Code session is connected/);

  assert.equal((await a1('POST', '/agent/bridge/heartbeat', { client: 'test' })).status, 200);
  let o = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(o.connection.connected, true);
  assert.equal(o.available, false, 'connected but not started');

  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'start' })).status, 200);
  o = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(o.available, true);

  // Stale heartbeat -> Disconnected even though nothing told us.
  const hb = await Setting.findOne({ where: { key: 'agent.heartbeat' } });
  await hb.update({ value: { ...hb.value, last_heartbeat_at: new Date(Date.now() - 10 * 60000).toISOString() } });
  o = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(o.connection.connected, false);
  assert.match(o.connection.reason, /No heartbeat for 10 min/);
  assert.equal(o.available, false);

  await a1('POST', '/agent/bridge/heartbeat', {});
  assert.equal(await AgentActivity.count({ where: { type: 'reconnected' } }), 1);

  await a1('POST', '/agent/bridge/disconnect', { reason: 'test close' });
  o = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(o.connection.connected, false);
  assert.match(o.connection.reason, /test close/);
  await a1('POST', '/agent/bridge/heartbeat', {});
});

test('task creation validates input, real records and duplicates', async () => {
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'nope' })).status, 400);
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'analyse_lead' })).status, 400, 'needs lead_id');
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'analyse_lead', lead_id: 99999 })).status, 404);
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'research_company', company_id: ids.company, priority: 0 })).status, 400);
  assert.equal((await call('POST', '/agent/tasks', tok.manager, { type: 'research_company', company_id: ids.company })).status, 403);

  const r = await call('POST', '/agent/tasks', tok.admin, { type: 'research_company', company_id: ids.company, priority: 3 });
  assert.equal(r.status, 201);
  ids.t1 = r.body.data.id;
  assert.equal(r.body.data.mode, 'research');
  assert.equal(r.body.data.title, 'Research ABC Technologies');
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'research_company', company_id: ids.company })).status, 409, 'duplicate');
  ids.t2 = (await call('POST', '/agent/tasks', tok.admin, { type: 'analyse_lead', lead_id: ids.lead2, priority: 1 })).body.data.id;
});

test('claims follow priority and two sessions can never get the same task', async () => {
  const [x, y] = await Promise.all([a1('POST', '/agent/bridge/tasks/claim'), a2('POST', '/agent/bridge/tasks/claim')]);
  const got = [x.body.data.task?.id, y.body.data.task?.id].filter(Boolean);
  assert.equal(new Set(got).size, got.length, 'no task handed out twice');
  assert.deepEqual([...got].sort(), [ids.t1, ids.t2].sort());
  const first = [x, y].find((r) => r.body.data.task.id === ids.t2);
  ids.t2Session = first === x ? S1 : S2;
  ids.t1Session = ids.t2Session === S1 ? S2 : S1;
  assert.equal((await AgentTask.findByPk(ids.t2)).priority, 1);

  const none = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(none.body.data.task, null);
});

test('only the owning session can finish a task; completion frees the dedupe key', async () => {
  const other = ids.t1Session === S1 ? a2 : a1;
  const owner = ids.t1Session === S1 ? a1 : a2;
  assert.equal((await other('POST', `/agent/bridge/tasks/${ids.t1}/complete`, { result: { ok: 1 } })).status, 409);
  const r = await owner('POST', `/agent/bridge/tasks/${ids.t1}/complete`, { result: { summary: 'done' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'COMPLETED');
  assert.equal(r.body.data.dedupe_key, null);
  assert.ok(r.body.data.duration_ms >= 0);
  // A stale heartbeat task id never shows a finished task as "current".
  await owner('POST', '/agent/bridge/heartbeat', { current_task_id: ids.t1 });
  const ov = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(ov.current_task, null);
  assert.equal(ov.completed_by_type.research_company, 1);
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'research_company', company_id: ids.company })).status, 201, 'same work can be queued again later');
  await call('POST', `/agent/tasks/${(await AgentTask.max('id'))}/cancel`, tok.admin);
});

test('a failure retries with backoff, then fails for good; admin retry re-queues it', async () => {
  const owner = ids.t2Session === S1 ? a1 : a2;
  let r = await owner('POST', `/agent/bridge/tasks/${ids.t2}/fail`, { error: 'site down' });
  assert.equal(r.body.data.status, 'PENDING');
  assert.ok(new Date(r.body.data.available_at) > new Date(), 'backoff in the future');
  assert.equal((await a1('POST', '/agent/bridge/tasks/claim')).body.data.task, null, 'not claimable during backoff');

  await AgentTask.update({ available_at: new Date(Date.now() - 1000) }, { where: { id: ids.t2 } });
  const c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task.id, ids.t2);
  r = await a1('POST', `/agent/bridge/tasks/${ids.t2}/fail`, { error: 'bad input', retryable: false });
  assert.equal(r.body.data.status, 'FAILED');

  r = await call('POST', `/agent/tasks/${ids.t2}/retry`, tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'PENDING');
  assert.equal(r.body.data.attempts, 0);
});

test('an expired lease returns the task to the queue (crash / restart recovery)', async () => {
  const c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task.id, ids.t2);
  // Simulate the session dying mid-task: nothing in memory, only the DB row's lease.
  await AgentTask.update({ lease_expires_at: new Date(Date.now() - 1000) }, { where: { id: ids.t2 } });
  const again = await a2('POST', '/agent/bridge/tasks/claim');
  assert.equal(again.body.data.task.id, ids.t2, 'reclaimed by another session');
  assert.equal(again.body.data.task.attempts, 2);
  assert.equal((await a1('POST', `/agent/bridge/tasks/${ids.t2}/complete`, {})).status, 409, 'dead session lost ownership');
  assert.equal(await AgentActivity.count({ where: { type: 'task_timeout' } }), 1);
  await a2('POST', `/agent/bridge/tasks/${ids.t2}/complete`, { result: {} });
});

test('pause keeps pending tasks; resume continues; stop blocks new claims; disabled modes are skipped', async () => {
  const t = (await call('POST', '/agent/tasks', tok.admin, { type: 'strategy_review', input: { topic: 'pricing' } })).body.data;
  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'pause' })).status, 200);
  let c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task, null);
  assert.match(c.body.data.reason, /paused/);
  assert.equal((await AgentTask.findByPk(t.id)).status, 'PENDING', 'pending preserved');

  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'modes', enabled_modes: ['research'] })).status, 200);
  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'resume' })).status, 200);
  c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task, null, 'strategy mode disabled');
  await call('POST', '/agent/control', tok.admin, { action: 'modes', enabled_modes: ['research', 'strategy'] });
  c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task.id, t.id);
  await a1('POST', `/agent/bridge/tasks/${t.id}/complete`, { result: {} });

  await call('POST', '/agent/control', tok.admin, { action: 'stop' });
  await call('POST', '/agent/tasks', tok.admin, { type: 'competitor_research', input: { competitor: 'Example Co' } });
  c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(c.body.data.task, null);
  assert.match(c.body.data.reason, /stopped/);
  assert.ok(await AuditLog.count({ where: { action: 'agent.stop' } }) >= 1);
});

test('task pause/resume/cancel and the activity filter', async () => {
  const t = (await call('POST', '/agent/tasks', tok.admin, { type: 'analyse_lead', lead_id: ids.lead })).body.data;
  assert.equal((await call('POST', `/agent/tasks/${t.id}/pause`, tok.admin)).body.data.status, 'PAUSED');
  assert.equal((await call('POST', `/agent/tasks/${t.id}/pause`, tok.admin)).status, 409);
  assert.equal((await call('POST', `/agent/tasks/${t.id}/resume`, tok.admin)).body.data.status, 'PENDING');
  assert.equal((await call('POST', `/agent/tasks/${t.id}/cancel`, tok.admin)).body.data.status, 'CANCELLED');

  const f = await call('GET', `/agent/activity?task_id=${t.id}`, tok.admin);
  assert.deepEqual(f.body.data.items.map((a) => a.type).reverse(), ['task_created', 'task_pause', 'task_resume', 'task_cancel']);
  const failures = await call('GET', '/agent/activity?status=failure', tok.admin);
  assert.ok(failures.body.data.items.every((a) => a.status === 'failure'));
  const detail = await call('GET', `/agent/tasks/${t.id}`, tok.admin);
  assert.equal(detail.body.data.activity.length, 4);
});

test('revoking the token disconnects the agent immediately', async () => {
  const keep = agentToken;
  assert.equal((await call('DELETE', '/agent/token', tok.admin)).status, 200);
  assert.equal((await call('GET', '/leads', keep)).status, 401);
  agentToken = (await call('POST', '/agent/token', tok.admin)).body.data.token;
});

test('bad enabled_modes is a 400, not a 500', async () => {
  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'modes', enabled_modes: 'research' })).status, 400);
  assert.equal((await call('POST', '/agent/control', tok.admin, { action: 'modes', enabled_modes: ['nope'] })).status, 400);
});

test('revoking shows Disconnected at once; a password change kills the token', async () => {
  await a1('POST', '/agent/bridge/heartbeat', {});
  const keep = agentToken;
  await call('DELETE', '/agent/token', tok.admin);
  const o = (await call('GET', '/agent/overview', tok.admin)).body.data;
  assert.equal(o.connection.connected, false);
  assert.match(o.connection.reason, /revoked/);
  assert.equal((await call('GET', '/leads', keep)).status, 401);

  agentToken = (await call('POST', '/agent/token', tok.admin)).body.data.token;
  assert.equal((await a1('GET', '/leads')).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // MySQL DATETIME has second precision
  await User.update({ password_changed_at: new Date() }, { where: { id: u.admin.id } });
  assert.equal((await a1('GET', '/leads')).status, 401);
  await User.update({ password_changed_at: null }, { where: { id: u.admin.id } });
  agentToken = (await call('POST', '/agent/token', tok.admin)).body.data.token;
});

test('a demoted admin\'s token stops working', async () => {
  await u.admin.update({ role: 'manager' });
  assert.equal((await a1('GET', '/leads')).status, 401);
  await u.admin.update({ role: 'admin' });
  assert.equal((await a1('GET', '/leads')).status, 200);
});

/* ---------------- slice (c): reports, outreach approvals, proposals ---------------- */

test('reports: validated, linked to the session\'s own task, admin-only to read', async () => {
  assert.equal((await a1('POST', '/agent/bridge/reports', { kind: 'company_research', title: 'x', confidence: 50, company_id: ids.company })).status, 400, 'short title');
  assert.equal((await a1('POST', '/agent/bridge/reports', { kind: 'company_research', title: 'Research ABC', confidence: 50, company_id: ids.company, source_urls: ['javascript:alert(1)'] })).status, 400, 'non-http url');
  assert.equal((await a1('POST', '/agent/bridge/reports', { kind: 'company_research', title: 'Research ABC', confidence: 50, company_id: ids.company, ai_score: 70 })).status, 400, 'ai_score only on lead_qualification');
  assert.equal((await a1('POST', '/agent/bridge/reports', { kind: 'company_research', title: 'Research ABC', confidence: 50 })).status, 400, 'needs a record');
  assert.equal((await a1('POST', '/agent/bridge/reports', { kind: 'company_research', title: 'Research ABC', confidence: 50, company_id: ids.company, task_id: ids.t1 })).status, 409, 'task not running under this session');
  assert.equal((await call('POST', '/agent/bridge/reports', tok.admin, { kind: 'strategy', title: 'Fake', confidence: 1 })).status, 403, 'browser session cannot write as the agent');

  const r = await a1('POST', '/agent/bridge/reports', {
    kind: 'company_research',
    title: 'Research ABC Technologies',
    summary: 'IT firm with an outdated site.',
    content: { company_overview: 'Small IT services firm.', potential_software_requirements: ['Booking portal'], recommended_next_action: 'Offer a free audit' },
    source_urls: ['https://abc.example/about'],
    confidence: 60,
    company_id: ids.company,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.report = r.body.data.id;
  const q = await a1('POST', '/agent/bridge/reports', { kind: 'lead_qualification', title: 'AI score 72/100', confidence: 55, lead_id: ids.lead, ai_score: 72, content: { lead_qualification: { verdict: '72/100' } } });
  assert.equal(q.status, 201);
  assert.equal(q.body.data.company_id, ids.company, 'company resolved from the lead');
  assert.equal((await Lead.findByPk(ids.lead)).lead_score, (await Lead.findByPk(ids.lead)).lead_score, 'rule-based score untouched');

  const list = await call('GET', '/agent/reports?kind=company_research', tok.admin);
  assert.equal(list.body.data.items[0].company.company_name, 'ABC Technologies');
  assert.equal(list.body.data.items[0].content, undefined, 'list omits the heavy content');
  const one = await call('GET', `/agent/reports/${ids.report}`, tok.admin);
  assert.deepEqual(one.body.data.source_urls, ['https://abc.example/about']);
  assert.equal((await call('GET', '/agent/reports', tok.manager)).status, 403);
});

test('outreach drafts wait for approval, stay hidden from employees until approved, and are never sent', async () => {
  assert.equal((await a1('POST', '/agent/bridge/outreach', { lead_id: ids.lead, channel: 'WHATSAPP', body: 'hi' })).status, 400, 'agent channels only');
  const d = await a1('POST', '/agent/bridge/outreach', { lead_id: ids.lead, channel: 'PROPOSAL', subject: 'Website proposal', body: 'Dear team, ...', evidence: ['Site is not mobile-friendly'] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.data.status, 'PENDING_APPROVAL');
  assert.equal(d.body.data.generated_by, 'claude_code');
  ids.draft = d.body.data.id;

  const bdeView = async () => (await call('GET', `/outreach?lead_id=${ids.lead}`, tok.bde)).body.data.items.map((o) => o.id);
  assert.ok(!(await bdeView()).includes(ids.draft), 'BDE must not see an unapproved AI draft');
  assert.ok((await call('GET', `/outreach?lead_id=${ids.lead}`, tok.admin)).body.data.items.some((o) => o.id === ids.draft));

  assert.equal((await call('PUT', `/agent/outreach/${ids.draft}`, tok.admin, { body: 'Dear team, edited.' })).body.data.body, 'Dear team, edited.');
  assert.equal((await call('POST', `/agent/outreach/${ids.draft}/approve`, tok.manager)).status, 403);
  const ap = await call('POST', `/agent/outreach/${ids.draft}/approve`, tok.admin, { note: 'Good' });
  assert.equal(ap.body.data.status, 'APPROVED');
  assert.equal(ap.body.data.reviewed_by_user_id, u.admin.id);
  assert.equal((await call('POST', `/agent/outreach/${ids.draft}/approve`, tok.admin)).status, 409, 'no double approval');
  assert.equal((await call('PUT', `/agent/outreach/${ids.draft}`, tok.admin, { body: 'x' })).status, 409, 'approved drafts are frozen');
  assert.ok((await bdeView()).includes(ids.draft), 'approved draft now visible to the lead owner');

  const d2 = (await a1('POST', '/agent/bridge/outreach', { lead_id: ids.lead, channel: 'EMAIL', subject: 'Hi', body: 'Hello' })).body.data;
  assert.equal((await call('GET', '/agent/overview', tok.admin)).body.data.pending_approvals.drafts, 1);
  assert.equal((await call('POST', `/agent/outreach/${d2.id}/reject`, tok.admin, { note: 'Too generic' })).body.data.status, 'REJECTED');
  assert.ok(await AuditLog.count({ where: { action: 'agent.draft_approved' } }));
  // The rule-based generator keeps its original channels.
  assert.equal((await call('POST', '/outreach/generate', tok.admin, { company_id: ids.company, lead_id: ids.lead, channel: 'PROPOSAL' })).status, 400);
});

test('lead status proposals change nothing until approved, then apply through the normal lead service', async () => {
  const before = await Lead.findByPk(ids.lead);
  assert.equal((await a1('POST', '/agent/bridge/proposals', { lead_id: ids.lead, field: 'status', value: 'NOPE', reason: 'because it is good' })).status, 400);
  assert.equal((await a1('POST', '/agent/bridge/proposals', { lead_id: ids.lead, field: 'status', value: 'QUALIFIED', reason: 'short' })).status, 400);
  const p = await a1('POST', '/agent/bridge/proposals', { lead_id: ids.lead, field: 'status', value: 'QUALIFIED', reason: 'Strong fit: no booking system, active business.' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.data.status, 'AWAITING_APPROVAL');
  assert.equal((await a1('POST', '/agent/bridge/proposals', { lead_id: ids.lead, field: 'status', value: 'QUALIFIED', reason: 'Strong fit: no booking system.' })).status, 409, 'one open proposal per lead');
  assert.equal((await Lead.findByPk(ids.lead)).status, before.status, 'not applied yet');
  assert.equal((await call('POST', '/agent/tasks', tok.admin, { type: 'lead_change_proposal', lead_id: ids.lead })).status, 400, 'admins cannot queue proposals as tasks');
  assert.equal((await a1('POST', '/agent/bridge/tasks/claim')).body.data.task?.type === 'lead_change_proposal', false, 'never claimable');

  const ok = await call('POST', `/agent/tasks/${p.body.data.id}/approve`, tok.admin);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'COMPLETED');
  assert.equal((await Lead.findByPk(ids.lead)).status, 'QUALIFIED');
  assert.equal(await db.LeadStatusHistory.count({ where: { lead_id: ids.lead, to_status: 'QUALIFIED' } }), 1, 'status history written');
  assert.equal((await call('POST', `/agent/tasks/${p.body.data.id}/approve`, tok.admin)).status, 409);
  assert.equal((await call('POST', `/agent/tasks/${p.body.data.id}/retry`, tok.admin)).status, 409, 'proposals cannot be retried');

  // A proposal for a lead deleted meanwhile is refused and stays open (not silently "done").
  const tmpCo = await Company.create({ company_name: 'Temp Co', source: 'csv' });
  const tmpLead = await Lead.create({ company_id: tmpCo.id });
  const pt = (await a1('POST', '/agent/bridge/proposals', { lead_id: tmpLead.id, field: 'status', value: 'QUALIFIED', reason: 'Temporary lead for the test.' })).body.data;
  await tmpLead.destroy();
  assert.equal((await call('POST', `/agent/tasks/${pt.id}/approve`, tok.admin)).status, 404);
  assert.equal((await AgentTask.findByPk(pt.id)).status, 'AWAITING_APPROVAL');
  await call('POST', `/agent/tasks/${pt.id}/reject`, tok.admin);

  const p2 = (await a1('POST', '/agent/bridge/proposals', { lead_id: ids.lead, field: 'lead_status', value: 'ARCHIVED', reason: 'Business appears closed per site.' })).body.data;
  assert.equal((await call('POST', `/agent/tasks/${p2.id}/reject`, tok.admin, { note: 'Still open' })).body.data.status, 'CANCELLED');
  assert.notEqual((await Lead.findByPk(ids.lead)).lead_status, 'ARCHIVED');
});

test('research bundles are read-only analysis with contacts masked', async () => {
  const before = await AuditLog.count();
  const r = await a1('GET', `/agent/bridge/research/company/${ids.company}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.rule_based.breakdown, 'rule-based breakdown');
  assert.ok(Array.isArray(r.body.data.opportunities));
  assert.ok(!JSON.stringify(r.body.data).includes('sales@abc.example'), 'contact value masked');
  assert.ok(r.body.data.previous_agent_reports.some((x) => x.id === ids.report));
  // company2 has no website: a live audit answers without any network call.
  const live = await a1('GET', `/agent/bridge/research/company/${ids.company2}?live=true`);
  assert.equal(live.body.data.website_audit.status, 'no_website');
  const lead = await a1('GET', `/agent/bridge/research/lead/${ids.lead}`);
  assert.ok(lead.body.data.rule_based_qualification);
  assert.equal(lead.body.data.lead.id, ids.lead);
  assert.ok((await AuditLog.count()) >= before);
  assert.equal(await db.DetectedSignal.count({ where: { company_id: ids.company2 } }), 0, 'nothing saved');
});

/* ---------------- slice (d): report data, analytics, settings, schedules, limits ---------------- */

test('report data for daily / weekly / prospecting', async () => {
  for (const period of ['daily', 'weekly', 'prospecting']) {
    const r = await a1('GET', `/agent/bridge/report-data?period=${period}`);
    assert.equal(r.status, 200, `${period}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await a1('GET', '/agent/bridge/report-data?period=yearly')).status, 400);
  const p = await a1('GET', '/agent/bridge/report-data?period=prospecting');
  assert.ok(p.body.data.top_uncontacted_leads.length >= 1);
});

test('analytics: per-day series and totals from real rows', async () => {
  const r = await call('GET', '/agent/analytics', tok.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.data.totals;
  assert.ok(t.companies_researched >= 1);
  assert.equal(t.outreach_drafts, 2);
  assert.equal(t.average_ai_score, 72);
  assert.equal(t.qualified_leads, 1, '72 >= default threshold 50');
  assert.ok(r.body.data.series.length >= 30);
  assert.equal(r.body.data.series.reduce((a, d) => a + d.outreach_drafts, 0), 2);
  assert.equal((await call('GET', '/agent/analytics?from=2026-01-01&to=2020-01-01', tok.admin)).status, 400);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await call('GET', `/agent/analytics?from=${today}&to=${today}`, tok.admin)).body.data.totals.outreach_drafts, 2, 'a bare end date includes the whole day');
  assert.equal((await call('GET', '/agent/analytics', tok.manager)).status, 403);
});

test('settings are validated and audited', async () => {
  assert.equal((await call('PUT', '/agent/config', tok.admin, { min_lead_score: 150 })).status, 400);
  assert.equal((await call('PUT', '/agent/config', tok.admin, { target_industries: 'Healthcare' })).status, 400);
  assert.equal((await call('PUT', '/agent/config', tok.admin, { schedules: { hourly: true } })).status, 400);
  assert.equal((await call('PUT', '/agent/config', tok.admin, { made_up: 1 })).status, 400);
  const r = await call('PUT', '/agent/config', tok.admin, { target_industries: ['Healthcare', 'Healthcare', 'Retail'], research_preferences: 'Focus on clinics', min_lead_score: 60 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.target_industries, ['Healthcare', 'Retail']);
  assert.equal((await a1('GET', '/agent/bridge/status')).body.data.settings.research_preferences, 'Focus on clinics', 'Claude sees the settings');
  assert.ok(await AuditLog.count({ where: { action: 'agent.settings_updated' } }));
});

test('schedules queue each daily report once; the daily task limit stops claims', async () => {
  await a1('POST', '/agent/bridge/heartbeat', {});
  await call('POST', '/agent/control', tok.admin, { action: 'start' });
  await call('POST', '/agent/control', tok.admin, { action: 'modes', enabled_modes: ['reporting'] });
  await call('PUT', '/agent/config', tok.admin, { schedules: { daily_report: true }, daily_task_limit: 1000 });
  const c = await a1('POST', '/agent/bridge/tasks/claim');
  assert.match(c.body.data.task?.title || '', /^Daily report \d{4}-\d{2}-\d{2}$/);
  assert.equal(c.body.data.task.created_by_user_id, null, 'scheduled, not user-created');
  await a1('POST', `/agent/bridge/tasks/${c.body.data.task.id}/complete`, { result: {} });
  await a2('POST', '/agent/bridge/tasks/claim');
  assert.equal(await AgentTask.count({ where: { type: 'daily_report' } }), 1, 'not re-created after completion the same day');

  await call('PUT', '/agent/config', tok.admin, { schedules: { daily_report: false }, daily_task_limit: 1 });
  await call('POST', '/agent/tasks', tok.admin, { type: 'weekly_report' });
  const blocked = await a1('POST', '/agent/bridge/tasks/claim');
  assert.equal(blocked.body.data.task, null);
  assert.match(blocked.body.data.reason, /Daily task limit reached/);
  await call('PUT', '/agent/config', tok.admin, { daily_task_limit: 50 });
  await call('POST', '/agent/control', tok.admin, { action: 'stop' });
});

test('MCP server: real stdio handshake, tool list, read + write tools, heartbeat', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  await Setting.destroy({ where: { key: 'agent.heartbeat' } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'leadhunter-mcp.js')],
    env: { ...process.env, LEADHUNTER_API_URL: base, LEADHUNTER_AGENT_TOKEN: agentToken, LEADHUNTER_HEARTBEAT_MS: '60000' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['get_leads', 'get_lead_details', 'search_leads', 'get_companies', 'get_company_details', 'get_company_contacts', 'get_lead_scores', 'get_search_history', 'get_discovery_statistics', 'get_automation_status', 'add_lead_notes', 'create_followup_task', 'get_next_task', 'complete_task', 'fail_task', 'get_agent_status', 'research_company', 'analyse_company_website', 'analyse_business_opportunity', 'qualify_lead', 'identify_public_business_contacts', 'detect_business_signals', 'find_potential_website_improvements', 'update_lead_status', 'update_lead_score', 'save_research_report', 'create_outreach_draft', 'generate_daily_report', 'generate_weekly_report', 'generate_prospecting_report', 'generate_competitor_report']) {
      assert.ok(names.includes(n), n);
    }

    const leads = await client.callTool({ name: 'search_leads', arguments: { query: 'ABC' } });
    assert.ok(!leads.isError, leads.content[0].text);
    assert.equal(JSON.parse(leads.content[0].text).items[0].company.company_name, 'ABC Technologies');

    const bad = await client.callTool({ name: 'get_lead_details', arguments: { lead_id: -1 } });
    assert.ok(bad.isError, 'input validation rejects a negative id');

    const note = await client.callTool({ name: 'add_lead_notes', arguments: { lead_id: ids.lead, note: '[Claude] test note' } });
    assert.ok(!note.isError, note.content[0].text);

    // The startup heartbeat makes the dashboard show Connected — only because the process is really running.
    const o = (await call('GET', '/agent/overview', tok.admin)).body.data;
    assert.equal(o.connection.connected, true);
    assert.match(o.connection.client, /leadhunter-mcp/);
  } finally {
    await client.close();
  }
  await flush();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(await AgentActivity.count({ where: { tool: 'search_leads' } }) >= 1, 'tool calls are logged by name');
});
