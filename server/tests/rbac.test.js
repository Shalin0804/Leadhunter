/**
 * Employee management, RBAC and audit-trail tests. Real models, routes and auth
 * middleware over HTTP against an in-memory SQLite DB — never touches server/.env's DB.
 *   npm --prefix server run test:rbac
 */
process.env.DATABASE_URL = '';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.AUTOMATION_TRIGGER_SECRET = 'cron-secret';
process.env.ALERT_EMAIL_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const { scoreCompany } = require('../services/leadScoring');
const { upsertBasicCompany } = require('../services/discoveryOrchestrator');
const { purgeExpired } = require('../services/auditService');
const app = require('../app');

const { sequelize, User, Company, CompanyContact, Lead, AuditLog, LeadAssignment } = db;

let server;
let base;
const u = {};
const tok = {};
const ids = {};

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* CSV */
  }
  return { status: res.status, body: json, text };
}
const logs = (where) => AuditLog.findAll({ where, order: [['id', 'ASC']] });

test.before(async () => {
  await sequelize.sync({ force: true });
  const pw = await User.hashPassword('Password123');
  u.admin = await User.create({ name: 'Main Admin', email: 'admin@test.local', password_hash: pw, role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'manager@test.local', password_hash: pw, role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'bde@test.local', password_hash: pw, role: 'agent', manager_id: u.manager.id });
  u.bde2 = await User.create({ name: 'Priya BDE', email: 'bde2@test.local', password_hash: pw, role: 'agent' });
  u.viewer = await User.create({ name: 'Vik Viewer', email: 'viewer@test.local', password_hash: pw, role: 'viewer' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);

  const mk = async (name, owner, phone, email) => {
    const c = await Company.create({ company_name: name, source: 'csv', website: `https://${name.toLowerCase().replace(/\W/g, '')}.example` });
    const p = await CompanyContact.create({ company_id: c.id, type: 'phone', value: phone });
    const e = await CompanyContact.create({ company_id: c.id, type: 'email', value: email });
    const l = await Lead.create({ company_id: c.id, assigned_user_id: owner?.id ?? null });
    return { c, l, p, e };
  };
  ids.mine = await mk('ABC Technologies', u.bde, '+91 98765 43210', 'sales@abc.example');
  ids.other = await mk('XYZ Solutions', u.bde2, '+91 91234 56789', 'hello@xyz.example');
  ids.unassigned = await mk('PQR Industries', null, '+91 90000 00011', 'info@pqr.example');
  ids.viewerLead = await mk('Viewer Co', u.viewer, '+91 90000 00022', 'v@viewer.example');

  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

/* 1-3 + invite / set-password / login */

test('1. Main Admin invites an employee; the invite link sets a password and login works', async () => {
  const r = await call('POST', '/users/invite', tok.admin, { name: 'New Hire', email: 'NEW@test.local', role: 'agent', manager_id: u.manager.id });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.data.user.status, 'invited');
  assert.equal(r.body.data.user.role, 'agent');
  const created = await User.findOne({ where: { email: 'new@test.local' } });
  assert.equal(created.password_hash, User.NO_PASSWORD);
  assert.notEqual(created.set_password_token_hash, null);
  assert.ok(!r.text.includes(created.set_password_token_hash), 'only the hash is stored, never returned');

  // Invited accounts can't log in before setting a password.
  assert.equal((await call('POST', '/auth/login', null, { email: 'new@test.local', password: '!invited' })).status, 401);

  const token = new URL(r.body.data.set_password_link).searchParams.get('token');
  assert.equal((await call('POST', '/auth/set-password', null, { token, password: 'BrandNewPass1' })).status, 200);
  assert.equal((await call('POST', '/auth/set-password', null, { token, password: 'AgainPass123' })).status, 400, 'token is single use');

  const login = await call('POST', '/auth/login', null, { email: 'new@test.local', password: 'BrandNewPass1' });
  assert.equal(login.status, 200);
  assert.ok(login.body.data.permissions.includes('leads.view'));
  assert.ok(!login.body.data.permissions.includes('users.manage'));
  ids.newHire = created.id;

  assert.equal((await logs({ action: 'user.invited', resource_id: String(created.id) })).length, 1);
  assert.equal((await logs({ action: 'auth.invite_accepted', actor_user_id: created.id })).length, 1);
  assert.equal((await logs({ action: 'auth.login', actor_user_id: created.id })).length, 1);
});

test('failed logins are recorded without storing the attempted email or password', async () => {
  const r = await call('POST', '/auth/login', null, { email: 'bde@test.local', password: 'wrong-password' });
  assert.equal(r.status, 401);
  const [row] = await logs({ action: 'auth.login_failed', resource_id: String(u.bde.id) });
  assert.equal(row.result, 'failure');
  assert.equal(row.resource_id, String(u.bde.id));
  assert.equal(row.actor_user_id, null);
  const raw = JSON.stringify(row.get());
  assert.ok(!raw.includes('bde@test.local') && !raw.includes('wrong-password'));
});

test('2. Main Admin changes an employee role (audited); 3. and deactivates them', async () => {
  const r = await call('PATCH', `/users/${ids.newHire}`, tok.admin, { role: 'viewer' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.user.role, 'viewer');
  const [row] = await logs({ action: 'user.role_changed', resource_id: String(ids.newHire) });
  assert.deepEqual(row.metadata, { from: 'agent', to: 'viewer' });

  const d = await call('PATCH', `/users/${ids.newHire}`, tok.admin, { is_active: false });
  assert.equal(d.status, 200);
  assert.equal(d.body.data.user.status, 'inactive');
  assert.equal((await logs({ action: 'user.deactivated' })).length, 1);
});

test('4. a deactivated employee cannot keep using an existing session', async () => {
  const hire = await User.findByPk(ids.newHire);
  const r = await call('GET', '/leads', signToken(hire));
  assert.equal(r.status, 401);
});

test('Main Admin cannot demote/deactivate themselves or remove the last admin', async () => {
  assert.equal((await call('PATCH', `/users/${u.admin.id}`, tok.admin, { role: 'agent' })).status, 403);
  assert.equal((await call('PATCH', `/users/${u.admin.id}`, tok.admin, { is_active: false })).status, 403);
  assert.equal((await User.findByPk(u.admin.id)).role, 'admin');
});

test('password reset revokes sessions issued before the new password', async () => {
  const r = await call('POST', `/users/${u.bde2.id}/reset-password`, tok.admin);
  assert.equal(r.status, 200);
  const oldToken = tok.bde2;
  await new Promise((res) => setTimeout(res, 1100)); // JWT iat has 1s resolution
  const token = new URL(r.body.data.set_password_link).searchParams.get('token');
  assert.equal((await call('POST', '/auth/set-password', null, { token, password: 'ResetPass123' })).status, 200);
  assert.equal((await call('GET', '/auth/me', oldToken)).status, 401);
  const login = await call('POST', '/auth/login', null, { email: 'bde2@test.local', password: 'ResetPass123' });
  tok.bde2 = login.body.data.token;
  assert.equal((await logs({ action: 'auth.password_reset_initiated' })).length, 1);
});

/* 5-6 */

test('5. employees cannot reach Main Admin endpoints (direct API calls)', async () => {
  for (const t of [tok.bde, tok.manager, tok.viewer]) {
    assert.equal((await call('POST', '/users/invite', t, { name: 'X Y', email: 'x@test.local' })).status, 403);
    assert.equal((await call('GET', '/audit/settings', t)).status, 403);
    assert.equal((await call('GET', '/companies', t)).status, 403);
    assert.equal((await call('GET', '/dashboard/stats', t)).status, 403);
    assert.equal((await call('GET', '/automation/settings', t)).status, 403);
    assert.equal((await call('GET', '/leads/export', t)).status, 403);
    assert.equal((await call('POST', '/leads/export', t, {})).status, 403);
  }
  assert.equal((await call('GET', '/audit/performance', tok.bde)).status, 403);
});

test('6. an employee cannot elevate their own role or re-activate themselves', async () => {
  assert.equal((await call('PATCH', `/users/${u.bde.id}`, tok.bde, { role: 'admin' })).status, 403);
  assert.equal((await call('PATCH', `/users/${u.manager.id}`, tok.manager, { role: 'admin' })).status, 403);
  assert.equal((await User.findByPk(u.bde.id)).role, 'agent');
  assert.equal((await User.findByPk(u.manager.id)).role, 'manager');
});

/* 7, 10: scope + IDOR */

test('7. a BDE sees only their assigned leads; other ids return 404 (IDOR)', async () => {
  const list = await call('GET', '/leads?limit=100', tok.bde);
  assert.deepEqual(list.body.data.items.map((l) => l.id), [ids.mine.l.id]);
  assert.equal((await call('GET', `/leads/${ids.other.l.id}`, tok.bde)).status, 404);
  assert.equal((await call('GET', `/leads/${ids.unassigned.l.id}`, tok.bde)).status, 404);
  assert.equal((await call('PATCH', `/leads/${ids.other.l.id}/status`, tok.bde, { status: 'QUALIFIED' })).status, 404);
  assert.equal((await call('GET', `/companies/${ids.other.c.id}`, tok.bde)).status, 404);
  assert.equal((await call('GET', `/companies/${ids.mine.c.id}`, tok.bde)).status, 200);
  assert.equal((await call('POST', '/notes', tok.bde, { lead_id: ids.other.l.id, body: 'sneaky' })).status, 404);
  const board = await call('GET', '/pipeline', tok.bde);
  assert.deepEqual(board.body.data.columns.flatMap((c) => c.leads.map((l) => l.id)), [ids.mine.l.id]);
});

test('a manager sees their own + team leads only', async () => {
  const list = await call('GET', '/leads?limit=100', tok.manager);
  assert.deepEqual(list.body.data.items.map((l) => l.id), [ids.mine.l.id]); // Rahul is in Maya's team
  const users = await call('GET', '/users', tok.manager);
  assert.deepEqual(users.body.data.users.map((x) => x.id).sort(), [u.manager.id, u.bde.id].sort());
});

test('a viewer can read their leads but cannot modify, assign or reveal', async () => {
  assert.equal((await call('GET', `/leads/${ids.viewerLead.l.id}`, tok.viewer)).status, 200);
  assert.equal((await call('PATCH', `/leads/${ids.viewerLead.l.id}/status`, tok.viewer, { status: 'QUALIFIED' })).status, 403);
  assert.equal((await call('POST', '/notes', tok.viewer, { lead_id: ids.viewerLead.l.id, body: 'x' })).status, 403);
  assert.equal((await call('POST', '/leads/assign', tok.viewer, { lead_ids: [ids.viewerLead.l.id], user_id: u.viewer.id })).status, 403);
  assert.equal((await call('POST', `/leads/${ids.viewerLead.l.id}/contacts/${ids.viewerLead.p.id}/reveal`, tok.viewer)).status, 403);
});

/* 8-10: lead views + contact reveal */

test('8. opening a lead records lead.viewed; contacts arrive masked for a BDE', async () => {
  const r = await call('GET', `/leads/${ids.mine.l.id}`, tok.bde);
  assert.equal(r.status, 200);
  const contacts = r.body.data.lead.company.contacts;
  assert.ok(contacts.every((c) => c.value === null && c.masked));
  assert.ok(!r.text.includes('98765 43210') && !r.text.includes('sales@abc.example'), 'no contact values in the payload');
  assert.equal(contacts.find((c) => c.type === 'phone').value_masked, '•••• ••10');

  const [row] = await logs({ action: 'lead.viewed', actor_user_id: u.bde.id });
  assert.equal(row.lead_id, ids.mine.l.id);
  assert.equal(row.company_id, ids.mine.c.id);
  assert.equal(row.accessed_fields, null, 'masked response exposed no contact fields');
  assert.equal(row.actor_name, 'Rahul BDE');
  assert.ok(row.request_id);

  // Lead list is masked too.
  const list = await call('GET', '/leads', tok.bde);
  assert.ok(!list.text.includes('sales@abc.example'));
});

test('9. phone and email reveals are logged per field without storing the value', async () => {
  const p = await call('POST', `/leads/${ids.mine.l.id}/contacts/${ids.mine.p.id}/reveal`, tok.bde);
  assert.equal(p.status, 200);
  assert.equal(p.body.data.contact.value, '+91 98765 43210');
  const e = await call('POST', `/leads/${ids.mine.l.id}/contacts/${ids.mine.e.id}/reveal`, tok.bde);
  assert.equal(e.body.data.contact.value, 'sales@abc.example');

  const [phone] = await logs({ action: 'contact.phone_revealed' });
  assert.equal(phone.actor_user_id, u.bde.id);
  assert.equal(phone.lead_id, ids.mine.l.id);
  assert.equal(phone.contact_id, ids.mine.p.id);
  assert.deepEqual(phone.accessed_fields, ['phone']);
  const [email] = await logs({ action: 'contact.email_revealed' });
  assert.deepEqual(email.accessed_fields, ['email']);
  const all = JSON.stringify((await logs({})).map((x) => x.get()));
  assert.ok(!all.includes('98765') && !all.includes('sales@abc.example'), 'audit trail never holds contact values');
});

test('buying-signal contact fields and Hermes research are not exposed to masked roles', async () => {
  await db.Signal.create({ company_id: ids.mine.c.id, lead_id: ids.mine.l.id, contact_email: 'founder@abc.example', contact_phone: '+91 95555 12345', raw: { phone: '+91 95555 12345' } });
  const r = await call('GET', `/leads/${ids.mine.l.id}`, tok.bde);
  assert.ok(!r.text.includes('founder@abc.example') && !r.text.includes('95555 12345'));
  const c = await call('GET', `/companies/${ids.mine.c.id}`, tok.bde);
  assert.ok(!c.text.includes('founder@abc.example') && !c.text.includes('95555 12345'));
  assert.equal((await call('GET', `/hermes/research/${ids.mine.c.id}`, tok.bde)).status, 403);
});

test('10. unauthorized contact-data requests are rejected and not logged as reveals', async () => {
  const before = await AuditLog.count({ where: { action: 'contact.phone_revealed' } });
  // Another BDE's lead
  assert.equal((await call('POST', `/leads/${ids.other.l.id}/contacts/${ids.other.p.id}/reveal`, tok.bde)).status, 404);
  // Own lead id with someone else's contact id
  assert.equal((await call('POST', `/leads/${ids.mine.l.id}/contacts/${ids.other.p.id}/reveal`, tok.bde)).status, 404);
  // No token
  assert.equal((await call('POST', `/leads/${ids.mine.l.id}/contacts/${ids.mine.p.id}/reveal`, null)).status, 401);
  assert.equal(await AuditLog.count({ where: { action: 'contact.phone_revealed' } }), before);
});

test('the Main Admin receives contacts unmasked and the view logs which fields were exposed', async () => {
  const r = await call('GET', `/leads/${ids.other.l.id}`, tok.admin);
  assert.equal(r.body.data.lead.company.contacts.find((c) => c.type === 'phone').value, '+91 91234 56789');
  const rows = await logs({ action: 'lead.viewed', actor_user_id: u.admin.id });
  assert.deepEqual(rows.at(-1).accessed_fields, ['email', 'phone']);
});

/* 11-13 */

test('11. assignment records history + audit; managers are limited to their team', async () => {
  const r = await call('POST', '/leads/assign', tok.admin, { lead_ids: [ids.unassigned.l.id], user_id: u.bde.id, reason: 'Territory' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await Lead.findByPk(ids.unassigned.l.id)).assigned_user_id, u.bde.id);
  const [hist] = await LeadAssignment.findAll({ where: { lead_id: ids.unassigned.l.id } });
  assert.equal(hist.previous_user_id, null);
  assert.equal(hist.new_user_id, u.bde.id);
  assert.equal(hist.assigned_by_user_id, u.admin.id);
  assert.equal(hist.reason, 'Territory');
  const [a] = await logs({ action: 'lead.assigned', lead_id: ids.unassigned.l.id });
  assert.equal(a.metadata.to_user_id, u.bde.id);

  // Reassign via PUT goes through the same workflow.
  const put = await call('PUT', `/leads/${ids.unassigned.l.id}`, tok.admin, { assigned_user_id: u.bde2.id });
  assert.equal(put.status, 200);
  assert.equal((await logs({ action: 'lead.reassigned', lead_id: ids.unassigned.l.id })).length, 1);
  const history = await call('GET', `/leads/${ids.unassigned.l.id}/assignments`, tok.admin);
  assert.equal(history.body.data.assignments.length, 2);

  // Manager can't assign outside the team, and a BDE can't assign at all.
  assert.equal((await call('POST', '/leads/assign', tok.manager, { lead_ids: [ids.mine.l.id], user_id: u.bde2.id })).status, 403);
  assert.equal((await call('PUT', `/leads/${ids.mine.l.id}`, tok.bde, { assigned_user_id: u.bde2.id })).status, 403);
  assert.equal((await Lead.findByPk(ids.mine.l.id)).assigned_user_id, u.bde.id);
  // Manager can assign within the team.
  assert.equal((await call('POST', '/leads/assign', tok.manager, { lead_ids: [ids.mine.l.id], user_id: u.manager.id })).status, 200);
  assert.equal((await call('POST', '/leads/assign', tok.manager, { lead_ids: [ids.mine.l.id], user_id: u.bde.id })).status, 200);
});

test('12. status changes, contact attempts, notes and follow-ups create audit events', async () => {
  const l = ids.mine.l.id;
  assert.equal((await call('PATCH', `/leads/${l}/status`, tok.bde, { status: 'QUALIFIED' })).status, 200);
  const [s] = await logs({ action: 'lead.status_changed', lead_id: l });
  assert.deepEqual({ from: s.metadata.from, to: s.metadata.to }, { from: 'NEW', to: 'QUALIFIED' });

  assert.equal((await call('PATCH', `/leads/${l}/contact`, tok.bde, { method: 'PHONE', note: 'called' })).status, 200);
  assert.equal((await logs({ action: 'lead.contacted', lead_id: l })).length, 1);
  assert.equal((await call('POST', '/notes', tok.bde, { lead_id: l, body: 'Spoke to founder, call +91 99999 99999' })).status, 201);
  const [n] = await logs({ action: 'lead.note_added', lead_id: l });
  assert.ok(!JSON.stringify(n.get()).includes('99999'), 'note text is not copied into the audit log');
  assert.equal((await call('POST', '/tasks', tok.bde, { title: 'Call back', lead_id: l, is_follow_up: true, due_date: new Date(Date.now() + 86400000).toISOString() })).status, 201);
  assert.equal((await logs({ action: 'lead.follow_up_added', lead_id: l })).length, 1);
  assert.equal((await call('PATCH', `/leads/${l}/contact-status`, tok.bde, { contact_status: 'WON' })).status, 200);
});

test('13. lead exports are logged (CSV)', async () => {
  const r = await call('GET', '/leads/export', tok.admin);
  assert.equal(r.status, 200);
  const [row] = await logs({ action: 'lead.exported' });
  assert.equal(row.metadata.format, 'csv');
  assert.equal(row.metadata.rows, 4);
  assert.equal(row.actor_user_id, u.admin.id);
});

test('searches are logged with filters', async () => {
  await call('GET', '/leads?search=ABC&status=WON', tok.bde);
  const [row] = await logs({ action: 'lead.searched' });
  assert.equal(row.metadata.search, 'ABC');
  assert.equal(row.metadata.filters, 'status');
  assert.equal(row.metadata.results, 1);
});

/* 14 */

test('14. audit records cannot be modified or deleted through the app', async () => {
  // No routes exist for it...
  assert.equal((await call('DELETE', '/audit/logs/1', tok.admin)).status, 404);
  assert.equal((await call('PATCH', '/audit/logs/1', tok.admin, { action: 'x' })).status, 404);
  // ...and the model refuses even direct code paths.
  const row = await AuditLog.findOne();
  await assert.rejects(() => row.update({ action: 'tampered' }), /append-only/);
  await assert.rejects(() => row.destroy(), /append-only/);
  await assert.rejects(() => AuditLog.destroy({ where: {} }), /append-only/);
  await assert.rejects(() => AuditLog.update({ action: 'x' }, { where: {} }), /append-only/);
  assert.notEqual((await AuditLog.findByPk(row.id)).action, 'tampered');
});

test('the actor is always the authenticated user, never a client-supplied id', async () => {
  await call('PATCH', `/leads/${ids.mine.l.id}/lead-status`, tok.bde, { lead_status: 'QUALIFIED', actor_user_id: u.admin.id, user_id: u.admin.id });
  const [row] = await logs({ action: 'lead.lead_status_changed' });
  assert.equal(row.actor_user_id, u.bde.id);
});

/* 15-16 */

test('15. activity log filters, presets and date ranges; employees only see their own', async () => {
  const mine = await call('GET', '/audit/logs?limit=200', tok.bde);
  assert.ok(mine.body.data.items.length > 0);
  assert.ok(mine.body.data.items.every((x) => x.actor_user_id === u.bde.id));

  const reveals = await call('GET', `/audit/logs?preset=access&actor_user_id=${u.bde.id}&lead_id=${ids.mine.l.id}`, tok.admin);
  const actions = new Set(reveals.body.data.items.map((x) => x.action));
  assert.ok(actions.has('contact.phone_revealed') && actions.has('lead.viewed'));
  assert.ok(!actions.has('lead.status_changed'), 'access preset excludes edits');

  const security = await call('GET', '/audit/logs?preset=security&limit=200', tok.admin);
  assert.ok(security.body.data.items.every((x) => /^(auth|user)\.|lead\.(exported|deleted|assigned|reassigned|unassigned|bulk_assigned)|audit\./.test(x.action)));

  const byCompany = await call('GET', '/audit/logs?search=XYZ', tok.admin);
  assert.ok(byCompany.body.data.items.length > 0 && byCompany.body.data.items.every((x) => x.company_id === ids.other.c.id || /XYZ/i.test(x.actor_name + x.action)));

  const future = await call('GET', '/audit/logs?from=2999-01-01', tok.admin);
  assert.equal(future.body.data.pagination.total, 0);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const todays = await call('GET', `/audit/logs?from=${today}&to=${today}`, tok.admin);
  assert.equal(todays.body.data.pagination.total, await AuditLog.count());

  // A BDE asking for another employee's logs gets nothing, not their data.
  const peek = await call('GET', `/audit/logs?actor_user_id=${u.admin.id}`, tok.bde);
  assert.equal(peek.body.data.pagination.total, 0);
  assert.equal((await call('GET', '/audit/logs/export', tok.bde)).status, 403);

  const meta = await call('GET', '/audit/meta', tok.admin);
  assert.ok(meta.body.data.tracking_started_at);
});

test('16. pagination is exact and non-overlapping', async () => {
  const total = await AuditLog.count();
  const p1 = await call('GET', '/audit/logs?limit=5&page=1', tok.admin);
  const p2 = await call('GET', '/audit/logs?limit=5&page=2', tok.admin);
  assert.equal(p1.body.data.pagination.total, total);
  assert.equal(p1.body.data.items.length, 5);
  const a = p1.body.data.items.map((x) => x.id);
  const b = p2.body.data.items.map((x) => x.id);
  assert.equal(a.filter((x) => b.includes(x)).length, 0);
  assert.ok(Math.min(...a) > Math.max(...b), 'newest first');
});

test('audit CSV export is admin-only and itself audited', async () => {
  const r = await call('GET', '/audit/logs/export?preset=access', tok.admin);
  assert.equal(r.status, 200);
  assert.match(r.text, /contact\.phone_revealed/);
  assert.equal((await logs({ action: 'audit.exported' })).length, 1);
});

/* 17 */

test('17. team performance metrics match the underlying audit records', async () => {
  const r = await call('GET', '/audit/performance', tok.admin);
  assert.equal(r.status, 200, r.text);
  const rahul = r.body.data.employees.find((e) => e.user.id === u.bde.id);
  const count = (action) => AuditLog.count({ where: { actor_user_id: u.bde.id, action } });
  assert.equal(rahul.lead_views, await count('lead.viewed'));
  assert.equal(rahul.unique_leads_viewed, 1);
  assert.equal(rahul.contact_reveals, (await count('contact.phone_revealed')) + (await count('contact.email_revealed')));
  assert.equal(rahul.contacted, 1);
  assert.equal(rahul.follow_ups, 1);
  assert.equal(rahul.notes, 1);
  assert.equal(rahul.won, 1);
  assert.equal(rahul.leads_assigned, await Lead.count({ where: { assigned_user_id: u.bde.id } }));
  // Opening a lead or revealing a phone is never counted as a contact attempt.
  assert.ok(rahul.lead_views + rahul.contact_reveals > rahul.contacted);
  const seriesTotal = r.body.data.series.reduce((s, b) => s + b.lead_views, 0);
  assert.equal(seriesTotal, r.body.data.totals.lead_views);

  const mgr = await call('GET', '/audit/performance', tok.manager);
  // The deactivated new hire is still on Maya's team, so their history stays reportable.
  assert.deepEqual(mgr.body.data.employees.map((e) => e.user.id).sort(), [u.manager.id, u.bde.id, ids.newHire].sort());
  assert.equal((await call('GET', `/audit/performance?user_id=${u.bde2.id}`, tok.manager)).status, 404);
});

/* 18-20 regressions */

test('18-19. discovery dedup and scoring still behave as before', async () => {
  const raw = { company_name: 'Dedup Labs', website: 'https://dedup.example', city: 'Pune' };
  const a = await upsertBasicCompany(raw, { industry: 'IT', providerKey: 'test' });
  const b = await upsertBasicCompany({ ...raw, website: 'http://www.dedup.example/' }, { industry: 'IT', providerKey: 'test' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.company.id, b.company.id);
  const s1 = scoreCompany(await Company.findByPk(a.company.id, { include: ['contacts', 'websites', 'socials'] }));
  const s2 = scoreCompany(await Company.findByPk(a.company.id, { include: ['contacts', 'websites', 'socials'] }));
  assert.equal(typeof s1.score, 'number');
  assert.deepEqual(s1, s2);
});

test('20. external-cron automation endpoints remain reachable without a user session', async () => {
  const wrong = await call('POST', '/automation/run-scheduled', null);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.message, 'Invalid automation trigger secret'); // reached the controller, not the JWT guard
  const hb = await call('GET', '/automation/heartbeat', null);
  assert.notEqual(hb.body?.message, 'Authentication token missing');
});

test('retention purge is a no-op unless configured', async () => {
  const before = await AuditLog.count();
  assert.equal(await purgeExpired(0), 0);
  assert.equal(await AuditLog.count(), before);
  assert.equal(await purgeExpired(30), 0); // nothing older than 30 days
});
