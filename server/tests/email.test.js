/**
 * Titan email: admin-only access, credentials never exposed, SMTP verify/auth failure,
 * test email, AI/rule drafts, composer drafts, single send, duplicate-send protection,
 * retries, failures, bulk campaigns (individual addressing, confirmation), Claude Code
 * drafts, IMAP reply sync (fake fetcher) and follow-up guards. In-memory SQLite with a
 * fake SMTP transport — never touches server/.env's DB or a real mailbox.
 *   npm --prefix server run test:email
 */
// TEST_DB_URL (a throwaway MySQL/TiDB or Postgres) runs the same suite on that dialect.
process.env.DATABASE_URL = process.env.TEST_DB_URL || '';
process.env.DB_DIALECT = process.env.TEST_DB_URL ? (process.env.TEST_DB_URL.startsWith('postgres') ? 'postgres' : 'mysql') : 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_ENABLED = 'false';
process.env.NVIDIA_API_KEY = '';
process.env.TITAN_SMTP_HOST = 'smtp.titan.email';
process.env.TITAN_SMTP_USER = 'info@codefloorit.in';
process.env.TITAN_SMTP_PASSWORD = 'super-secret-smtp-pass';
process.env.EMAIL_FROM_ADDRESS = 'info@codefloorit.in';
process.env.EMAIL_SEND_DELAY_MS = '0';
process.env.TITAN_IMAP_ENABLED = 'true';
process.env.EMAIL_SEND_RATE_PER_MIN = '1000'; // the suite sends more than a person would

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const config = require('../config/config');
const app = require('../app');
const email = require('../services/emailService');
const replies = require('../services/emailReplyService');

const { sequelize, User, Company, CompanyContact, Lead, Outreach, EmailMessage, EmailCampaign, Activity, AuditLog, AgentTask } = db;
const SECRET = process.env.TITAN_SMTP_PASSWORD;

// Fake nodemailer transport: records mail, fails on demand.
const sent = [];
const failQueue = [];
let verifyError = null;
email._setTransport({
  verify: async () => {
    if (verifyError) throw verifyError;
    return true;
  },
  sendMail: async (mail) => {
    const err = failQueue.shift();
    if (err) throw err;
    sent.push(mail);
    return { messageId: mail.messageId, response: '250 2.0.0 Ok: queued' };
  },
});
email.retryDelays = [0, 0];
const smtpErr = (responseCode, message, code) => Object.assign(new Error(message), { responseCode, code, response: `${responseCode} ${message}` });

let server;
let base;
const u = {};
const tok = {};
const ids = {};

async function call(method, p, token, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), text: '' };
}
const admin = (m, p, b) => call(m, p, tok.admin, b);
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

async function makeLead(name, emailAddr, extra = {}) {
  const c = await Company.create({ company_name: name, source: 'csv', industry: 'Dental clinic', city: 'Pune' });
  if (emailAddr) await CompanyContact.create({ company_id: c.id, type: 'email', value: emailAddr, contact_name: extra.contactName || null, is_primary: true });
  return Lead.create({ company_id: c.id, ...extra.lead });
}

test.before(async () => {
  await sequelize.sync({ force: true });
  const pw = await User.hashPassword('Password123');
  u.admin = await User.create({ name: 'Main Admin', email: 'admin@test.local', password_hash: pw, role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'manager@test.local', password_hash: pw, role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'bde@test.local', password_hash: pw, role: 'agent' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);
  ids.lead = (await makeLead('Sunrise Dental', 'Owner@Sunrise.example', { contactName: 'Priya' })).id;
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

test('email endpoints are Main Admin only (and closed to the Claude agent token)', async () => {
  for (const who of ['manager', 'bde']) {
    assert.equal((await call('GET', '/email/settings', tok[who])).status, 403, who);
    assert.equal((await call('POST', '/email/settings/test-email', tok[who], {})).status, 403, who);
    assert.equal((await call('POST', '/email/messages/1/send', tok[who])).status, 403, who);
    assert.equal((await call('POST', '/email/campaigns', tok[who], { lead_ids: [ids.lead] })).status, 403, who);
  }
  assert.equal((await call('GET', '/email/settings')).status, 401);
  const agentToken = (await admin('POST', '/agent/token')).body.data.token;
  assert.equal((await call('GET', '/email/settings', agentToken)).status, 403);
  assert.equal((await call('POST', '/email/messages/1/send', agentToken)).status, 403);
  assert.equal(sent.length, 0);
});

test('settings report configuration without ever returning the SMTP password', async () => {
  const r = await admin('GET', '/email/settings');
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.provider, 'Titan Mail');
  assert.equal(d.configured, true);
  assert.equal(d.password_set, true);
  assert.equal(d.from_address, 'info@codefloorit.in');
  assert.equal(d.port, 465);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
});

test('SMTP connection test: success is recorded, auth failure is reported safely', async () => {
  let r = await admin('POST', '/email/settings/test-connection');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.status.last_verified_at);

  verifyError = smtpErr(535, 'Authentication failed', 'EAUTH');
  r = await admin('POST', '/email/settings/test-connection');
  verifyError = null;
  assert.equal(r.status, 502);
  assert.match(r.body.message, /535/);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  const s = await admin('GET', '/email/settings');
  assert.match(s.body.data.status.last_verify_error, /Authentication failed/);
});

test('a test email can be sent to a controlled recipient', async () => {
  const r = await admin('POST', '/email/settings/test-email', { to: 'me@codefloorit.in' });
  assert.equal(r.status, 200);
  const mail = sent.at(-1);
  assert.equal(mail.to, 'me@codefloorit.in');
  assert.deepEqual(mail.from, { name: 'Codefloor IT', address: 'info@codefloorit.in' });
  assert.equal((await admin('POST', '/email/settings/test-email', { to: 'not-an-email' })).status, 400);
});

test('generated drafts are personalised from stored facts and signed by the sender', async () => {
  const r = await admin('POST', '/email/generate', { lead_id: ids.lead });
  assert.equal(r.status, 200);
  const d = r.body.data.draft;
  assert.equal(d.to_email, 'owner@sunrise.example');
  assert.match(d.subject, /Sunrise Dental/);
  assert.match(d.body, /Hi Priya/);
  assert.match(d.body, /Codefloor IT/);
  assert.doesNotMatch(d.body, /\[Your name\]/);
  // use_ai without NVIDIA falls back to the rule-based template and says so.
  const ai = await admin('POST', '/email/generate', { lead_id: ids.lead, use_ai: true });
  assert.equal(ai.body.data.draft.generated_by, 'rule_based');
  assert.match(ai.body.data.draft.ai_error, /NVIDIA_NOT_CONFIGURED/);
});

test('drafts: recipient must be a stored contact; save and edit work', async () => {
  const bad = await admin('POST', '/email/messages', { lead_id: ids.lead, to_email: 'stranger@evil.example', subject: 'Hi', body: 'x' });
  assert.equal(bad.status, 400);
  const inj = await admin('POST', '/email/messages', { lead_id: ids.lead, to_email: 'owner@sunrise.example\r\nBcc: x@y.z', subject: 'Hi', body: 'x' });
  assert.equal(inj.status, 400);
  const r = await admin('POST', '/email/messages', { lead_id: ids.lead, to_email: 'owner@sunrise.example', subject: 'A thought on\r\nyour site', body: 'Hello Priya', generated_by: 'rule_based' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.message.subject, 'A thought on your site');
  ids.draft = r.body.data.message.id;
  const e = await admin('PUT', `/email/messages/${ids.draft}`, { body: 'Hello Priya, edited.' });
  assert.equal(e.status, 200);
  assert.equal(e.body.data.message.body, 'Hello Priya, edited.');
});

test('sending one email: individually addressed, footer, threading id, one activity, lead marked contacted', async () => {
  const before = sent.length;
  const r = await admin('POST', `/email/messages/${ids.draft}/send`);
  assert.equal(r.status, 200);
  const m = r.body.data.message;
  assert.equal(m.status, 'SENT');
  assert.equal(m.attempts, 1);
  assert.match(m.message_id, /^<.+@codefloorit\.in>$/);
  assert.equal(sent.length, before + 1);
  const mail = sent.at(-1);
  assert.equal(mail.to, 'owner@sunrise.example');
  assert.equal(mail.cc, undefined);
  assert.equal(mail.bcc, undefined);
  assert.match(mail.text, /reply with "unsubscribe"/);
  assert.match(mail.headers['List-Unsubscribe'], /mailto:info@codefloorit\.in/);
  assert.equal(await Activity.count({ where: { lead_id: ids.lead, type: 'email' } }), 1);
  assert.equal((await Lead.findByPk(ids.lead)).contact_status, 'CONTACTED');
  const log = await AuditLog.findOne({ where: { action: 'email.sent', resource_id: String(ids.draft) } });
  assert.ok(log);
  assert.ok(!JSON.stringify(log.metadata).includes('sunrise.example'), 'no addresses in audit metadata');
});

test('duplicate sending is prevented', async () => {
  const before = sent.length;
  assert.equal((await admin('POST', `/email/messages/${ids.draft}/send`)).status, 409, 'same row twice');
  const again = await admin('POST', '/email/messages', { lead_id: ids.lead, to_email: 'owner@sunrise.example', subject: 'Second', body: 'Again' });
  const r = await admin('POST', `/email/messages/${again.body.data.message.id}/send`);
  assert.equal(r.status, 409, 'same address inside the window');
  assert.match(r.body.message, /already emailed/);
  // Two concurrent sends of one draft: exactly one goes out.
  const l = await makeLead('Race Co', 'race@race.example');
  const d = await admin('POST', '/email/messages', { lead_id: l.id, to_email: 'race@race.example', subject: 'Hi', body: 'Race' });
  const results = await Promise.all([1, 2, 3].map(() => admin('POST', `/email/messages/${d.body.data.message.id}/send`)));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  assert.equal(sent.length, before + 1);
  // Two different drafts to one address at the same moment: still exactly one email.
  const l2 = await makeLead('Twin Co', 'twin@twin.example');
  const drafts = await Promise.all([1, 2].map((n) => admin('POST', '/email/messages', { lead_id: l2.id, to_email: 'twin@twin.example', subject: `Hi ${n}`, body: 'Twin' })));
  const both = await Promise.all(drafts.map((x) => admin('POST', `/email/messages/${x.body.data.message.id}/send`)));
  assert.equal(both.filter((x) => x.status === 200).length, 1);
  assert.equal(sent.filter((m) => m.to === 'twin@twin.example').length, 1);
});

test('temporary SMTP errors are retried on the same row; permanent ones fail cleanly', async () => {
  const l = await makeLead('Retry Co', 'retry@retry.example');
  const d = await admin('POST', '/email/messages', { lead_id: l.id, to_email: 'retry@retry.example', subject: 'Hi', body: 'Retry' });
  failQueue.push(smtpErr(421, 'Service not available, try later'));
  const r = await admin('POST', `/email/messages/${d.body.data.message.id}/send`);
  assert.equal(r.body.data.message.status, 'SENT');
  assert.equal(r.body.data.message.attempts, 2);
  assert.equal(await EmailMessage.count({ where: { to_email: 'retry@retry.example' } }), 1, 'no duplicate rows');

  const l2 = await makeLead('Bounce Co', 'nobody@bounce.example');
  const d2 = await admin('POST', '/email/messages', { lead_id: l2.id, to_email: 'nobody@bounce.example', subject: 'Hi', body: 'Bounce' });
  failQueue.push(smtpErr(550, 'Mailbox unavailable'));
  const f = await admin('POST', `/email/messages/${d2.body.data.message.id}/send`);
  assert.equal(f.status, 200);
  assert.equal(f.body.data.message.status, 'FAILED');
  assert.equal(f.body.data.message.attempts, 1);
  assert.match(f.body.data.message.error, /550/);
  assert.equal(await Activity.count({ where: { lead_id: l2.id, type: 'email' } }), 0);
  assert.equal((await Lead.findByPk(l2.id)).contact_status, 'NOT_CONTACTED');
  assert.ok(await AuditLog.findOne({ where: { action: 'email.failed' } }));
});

test('hourly limit refuses sends without consuming them', async () => {
  const l = await makeLead('Limit Co', 'limit@limit.example');
  const d = await admin('POST', '/email/messages', { lead_id: l.id, to_email: 'limit@limit.example', subject: 'Hi', body: 'Limit' });
  const old = config.email.hourlyLimit;
  config.email.hourlyLimit = 1;
  const r = await admin('POST', `/email/messages/${d.body.data.message.id}/send`);
  config.email.hourlyLimit = old;
  assert.equal(r.status, 429);
  assert.equal((await EmailMessage.findByPk(d.body.data.message.id)).status, 'DRAFT');
});

test('bulk campaign: per-lead drafts, skips, edit/remove, explicit confirmation, individual sends', async () => {
  const a = await makeLead('Alpha Bakery', 'hello@alpha.example', { contactName: 'Anil' });
  const b = await makeLead('Beta Salon', 'team@beta.example');
  const c = await makeLead('Gamma Gym', 'gym@gamma.example');
  const noEmail = await makeLead('No Email Ltd', null);
  const dnc = await makeLead('Do Not Ltd', 'x@dnc.example', { lead: { contact_status: 'DO_NOT_CONTACT' } });
  // A Claude Code draft for Beta is preferred over the generator.
  await Outreach.create({ lead_id: b.id, company_id: b.company_id, channel: 'EMAIL', subject: 'Claude subject', body: 'Claude wrote this.', generated_by: 'claude_code', status: 'PENDING_APPROVAL' });

  const p = await admin('POST', '/email/campaigns', { lead_ids: [a.id, b.id, c.id, noEmail.id, dnc.id], name: 'Pune week 1' });
  assert.equal(p.status, 201);
  const camp = p.body.data.campaign;
  assert.equal(camp.counts.total, 3);
  assert.equal(p.body.data.skipped.length, 2);
  const byLead = Object.fromEntries(camp.messages.map((m) => [m.lead_id, m]));
  assert.match(byLead[a.id].body, /Hi Anil/);
  assert.equal(byLead[b.id].generated_by, 'claude_code');
  assert.equal(byLead[b.id].subject, 'Claude subject');

  assert.equal((await admin('PUT', `/email/messages/${byLead[a.id].id}`, { subject: 'Edited for Alpha' })).status, 200);
  assert.equal((await admin('DELETE', `/email/messages/${byLead[c.id].id}`)).status, 200);

  assert.equal((await admin('POST', `/email/campaigns/${camp.id}/send`, { expected_count: 2 })).status, 400, 'no confirm');
  assert.equal((await admin('POST', `/email/campaigns/${camp.id}/send`, { confirm: true, expected_count: 3 })).status, 409, 'stale count');
  const before = sent.length;
  const s = await admin('POST', `/email/campaigns/${camp.id}/send`, { confirm: true, expected_count: 2 });
  assert.equal(s.status, 202);
  await waitFor(async () => (await EmailCampaign.findByPk(camp.id)).status === 'COMPLETED');
  const mails = sent.slice(before);
  assert.deepEqual(mails.map((m) => m.to).sort(), ['hello@alpha.example', 'team@beta.example']);
  assert.ok(mails.every((m) => typeof m.to === 'string' && !m.cc && !m.bcc));
  assert.equal(mails.find((m) => m.to === 'hello@alpha.example').subject, 'Edited for Alpha');
  const g = await admin('GET', `/email/campaigns/${camp.id}`);
  assert.equal(g.body.data.campaign.counts.SENT, 2);
  assert.equal((await Outreach.findOne({ where: { lead_id: b.id } })).status, 'APPROVED', 'sending a Claude draft approves it');
  assert.equal((await admin('POST', `/email/campaigns/${camp.id}/send`, { confirm: true, expected_count: 0 })).status, 409, 'completed campaign cannot resend');
});

test('Ask Claude queues a generate_outreach task with the email context', async () => {
  const r = await admin('POST', `/email/leads/${ids.lead}/claude-draft`, { kind: 'follow_up' });
  assert.equal(r.status, 201);
  const task = await AgentTask.findByPk(r.body.data.task.id);
  assert.equal(task.type, 'generate_outreach');
  assert.equal(task.input.channel, 'FOLLOW_UP');
  assert.equal(task.input.previous_email.subject, 'A thought on your site');
});

test('follow-up drafts quote the previous email and thread as a reply', async () => {
  const r = await admin('POST', '/email/generate', { lead_id: ids.lead, kind: 'follow_up' });
  const d = r.body.data.draft;
  assert.equal(d.subject, 'Re: A thought on your site');
  assert.match(d.body, /> Hello Priya, edited\./);
});

test('IMAP reply sync imports matched replies once, ignores the rest, and blocks follow-ups', async () => {
  const out = await EmailMessage.findOne({ where: { lead_id: ids.lead, status: 'SENT' } });
  const inbox = [
    { messageId: '<r1@sunrise.example>', inReplyTo: out.message_id, references: [out.message_id], from: 'owner@sunrise.example', subject: 'Re: A thought on your site', date: new Date(), text: 'Sounds interesting, call me Tuesday.\n\nOn Mon, Codefloor IT wrote:\n> unsubscribe' },
    { messageId: '<spam@else.example>', inReplyTo: null, references: [], from: 'random@else.example', subject: 'Buy now', date: new Date(), text: 'spam' },
  ];
  const r1 = await replies.syncReplies({ fetchMessages: async () => inbox });
  assert.deepEqual(r1, { fetched: 2, imported: 1, ignored: 1 });
  const r2 = await replies.syncReplies({ fetchMessages: async () => inbox });
  assert.equal(r2.imported, 0, 'no duplicate imports');
  const reply = await EmailMessage.findOne({ where: { message_id: '<r1@sunrise.example>' } });
  assert.equal(reply.lead_id, ids.lead);
  assert.equal(reply.opt_out, false, 'quoted text is not an opt-out');
  assert.equal((await Lead.findByPk(ids.lead)).contact_status, 'REPLIED');

  const ov = await admin('GET', `/email/leads/${ids.lead}`);
  assert.ok(ov.body.data.messages.some((m) => m.direction === 'inbound'));

  // Follow-up after a reply is refused even outside the duplicate window.
  const old = config.email.duplicateWindowHours;
  config.email.duplicateWindowHours = 0;
  const f = await admin('POST', '/email/messages', { lead_id: ids.lead, to_email: 'owner@sunrise.example', subject: 'Re: A thought on your site', body: 'Following up', kind: 'follow_up' });
  const s = await admin('POST', `/email/messages/${f.body.data.message.id}/send`);
  config.email.duplicateWindowHours = old;
  assert.equal(s.status, 409);
  assert.match(s.body.message, /replied/);
});

test('an "unsubscribe" reply marks the lead Do Not Contact and blocks further email', async () => {
  const l = await makeLead('Opt Out Co', 'boss@optout.example');
  const d = await admin('POST', '/email/messages', { lead_id: l.id, to_email: 'boss@optout.example', subject: 'Hi', body: 'Hello' });
  const m = (await admin('POST', `/email/messages/${d.body.data.message.id}/send`)).body.data.message;
  await replies.syncReplies({ fetchMessages: async () => [{ messageId: '<u1@optout.example>', inReplyTo: m.message_id, references: [], from: 'boss@optout.example', subject: 'Re: Hi', date: new Date(), text: 'Please unsubscribe me.' }] });
  assert.equal((await Lead.findByPk(l.id)).contact_status, 'DO_NOT_CONTACT');
  const p = await admin('POST', '/email/campaigns', { lead_ids: [l.id] });
  assert.equal(p.body.data.campaign.counts.total, 0);
  assert.match(p.body.data.skipped[0].reason, /do not contact/);
});

test('IMAP sync is refused clearly when not enabled', async () => {
  config.email.imap.enabled = false;
  const r = await admin('POST', '/email/replies/sync');
  config.email.imap.enabled = true;
  assert.equal(r.status, 503);
  assert.match(r.body.message, /TITAN_IMAP_ENABLED/);
});

test('a restart marks in-flight emails FAILED and pauses sending campaigns', async () => {
  const camp = await EmailCampaign.create({ name: 'Interrupted', status: 'SENDING' });
  const row = await EmailMessage.create({ campaign_id: camp.id, to_email: 'z@z.example', from_email: 'info@codefloorit.in', subject: 's', body: 'b', status: 'SENDING' });
  assert.ok((await email.recoverInterrupted()) >= 1);
  assert.equal((await row.reload()).status, 'FAILED');
  assert.equal((await camp.reload()).status, 'PAUSED');
});
