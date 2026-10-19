const nodemailer = require('nodemailer');
const config = require('../config/config');
const { Setting } = require('../models');

/**
 * Email alerts over SMTP. Never throws to callers and never blocks the work
 * that raised the alert — call sites fire-and-forget.
 *
 * Dedup state lives in the existing `settings` table, one row per alert type
 * (`alert_state:<type>` -> { active, last_sent_at }), so cooldowns survive restarts.
 * `raise()` marks a problem active and emails at most once per cooldown;
 * `resolve()` emails a recovery only if one of the given problems was active.
 *
 * "Backend unavailable" / "backend back up" are NOT sent from here — a down
 * process can't email. Those come from the external uptime monitor (DEPLOY.md).
 */

const SERVICE = 'LeadHunter CRM Backend';
const RETRY_DELAYS_MS = [2000, 10000]; // 3 attempts total, then give up
const STATE_PREFIX = 'alert_state:';

const TEMPLATES = {
  backend_startup: {
    subject: 'Backend started',
    explanation: 'The backend finished starting and is accepting requests. On Render Free this is normal after a deploy or after waking from sleep.',
    hint: 'No action needed unless you did not expect a restart — then check the Render "Events" and "Logs" tabs.',
  },
  backend_unexpected_restart: {
    subject: 'Backend recovered after an unexpected stop',
    explanation:
      'The backend is running again, but the previous instance never recorded a clean shutdown. It most likely crashed, ran out of memory, or was killed without SIGTERM.',
    hint: 'Open Render -> Logs and look just before the "Started" time for an error, "out of memory", or "exited with status".',
  },
  automation_failure: {
    subject: 'Automatic lead generation run failed',
    explanation: 'A discovery run finished with errors, or every discovery provider failed so no businesses were found.',
    hint: 'Open LeadHunter -> Automation -> Search History for the failed run. Common causes: an expired/missing provider API key, provider quota exhausted, or the database being unreachable.',
  },
  automation_overdue: {
    subject: 'Automatic lead generation is overdue',
    explanation: 'Automation is enabled, but no discovery run has completed successfully within the configured threshold.',
    hint: 'Check that your external cron job (cron-job.org) is still calling /api/automation/run-scheduled and getting HTTP 202, then check Search History for failed runs.',
  },
  automation_recovered: {
    subject: 'Automatic lead generation recovered',
    explanation: 'A discovery run completed successfully after a previous failure/overdue alert.',
    hint: 'No action needed.',
  },
  test: {
    subject: 'Test alert',
    explanation: 'This is a test email triggered from LeadHunter. If you received it, alert email delivery works.',
    hint: 'No action needed.',
  },
};

/** Why alerts are off, or null when they're fully configured. */
function configProblem() {
  const a = config.alerts;
  if (!a.enabled) return 'ALERT_EMAIL_ENABLED is not "true"';
  const missing = ['to', 'from'].filter((k) => !a[k]).map((k) => `ALERT_EMAIL_${k.toUpperCase()}`);
  missing.push(...['host', 'user', 'pass'].filter((k) => !a.smtp[k]).map((k) => `SMTP_${k.toUpperCase()}`));
  return missing.length ? `missing ${missing.join(', ')}` : null;
}

/** Startup log line. Names env vars only — never their values. */
function logConfigStatus() {
  const problem = configProblem();
  if (!problem) console.log(`[alerts] email alerts enabled (SMTP ${config.alerts.smtp.host}:${config.alerts.smtp.port})`);
  else if (config.alerts.enabled) console.warn(`[alerts] ALERT_EMAIL_ENABLED=true but ${problem} — alerts disabled`);
  else console.log('[alerts] email alerts disabled (set ALERT_EMAIL_ENABLED=true + SMTP_* to enable)');
}

let transporter;
const getTransporter = () => {
  if (!transporter) {
    const { host, port, secure, user, pass } = config.alerts.smtp;
    transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout: 15000 });
  }
  return transporter;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render(type, facts = {}, at = new Date()) {
  const t = TEMPLATES[type];
  const rows = [['Service', SERVICE], ['Alert type', type], ['Event time', at.toISOString()], ...Object.entries(facts)].filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  const subject = `[LeadHunter] ${t.subject}`;
  const text = [t.subject, '', t.explanation, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `What to do: ${t.hint}`].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:600px">
<h2 style="margin:0 0 8px">${escapeHtml(t.subject)}</h2>
<p>${escapeHtml(t.explanation)}</p>
<table style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
<p><strong>What to do:</strong> ${escapeHtml(t.hint)}</p></div>`;
  return { subject, text, html };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send one email with bounded retries. Resolves true/false, never throws. */
async function send(type, facts) {
  if (configProblem()) return false;
  const msg = render(type, facts);
  for (let attempt = 0; attempt <= module.exports.retryDelays.length; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await getTransporter().sendMail({ from: config.alerts.from, to: config.alerts.to, ...msg });
      console.log(`[alerts] sent "${type}"`);
      return true;
    } catch (err) {
      // err.message from nodemailer does not include the SMTP password.
      console.error(`[alerts] "${type}" attempt ${attempt + 1} failed: ${err.message}`);
      // eslint-disable-next-line no-await-in-loop
      if (attempt < module.exports.retryDelays.length) await sleep(module.exports.retryDelays[attempt]);
    }
  }
  return false;
}

async function getState(type) {
  const row = await Setting.findOne({ where: { key: STATE_PREFIX + type } });
  return row?.value || { active: false, last_sent_at: null };
}
const setState = (type, value) => Setting.upsert({ key: STATE_PREFIX + type, value, description: 'Alert dedup state' });

/** Mark a problem active; email unless one of this type went out within the cooldown. */
async function raise(type, facts) {
  try {
    const state = await getState(type);
    const cooldownMs = config.alerts.cooldownMinutes * 60000;
    const recentlySent = state.last_sent_at && Date.now() - new Date(state.last_sent_at).getTime() < cooldownMs;
    if (recentlySent || configProblem()) {
      if (!state.active) await setState(type, { ...state, active: true });
      return { sent: false, reason: recentlySent ? 'cooldown' : 'disabled' };
    }
    const sent = await send(type, facts);
    // Only a delivered email starts the cooldown — a failed send gets retried by the next event.
    await setState(type, { active: true, last_sent_at: sent ? new Date().toISOString() : state.last_sent_at });
    return { sent };
  } catch (err) {
    console.error(`[alerts] raise("${type}") failed: ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

/** If any of `types` is active, clear them and send `recoveryType` once. */
async function resolve(types, recoveryType, facts) {
  try {
    const active = [];
    for (const type of types) {
      // eslint-disable-next-line no-await-in-loop
      const state = await getState(type);
      if (state.active) {
        active.push(type);
        // eslint-disable-next-line no-await-in-loop
        await setState(type, { ...state, active: false });
      }
    }
    if (!active.length) return { sent: false, reason: 'nothing active' };
    return { sent: await send(recoveryType, { 'Resolved alerts': active.join(', '), ...facts }) };
  } catch (err) {
    console.error(`[alerts] resolve("${recoveryType}") failed: ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { raise, resolve, send, render, configProblem, logConfigStatus, TEMPLATES, retryDelays: RETRY_DELAYS_MS, _resetTransporter: () => (transporter = undefined) };
