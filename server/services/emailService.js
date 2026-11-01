const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const config = require('../config/config');
const { EmailMessage, EmailCampaign, Lead, Company, Outreach, Activity, Setting } = require('../models');
const { SCORING_INCLUDE } = require('./companyService');
const { scoreCompany } = require('./leadScoring');
const { generate, generateWithAI } = require('./outreachGeneratorService');
const leadService = require('./leadService');
const audit = require('./auditService');
const ApiError = require('../utils/ApiError');

/**
 * Outbound prospect email through the official Titan mailbox (SMTP), plus the
 * guards around it: recipient must be a stored contact of the lead's company,
 * opted-out / not-interested leads are refused, the same address is not emailed
 * twice inside the duplicate window, and Titan's hourly/daily caps are respected.
 * Nothing here ever runs without an explicit admin action (single send or a
 * confirmed campaign). Credentials come from env only and never leave this module.
 */

const STATUS_KEY = 'email.status';
const BLOCKED_CONTACT_STATUSES = ['DO_NOT_CONTACT', 'NOT_INTERESTED'];
const RETRY_DELAYS_MS = [5000, 30000];
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z]{2,}$/i;

const cfg = () => config.email;
const fromAddress = () => cfg().fromAddress || cfg().user;
const isValidEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
const normEmail = (v) => String(v || '').trim().toLowerCase();
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

function configStatus() {
  const c = cfg();
  const missing = [];
  if (!c.host) missing.push('TITAN_SMTP_HOST');
  if (!c.user) missing.push('TITAN_SMTP_USER');
  if (!c.pass) missing.push('TITAN_SMTP_PASSWORD');
  if (!isValidEmail(fromAddress())) missing.push('EMAIL_FROM_ADDRESS');
  return {
    provider: 'Titan Mail',
    configured: missing.length === 0,
    missing,
    host: c.host,
    port: c.port,
    secure: c.secure,
    user: c.user || null,
    password_set: !!c.pass, // the value itself is never returned
    from_name: c.fromName,
    from_address: fromAddress() || null,
    limits: { hourly: c.hourlyLimit, daily: c.dailyLimit, bulk_max: c.bulkMax, send_delay_ms: c.sendDelayMs, max_retries: c.maxRetries, duplicate_window_hours: c.duplicateWindowHours },
  };
}

let transport;
function getTransport() {
  if (!transport) {
    const c = cfg();
    // secure=true -> implicit TLS (465); false -> STARTTLS is required (587), never plaintext.
    transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  }
  return transport;
}

function assertConfigured() {
  const s = configStatus();
  if (!s.configured) throw new ApiError(503, `Email is not configured on the server: set ${s.missing.join(', ')}`);
}

/** SMTP error -> short, credential-free text. nodemailer's messages never include the password. */
const smtpError = (err) => oneLine([err.responseCode, err.code, err.response || err.message].filter(Boolean).join(' ')).slice(0, 1000);
// 4xx replies and dropped connections are worth another try; 5xx and auth failures are not.
const isTransient = (err) => (err.responseCode >= 400 && err.responseCode < 500) || ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err.code);

async function getStatus() {
  const row = await Setting.findOne({ where: { key: STATUS_KEY } });
  return row?.value || {};
}
async function setStatus(patch) {
  const value = { ...(await getStatus()), ...patch };
  await Setting.upsert({ key: STATUS_KEY, value, description: 'Titan email connection / sync status' });
  return value;
}

async function verifyConnection() {
  assertConfigured();
  try {
    await getTransport().verify();
    return setStatus({ last_verified_at: new Date().toISOString(), last_verify_error: null });
  } catch (err) {
    await setStatus({ last_verify_error: smtpError(err), last_verify_failed_at: new Date().toISOString() });
    throw new ApiError(502, `SMTP connection failed: ${smtpError(err)}`);
  }
}

const footer = () =>
  `\n\n--\n${cfg().fromName}\n${fromAddress()}\nIf you would prefer not to receive emails from us, reply with "unsubscribe" and we will not contact you again.`;

async function sentInLast(ms) {
  return EmailMessage.count({
    where: { direction: 'outbound', [Op.or]: [{ status: 'SENDING' }, { status: 'SENT', sent_at: { [Op.gte]: new Date(Date.now() - ms) } }] },
  });
}

/** Why sending now would break Titan's caps, or null. */
async function limitProblem() {
  if ((await sentInLast(3600e3)) >= cfg().hourlyLimit) return `Hourly sending limit reached (${cfg().hourlyLimit}/hour)`;
  if ((await sentInLast(86400e3)) >= cfg().dailyLimit) return `Daily sending limit reached (${cfg().dailyLimit}/day)`;
  return null;
}

/** Email contacts of the lead's company that may be emailed (raw values — admin-only callers). */
async function recipientsFor(lead) {
  const company = lead.company || (await Company.findByPk(lead.company_id, { include: SCORING_INCLUDE }));
  return (company.contacts || [])
    .filter((c) => c.type === 'email' && c.verification_status !== 'INVALID' && isValidEmail(normEmail(c.value)))
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
    .map((c) => ({ id: c.id, email: normEmail(c.value), contact_name: c.contact_name || null, job_title: c.job_title || null, is_primary: c.is_primary, verification_status: c.verification_status || null }));
}

async function hasOptedOut(email) {
  return !!(await EmailMessage.count({ where: { direction: 'inbound', from_email: email, opt_out: true } }));
}

async function repliedSinceLastSend(leadId) {
  const last = await EmailMessage.max('sent_at', { where: { lead_id: leadId, direction: 'outbound', status: 'SENT' } });
  if (!last) return false;
  return !!(await EmailMessage.count({ where: { lead_id: leadId, direction: 'inbound', received_at: { [Op.gte]: last } } }));
}

/** Why this lead must not receive this email, or null. */
async function leadProblem(lead, toEmail, kind) {
  if (BLOCKED_CONTACT_STATUSES.includes(lead.contact_status)) return `Lead is marked ${lead.contact_status.replace(/_/g, ' ').toLowerCase()}`;
  if (await hasOptedOut(toEmail)) return 'This recipient replied "unsubscribe"';
  if (kind === 'follow_up' && (await repliedSinceLastSend(lead.id))) return 'The prospect has replied since the last email — answer the reply instead of sending a follow-up';
  return null;
}

async function duplicateProblem(msg) {
  const since = new Date(Date.now() - cfg().duplicateWindowHours * 3600e3);
  const dup = await EmailMessage.findOne({
    where: { id: { [Op.ne]: msg.id }, direction: 'outbound', kind: { [Op.ne]: 'test' }, to_email: msg.to_email, [Op.or]: [{ status: 'SENDING' }, { status: 'SENT', sent_at: { [Op.gte]: since } }] },
    attributes: ['id', 'sent_at'],
  });
  return dup ? `This address was already emailed within the last ${cfg().duplicateWindowHours} hours (email #${dup.id})` : null;
}

/** Validates subject/body/recipient for a lead email draft. Returns cleaned fields. */
async function validateDraft(lead, { to_email: to, subject, body }) {
  const toEmail = normEmail(to);
  if (!isValidEmail(toEmail)) throw ApiError.badRequest('A valid recipient email is required');
  const allowed = await recipientsFor(lead);
  if (!allowed.some((r) => r.email === toEmail)) throw ApiError.badRequest("The recipient must be one of this company's stored email contacts");
  const s = oneLine(subject);
  if (!s || s.length > 255) throw ApiError.badRequest('subject must be 1-255 characters');
  if (typeof body !== 'string' || !body.trim() || body.length > 20000) throw ApiError.badRequest('body must be 1-20000 characters');
  return { to_email: toEmail, subject: s, body: body.trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ponytail: in-process lock, fine for the single Render instance; move to a DB lock if the API scales out.
const inFlight = new Set();

/**
 * Send one stored outbound email. Throws ApiError (row untouched) when a guard refuses;
 * resolves with the row as SENT or FAILED once SMTP was attempted.
 */
async function sendMessage(id, user, req = null) {
  assertConfigured();
  const msg = await EmailMessage.findByPk(id);
  if (!msg || msg.direction !== 'outbound') throw ApiError.notFound('Email not found');
  if (!['DRAFT', 'QUEUED', 'FAILED'].includes(msg.status)) throw ApiError.conflict(`Email is already ${msg.status.toLowerCase()}`);

  // Take the per-address lock before any await, so two drafts to the same address can't
  // both pass the duplicate check below.
  if (inFlight.has(msg.to_email)) throw ApiError.conflict('An email to this address is being sent right now');
  inFlight.add(msg.to_email);

  let lead = null;
  try {
    if (msg.kind !== 'test') {
      lead = await Lead.findByPk(msg.lead_id);
      if (!lead) throw ApiError.notFound('Lead not found');
      const problem = (await leadProblem(lead, msg.to_email, msg.kind)) || (await duplicateProblem(msg));
      if (problem) throw ApiError.conflict(problem);
    }
    const limit = await limitProblem();
    if (limit) throw Object.assign(new ApiError(429, limit), { limit: true });

    // Atomic claim: a double click or a second worker can never send the same row twice.
    const [claimed] = await EmailMessage.update(
      { status: 'SENDING', message_id: msg.message_id || `<${crypto.randomUUID()}@${fromAddress().split('@')[1]}>`, error: null },
      { where: { id: msg.id, status: msg.status } }
    );
    if (!claimed) throw ApiError.conflict('Email is already being sent');
    await msg.reload();

    let inReplyTo = msg.in_reply_to;
    if (msg.kind === 'follow_up' && !inReplyTo) {
      const prev = await EmailMessage.findOne({ where: { lead_id: msg.lead_id, direction: 'outbound', status: 'SENT' }, order: [['sent_at', 'DESC']] });
      inReplyTo = prev?.message_id || null;
    }
    const mail = {
      from: { name: cfg().fromName, address: fromAddress() },
      to: msg.to_email, // always exactly one recipient — never CC/BCC lists
      subject: msg.subject,
      text: msg.body + (msg.kind === 'test' ? '' : footer()),
      messageId: msg.message_id,
      ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
      headers: msg.kind === 'test' ? {} : { 'List-Unsubscribe': `<mailto:${fromAddress()}?subject=unsubscribe>` },
    };

    let lastErr;
    let tries = 0;
    for (let attempt = 0; attempt <= cfg().maxRetries; attempt += 1) {
      tries += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const info = await getTransport().sendMail(mail);
        await msg.update({ status: 'SENT', sent_at: new Date(), attempts: msg.attempts + tries, in_reply_to: inReplyTo, smtp_response: oneLine(info.response).slice(0, 255) || null, sent_by_user_id: user?.id ?? null, error: null });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === cfg().maxRetries) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(module.exports.retryDelays[attempt] ?? 30000);
      }
    }
    if (lastErr) {
      await msg.update({ status: 'FAILED', attempts: msg.attempts + tries, error: smtpError(lastErr) });
      if (lastErr.code === 'EAUTH') await setStatus({ last_verify_error: smtpError(lastErr), last_verify_failed_at: new Date().toISOString() });
    } else {
      await setStatus({ last_sent_at: msg.sent_at.toISOString() });
      if (lead) await afterSend(lead, msg, user);
    }
  } finally {
    inFlight.delete(msg.to_email);
  }

  await audit.record(req, {
    actor: user,
    action: msg.status === 'SENT' ? 'email.sent' : 'email.failed',
    resourceType: 'email_message',
    resourceId: msg.id,
    leadId: msg.lead_id,
    companyId: msg.company_id,
    result: msg.status === 'SENT' ? 'success' : 'failure',
    metadata: { kind: msg.kind, campaign_id: msg.campaign_id, attempts: msg.attempts }, // no addresses or content
  });
  return msg;
}

/** One activity per successfully sent email (retries update the same row, so no duplicates). */
async function afterSend(lead, msg, user) {
  await Activity.create({ lead_id: lead.id, company_id: lead.company_id, user_id: user?.id ?? null, type: 'email', title: `Email sent: ${msg.subject}`.slice(0, 200), body: msg.body.slice(0, 500), meta: { email_message_id: msg.id, campaign_id: msg.campaign_id } });
  if (lead.contact_status === 'NOT_CONTACTED') await leadService.markContacted(lead.id, { userId: user?.id, method: 'EMAIL' });
  else await lead.update({ last_contacted_at: new Date() });
  // Sending a Claude Code draft is the human approval of it.
  if (msg.outreach_id) {
    await Outreach.update({ status: 'APPROVED', reviewed_by_user_id: user?.id ?? null, reviewed_at: new Date() }, { where: { id: msg.outreach_id, status: 'PENDING_APPROVAL' } });
    await Outreach.update({ sent_at: msg.sent_at, sent_by_user_id: user?.id ?? null }, { where: { id: msg.outreach_id, sent_at: null } });
  }
}

async function sendTestEmail(to, user, req) {
  const toEmail = normEmail(to);
  if (!isValidEmail(toEmail)) throw ApiError.badRequest('A valid test recipient is required');
  assertConfigured();
  const msg = await EmailMessage.create({
    kind: 'test',
    status: 'DRAFT',
    to_email: toEmail,
    from_email: fromAddress(),
    subject: `[LeadHunter] Test email from ${cfg().fromName}`,
    body: `This is a test email sent from LeadHunter CRM through ${cfg().host}:${cfg().port}.\nIf you received it, outbound email works.`,
    generated_by: 'system',
    created_by_user_id: user.id,
  });
  const sent = await sendMessage(msg.id, user, req);
  if (sent.status === 'SENT') await setStatus({ last_test_at: sent.sent_at.toISOString(), last_verified_at: sent.sent_at.toISOString(), last_verify_error: null });
  return sent;
}

/* ---------------- drafting ---------------- */

async function loadLeadForEmail(leadId) {
  const lead = await Lead.findByPk(leadId, { include: [{ model: Company, as: 'company', include: SCORING_INCLUDE }] });
  if (!lead) throw ApiError.notFound('Lead not found');
  return lead;
}

const reSubject = (s) => (/^re:/i.test(s) ? s : `Re: ${s}`);
const quote = (m) => `\n\nOn ${new Date(m.sent_at).toUTCString()}, ${cfg().fromName} wrote:\n${m.body.split('\n').map((l) => `> ${l}`).join('\n')}`;

/** Latest Claude Code draft for this lead (not rejected) for the given channel. */
const latestClaudeDraft = (leadId, channel) =>
  Outreach.findOne({ where: { lead_id: leadId, generated_by: 'claude_code', channel, status: { [Op.ne]: 'REJECTED' } }, order: [['created_at', 'DESC']] });

/**
 * A draft built only from stored facts (existing generator: rule-based, or Nemotron when
 * use_ai). Follow-ups quote the last sent email so the context travels with it.
 */
async function draftFor(lead, { kind = 'initial', useAI = false, toEmail = null } = {}) {
  const company = lead.company;
  const recipients = await recipientsFor(lead);
  const contact = recipients.find((r) => r.email === normEmail(toEmail)) || recipients[0];
  const channel = kind === 'follow_up' ? 'FOLLOW_UP' : 'EMAIL';
  const args = { company, analysis: scoreCompany(company), aiQualification: lead.ai_analysis || null, contactName: contact?.contact_name || undefined };
  const d = useAI ? await generateWithAI(channel, args) : { ...generate(channel, args), generatedBy: 'rule_based' };
  let subject = d.subject || `Following up: ${company.company_name}`;
  let body = String(d.body).replace(/\[Your name\]/g, cfg().fromName);
  if (kind === 'follow_up') {
    const prev = await EmailMessage.findOne({ where: { lead_id: lead.id, direction: 'outbound', status: 'SENT' }, order: [['sent_at', 'DESC']] });
    if (prev) {
      subject = reSubject(prev.subject);
      body += quote(prev);
    }
  }
  return { to_email: contact?.email || null, subject: oneLine(subject).slice(0, 255), body, generated_by: d.generatedBy, evidence: d.evidence || [], ai_error: d.aiError || null };
}

/* ---------------- campaigns ---------------- */

/**
 * Builds a DRAFT campaign: one individually addressed draft per selected lead. Prefers a
 * Claude Code draft for that lead when one exists; otherwise uses the generator. Leads with
 * no usable email, a blocked status, or an address already in the campaign are skipped.
 */
async function prepareCampaign({ leadIds, useAI = false, kind = 'initial', name }, user, accessCheck) {
  const ids = [...new Set((leadIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw ApiError.badRequest('Select at least one lead');
  if (ids.length > cfg().bulkMax) throw ApiError.badRequest(`At most ${cfg().bulkMax} leads per campaign (EMAIL_BULK_MAX)`);
  // eslint-disable-next-line no-await-in-loop
  for (const leadId of ids) await accessCheck(leadId); // all-or-nothing: no half-built campaign
  const campaign = await EmailCampaign.create({ name: oneLine(name).slice(0, 160) || `Campaign ${new Date().toISOString().slice(0, 10)}`, created_by_user_id: user.id });
  const skipped = [];
  const seen = new Set();
  for (const leadId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const lead = await loadLeadForEmail(leadId);
    const label = lead.company?.company_name || `Lead #${leadId}`;
    // eslint-disable-next-line no-await-in-loop
    const recipient = (await recipientsFor(lead))[0];
    if (!recipient) { skipped.push({ lead_id: leadId, company: label, reason: 'No usable email address on file' }); continue; }
    if (seen.has(recipient.email)) { skipped.push({ lead_id: leadId, company: label, reason: 'Same address as another lead in this campaign' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const problem = await leadProblem(lead, recipient.email, kind);
    if (problem) { skipped.push({ lead_id: leadId, company: label, reason: problem }); continue; }
    seen.add(recipient.email);
    // eslint-disable-next-line no-await-in-loop
    const claude = await latestClaudeDraft(leadId, kind === 'follow_up' ? 'FOLLOW_UP' : 'EMAIL');
    // eslint-disable-next-line no-await-in-loop
    const d = claude
      ? { to_email: recipient.email, subject: oneLine(claude.subject || `A quick note for ${label}`).slice(0, 255), body: claude.body, generated_by: 'claude_code' }
      : await draftFor(lead, { kind, useAI, toEmail: recipient.email });
    // eslint-disable-next-line no-await-in-loop
    await EmailMessage.create({ lead_id: lead.id, company_id: lead.company_id, campaign_id: campaign.id, outreach_id: claude?.id ?? null, kind, status: 'DRAFT', to_email: recipient.email, from_email: fromAddress() || '', subject: d.subject, body: d.body, generated_by: d.generated_by, created_by_user_id: user.id });
  }
  return { campaign: await campaignDetail(campaign.id), skipped };
}

async function campaignDetail(id) {
  const campaign = await EmailCampaign.findByPk(id, {
    include: [{ model: EmailMessage, as: 'messages', include: [{ model: Lead, as: 'lead', attributes: ['id', 'contact_status'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] }] }],
    order: [[{ model: EmailMessage, as: 'messages' }, 'id', 'ASC']],
  });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  const plain = campaign.get({ plain: true });
  plain.counts = EmailMessage.STATUSES.reduce((m, s) => ({ ...m, [s]: plain.messages.filter((x) => x.status === s).length }), { total: plain.messages.length });
  plain.running = running.has(plain.id);
  return plain;
}

const running = new Set();

/** Queue the confirmed drafts and start the background worker. `expectedCount` must match what the admin confirmed. */
async function startCampaign(id, { confirm, expectedCount }, user) {
  assertConfigured();
  if (confirm !== true) throw ApiError.badRequest('Explicit confirmation is required to send');
  const campaign = await EmailCampaign.findByPk(id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!['DRAFT', 'PAUSED'].includes(campaign.status)) throw ApiError.conflict(`Campaign is ${campaign.status.toLowerCase()}`);
  if (running.has(campaign.id)) throw ApiError.conflict('Campaign is already sending');
  const pending = await EmailMessage.count({ where: { campaign_id: id, status: { [Op.in]: ['DRAFT', 'QUEUED'] } } });
  if (!pending) throw ApiError.badRequest('There are no emails left to send in this campaign');
  if (Number(expectedCount) !== pending) throw ApiError.conflict(`The campaign now has ${pending} emails to send, not ${expectedCount} — review it again before confirming`);
  await EmailMessage.update({ status: 'QUEUED' }, { where: { campaign_id: id, status: 'DRAFT' } });
  await campaign.update({ status: 'SENDING', status_note: null, started_at: campaign.started_at || new Date() });
  await audit.record(null, { actor: user, action: 'email.campaign_started', resourceType: 'email_campaign', resourceId: id, metadata: { recipients: pending } });
  module.exports._worker = runCampaign(id, user).catch((err) => console.error(`[email] campaign ${id} worker crashed: ${err.message}`));
  return campaignDetail(id);
}

async function runCampaign(id, user) {
  running.add(id);
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const campaign = await EmailCampaign.findByPk(id);
      if (campaign.status !== 'SENDING') return;
      // eslint-disable-next-line no-await-in-loop
      const next = await EmailMessage.findOne({ where: { campaign_id: id, status: 'QUEUED' }, order: [['id', 'ASC']] });
      if (!next) {
        // eslint-disable-next-line no-await-in-loop
        await campaign.update({ status: 'COMPLETED', completed_at: new Date() });
        return;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const sent = await sendMessage(next.id, user);
        if (sent.status === 'FAILED' && /EAUTH/.test(sent.error || '')) {
          // Every later email would fail the same way — stop and let the admin fix the credentials.
          // eslint-disable-next-line no-await-in-loop
          await campaign.update({ status: 'PAUSED', status_note: 'SMTP authentication failed — check TITAN_SMTP_USER / TITAN_SMTP_PASSWORD, then resume' });
          return;
        }
      } catch (err) {
        if (err.limit) {
          // eslint-disable-next-line no-await-in-loop
          await campaign.update({ status: 'PAUSED', status_note: `${err.message} — resume later` });
          return;
        }
        // A guard refused this one (duplicate, opted out, ...): record why and carry on.
        // eslint-disable-next-line no-await-in-loop
        await EmailMessage.update({ status: 'FAILED', error: String(err.message).slice(0, 1000) }, { where: { id: next.id, status: 'QUEUED' } });
      }
      // Pace sends (Titan rate limits); no wait after the last one.
      // eslint-disable-next-line no-await-in-loop
      if (await EmailMessage.count({ where: { campaign_id: id, status: 'QUEUED' } })) await sleep(cfg().sendDelayMs);
    }
  } finally {
    running.delete(id);
  }
}

async function cancelCampaign(id, user) {
  const campaign = await EmailCampaign.findByPk(id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) throw ApiError.conflict(`Campaign is already ${campaign.status.toLowerCase()}`);
  await campaign.update({ status: 'CANCELLED', completed_at: new Date() });
  // Unsent emails go back to drafts; the one in flight (if any) finishes.
  await EmailMessage.update({ status: 'DRAFT' }, { where: { campaign_id: id, status: 'QUEUED' } });
  await audit.record(null, { actor: user, action: 'email.campaign_cancelled', resourceType: 'email_campaign', resourceId: id });
  return campaignDetail(id);
}

/** After a restart nothing is still sending: rows left SENDING may or may not have gone out. */
async function recoverInterrupted() {
  const [n] = await EmailMessage.update(
    { status: 'FAILED', error: 'Interrupted by a server restart while sending — check the Titan Sent folder before retrying' },
    { where: { direction: 'outbound', status: 'SENDING' } }
  );
  await EmailCampaign.update({ status: 'PAUSED', status_note: 'Paused by a server restart — resume to continue' }, { where: { status: 'SENDING' } });
  return n;
}

module.exports = {
  configStatus,
  verifyConnection,
  getStatus,
  setStatus,
  sendMessage,
  sendTestEmail,
  recipientsFor,
  leadProblem,
  draftFor,
  loadLeadForEmail,
  latestClaudeDraft,
  validateDraft,
  prepareCampaign,
  campaignDetail,
  startCampaign,
  cancelCampaign,
  recoverInterrupted,
  sentInLast,
  footer,
  fromAddress,
  isValidEmail,
  normEmail,
  isTransient,
  retryDelays: RETRY_DELAYS_MS,
  _setTransport: (t) => (transport = t),
  _worker: null,
};
