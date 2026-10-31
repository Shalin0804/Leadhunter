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
    for (const n of ['get_leads', 'get_lead_details', 'search_leads', 'get_companies', 'get_company_details', 'get_company_contacts', 'get_lead_scores', 'get_search_history', 'get_discovery_statistics', 'get_automation_status', 'add_lead_notes', 'create_followup_task', 'get_next_task', 'complete_task', 'fail_task', 'get_agent_status']) {
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
