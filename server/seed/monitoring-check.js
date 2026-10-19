/**
 * Self-check for health endpoints, alert dedup/retry/recovery and run tracking.
 * No database, no real SMTP — models and the mail transport are stubbed in memory.
 *   node seed/monitoring-check.js
 */
const assert = require('assert');
const nodemailer = require('nodemailer');
const config = require('../config/config');
const models = require('../models');

// ---- in-memory stubs -----------------------------------------------------------
const settings = new Map();
models.Setting.findOne = async ({ where }) => (settings.has(where.key) ? { value: settings.get(where.key), updatedAt: new Date() } : null);
models.Setting.upsert = async ({ key, value }) => settings.set(key, value);

let runs = [];
models.SearchRun.findOne = async ({ where = {} }) => {
  const list = runs.filter((r) => !where.status || r.status === where.status);
  return list.sort((a, b) => b.finished_at - a.finished_at)[0] || null;
};

const sent = [];
let failNext = 0;
nodemailer.createTransport = () => ({
  sendMail: async (msg) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error('SMTP down');
    }
    sent.push(msg);
  },
});

Object.assign(config.alerts, { enabled: true, to: 'ops@example.com', from: 'bot@example.com', cooldownMinutes: 60 });
Object.assign(config.alerts.smtp, { host: 'smtp.example.com', user: 'u', pass: 'super-secret-pass' });

const alerts = require('../services/alertService');
const monitoring = require('../services/monitoringService');
const { withRunLock } = require('../jobs/automationScheduler');
const app = require('../app');

alerts.retryDelays = [1, 1];
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  // config validation
  config.alerts.enabled = false;
  assert.match(alerts.configProblem(), /ALERT_EMAIL_ENABLED/);
  config.alerts.enabled = true;
  config.alerts.smtp.pass = '';
  assert.match(alerts.configProblem(), /SMTP_PASS/);
  assert(!alerts.configProblem().includes('super-secret-pass'));
  config.alerts.smtp.pass = 'super-secret-pass';
  assert.strictEqual(alerts.configProblem(), null);

  // templates: escaped, no secrets, required fields
  const m = alerts.render('automation_failure', { Error: '<script>x</script>' });
  assert(m.html.includes('&lt;script&gt;') && !m.html.includes('<script>'));
  assert(m.text.includes('LeadHunter CRM Backend') && m.text.includes('automation_failure') && m.text.includes('What to do'));
  assert(!m.text.includes('super-secret-pass'));

  // raise: one email per cooldown, state persisted
  assert.deepStrictEqual(await alerts.raise('automation_failure', {}), { sent: true });
  assert.strictEqual((await alerts.raise('automation_failure', {})).reason, 'cooldown');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(settings.get('alert_state:automation_failure').active, true);

  // resolve: recovery once, then nothing
  assert.deepStrictEqual(await alerts.resolve(['automation_failure', 'automation_overdue'], 'automation_recovered', {}), { sent: true });
  assert.strictEqual((await alerts.resolve(['automation_failure'], 'automation_recovered', {})).reason, 'nothing active');
  assert.strictEqual(sent.length, 2);

  // retries: two failures then success; total failure doesn't start the cooldown
  failNext = 2;
  assert.strictEqual(await alerts.send('test', {}), true);
  failNext = 3;
  assert.deepStrictEqual(await alerts.raise('backend_startup', {}), { sent: false });
  assert.strictEqual(settings.get('alert_state:backend_startup').last_sent_at, null);
  assert.deepStrictEqual(await alerts.raise('backend_startup', {}), { sent: true }); // next event retries

  // run outcomes
  settings.clear();
  sent.length = 0;
  const silent = { id: 7, status: 'completed', businesses_discovered: 0, providers_used: [], errors: [{ step: 'discovery:osm', message: 'timeout' }] };
  assert(monitoring.isFailedRun(silent), 'all providers failed counts as failure');
  assert(!monitoring.isFailedRun({ status: 'completed', businesses_discovered: 0, providers_used: [], errors: [] }), 'daily-limit skip is not a failure');
  await monitoring.recordRunOutcome('scheduled', { runs: [silent] });
  assert.match(sent[0].subject, /failed/);
  await monitoring.recordRunOutcome('scheduled', { runs: [{ id: 8, status: 'completed', businesses_discovered: 5, providers_used: ['osm'], errors: [] }] });
  assert.match(sent[1].subject, /recovered/);
  await monitoring.recordRunOutcome('scheduled', { skipped: true });
  assert.strictEqual(sent.length, 2);

  // overdue detection
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
  settings.set('automation_config', { enabled: false });
  assert.strictEqual((await monitoring.checkAutomationHealth()).status, 'disabled');
  settings.set('automation_config', { enabled: true });
  runs = [{ status: 'completed', started_at: hoursAgo(2), finished_at: hoursAgo(2), businesses_discovered: 3 }];
  assert.strictEqual((await monitoring.checkAutomationHealth()).status, 'ok');
  assert.strictEqual((await monitoring.checkAutomationHealth({ isRunning: true })).status, 'running');
  runs = [{ status: 'completed', started_at: hoursAgo(48), finished_at: hoursAgo(48) }];
  const before = sent.length;
  assert.strictEqual((await monitoring.checkAutomationHealth()).status, 'overdue');
  await monitoring.checkAutomationHealth();
  assert.strictEqual(sent.length, before + 1, 'overdue alert deduped by cooldown');

  // run lock: no overlapping jobs, outcome recorded, email never blocks the run
  let release;
  const first = withRunLock('test', () => new Promise((r) => (release = r)));
  assert.strictEqual((await withRunLock('test', async () => ({ runs: [] }))).skipped, true);
  release({ runs: [{ status: 'completed', businesses_discovered: 1, providers_used: ['osm'], errors: [] }] });
  await first;
  await tick();

  // health endpoints
  models.sequelize.authenticate = async () => {
    throw new Error('ECONNREFUSED db.internal:3306');
  };
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await fetch(`${base}/health`);
  const hb = await h.json();
  assert.strictEqual(h.status, 200);
  assert.strictEqual(hb.status, 'ok');
  assert.strictEqual(hb.service, 'LeadHunter Backend');
  assert(!Number.isNaN(Date.parse(hb.timestamp)));
  const r = await fetch(`${base}/api/ready`);
  const rText = await r.text();
  assert.strictEqual(r.status, 503);
  assert(!rText.includes('db.internal'), 'readiness hides internals');
  config.automation.triggerSecret = 's3cret';
  assert.strictEqual((await fetch(`${base}/api/automation/heartbeat`)).status, 401);
  assert.strictEqual((await fetch(`${base}/api/automation/heartbeat`, { headers: { 'x-automation-secret': 's3cret' } })).status, 503);
  assert.strictEqual((await fetch(`${base}/api/automation/alerts/test`, { method: 'POST' })).status, 401);
  server.close();

  console.log('monitoring-check: all assertions passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
