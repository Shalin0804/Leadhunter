const { Op } = require('sequelize');
const { EmailMessage, EmailCampaign, Outreach, Task, Lead, Company } = require('../models');
const email = require('../services/emailService');
const replies = require('../services/emailReplyService');
const agent = require('../services/agentService');
const access = require('../services/accessService');
const audit = require('../services/auditService');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const config = require('../config/config');

// Everything here sits behind requirePermission('email.send') (Main Admin only).

const KIND = (k) => (k === 'follow_up' ? 'follow_up' : 'initial');

async function ownDraft(id) {
  const msg = await EmailMessage.findByPk(id);
  if (!msg || msg.direction !== 'outbound' || msg.kind === 'test') throw ApiError.notFound('Email not found');
  return msg;
}

/* ---------------- settings ---------------- */

exports.settings = async (req, res) => {
  const [status, lastHour, lastDay] = await Promise.all([email.getStatus(), email.sentInLast(3600e3), email.sentInLast(86400e3)]);
  const imapProblem = replies.imapProblem();
  return ok(res, {
    ...email.configStatus(),
    status,
    usage: { last_hour: lastHour, last_24h: lastDay },
    imap: { enabled: !imapProblem, problem: imapProblem, host: config.email.imap.host, port: config.email.imap.port },
    footer: email.footer(),
    admin_email: req.user.email,
  });
};

exports.testConnection = async (req, res) => {
  const status = await email.verifyConnection();
  await audit.record(req, { action: 'email.connection_tested', resourceType: 'email_settings' });
  return ok(res, { status });
};

exports.testEmail = async (req, res) => {
  const msg = await email.sendTestEmail(req.body?.to || req.user.email, req.user, req);
  if (msg.status !== 'SENT') throw new ApiError(502, `Test email failed: ${msg.error}`);
  return ok(res, { message: 'Test email accepted by the SMTP server', sent_at: msg.sent_at });
};

/* ---------------- per-lead: history, composer, follow-ups ---------------- */

exports.leadOverview = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.leadId);
  const full = await email.loadLeadForEmail(lead.id);
  const [messages, claudeDrafts, followUps, recipients] = await Promise.all([
    EmailMessage.findAll({ where: { lead_id: lead.id }, order: [['created_at', 'DESC']], limit: 200 }),
    Outreach.findAll({ where: { lead_id: lead.id, generated_by: 'claude_code', channel: { [Op.in]: ['EMAIL', 'FOLLOW_UP'] }, status: { [Op.ne]: 'REJECTED' } }, order: [['created_at', 'DESC']], limit: 10 }),
    Task.findAll({ where: { lead_id: lead.id, is_follow_up: true }, order: [['due_date', 'ASC']] }),
    email.recipientsFor(full),
  ]);
  const blocked = recipients[0] ? await email.leadProblem(full, recipients[0].email, 'initial') : null;
  return ok(res, { messages, claude_drafts: claudeDrafts, follow_ups: followUps, recipients, blocked_reason: blocked, from: { name: email.configStatus().from_name, address: email.fromAddress() }, configured: email.configStatus().configured, footer: email.footer() });
};

exports.generate = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.body?.lead_id);
  const draft = await email.draftFor(await email.loadLeadForEmail(lead.id), { kind: KIND(req.body.kind), useAI: !!req.body.use_ai, toEmail: req.body.to_email });
  return ok(res, { draft });
};

/** Ask the Claude Code agent to write this email (it drafts; a human sends). */
exports.claudeDraft = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.leadId);
  const kind = KIND(req.body?.kind);
  const prev = kind === 'follow_up' ? await EmailMessage.findOne({ where: { lead_id: lead.id, direction: 'outbound', status: 'SENT' }, order: [['sent_at', 'DESC']] }) : null;
  const task = await agent.createTask(
    {
      type: 'generate_outreach',
      leadId: lead.id,
      input: {
        channel: kind === 'follow_up' ? 'FOLLOW_UP' : 'EMAIL',
        purpose: `Email from ${email.configStatus().from_name} <${email.fromAddress()}> — a draft for the LeadHunter email composer`,
        ...(prev ? { previous_email: { subject: prev.subject, body: prev.body.slice(0, 4000), sent_at: prev.sent_at } } : {}),
      },
    },
    req.user
  );
  return ok(res, { task }, 201);
};

exports.saveDraft = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.body?.lead_id);
  const fields = await email.validateDraft(await email.loadLeadForEmail(lead.id), req.body);
  const outreachId = req.body.outreach_id ? Number(req.body.outreach_id) : null;
  if (outreachId && !(await Outreach.count({ where: { id: outreachId, lead_id: lead.id } }))) throw ApiError.badRequest('outreach_id does not belong to this lead');
  const msg = await EmailMessage.create({
    ...fields, lead_id: lead.id, company_id: lead.company_id, outreach_id: outreachId, kind: KIND(req.body.kind), status: 'DRAFT',
    from_email: email.fromAddress() || '', generated_by: String(req.body.generated_by || 'manual').slice(0, 20), created_by_user_id: req.user.id,
  });
  await audit.record(req, { action: 'email.draft_saved', resourceType: 'email_message', resourceId: msg.id, leadId: lead.id, companyId: lead.company_id });
  return ok(res, { message: msg }, 201);
};

exports.updateDraft = async (req, res) => {
  const msg = await ownDraft(req.params.id);
  if (msg.status !== 'DRAFT') throw ApiError.conflict('Only drafts can be edited');
  const lead = await access.loadAccessibleLead(req.user, msg.lead_id);
  const fields = await email.validateDraft(await email.loadLeadForEmail(lead.id), { to_email: msg.to_email, subject: msg.subject, body: msg.body, ...req.body });
  await msg.update(fields);
  return ok(res, { message: msg });
};

exports.removeDraft = async (req, res) => {
  const msg = await ownDraft(req.params.id);
  if (msg.status !== 'DRAFT') throw ApiError.conflict('Only drafts can be removed');
  await msg.destroy();
  return ok(res, { message: 'Draft removed' });
};

exports.send = async (req, res) => {
  const msg = await ownDraft(req.params.id);
  if (msg.campaign_id) {
    const c = await EmailCampaign.findByPk(msg.campaign_id);
    if (c?.status === 'SENDING') throw ApiError.conflict('This email belongs to a campaign that is sending');
  }
  await access.loadAccessibleLead(req.user, msg.lead_id);
  const sent = await email.sendMessage(msg.id, req.user, req);
  return ok(res, { message: sent });
};

/* ---------------- campaigns ---------------- */

exports.listCampaigns = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, count } = await EmailCampaign.findAndCountAll({ order: [['created_at', 'DESC']], limit, offset });
  const ids = rows.map((r) => r.id);
  const tallies = ids.length ? await EmailMessage.findAll({ where: { campaign_id: { [Op.in]: ids } }, attributes: ['campaign_id', 'status'], raw: true }) : [];
  const items = rows.map((r) => {
    const mine = tallies.filter((t) => t.campaign_id === r.id);
    return { ...r.get({ plain: true }), counts: mine.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] || 0) + 1 }), { total: mine.length }) };
  });
  return ok(res, paginated(items, count, page, limit));
};

exports.prepareCampaign = async (req, res) => {
  const b = req.body || {};
  const result = await email.prepareCampaign({ leadIds: b.lead_ids, useAI: !!b.use_ai, kind: KIND(b.kind), name: b.name }, req.user, (id) => access.loadAccessibleLead(req.user, id));
  await audit.record(req, { action: 'email.campaign_prepared', resourceType: 'email_campaign', resourceId: result.campaign.id, metadata: { drafts: result.campaign.counts.total, skipped: result.skipped.length } });
  return ok(res, result, 201);
};

exports.getCampaign = async (req, res) => ok(res, { campaign: await email.campaignDetail(req.params.id) });
exports.startCampaign = async (req, res) => ok(res, { campaign: await email.startCampaign(req.params.id, { confirm: req.body?.confirm, expectedCount: req.body?.expected_count }, req.user) }, 202);
exports.cancelCampaign = async (req, res) => ok(res, { campaign: await email.cancelCampaign(req.params.id, req.user) });

/* ---------------- follow-ups + replies ---------------- */

/** Open email follow-ups across all leads, with what was last sent and whether they replied. */
exports.followUps = async (req, res) => {
  const tasks = await Task.findAll({
    where: { is_follow_up: true, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] }, lead_id: { [Op.ne]: null } },
    include: [{ model: Lead, as: 'lead', attributes: ['id', 'contact_status'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] }],
    order: [['due_date', 'ASC']],
    limit: 200,
  });
  const leadIds = [...new Set(tasks.map((t) => t.lead_id))];
  const msgs = leadIds.length ? await EmailMessage.findAll({ where: { lead_id: { [Op.in]: leadIds }, status: { [Op.in]: ['SENT', 'RECEIVED'] } }, attributes: ['lead_id', 'direction', 'subject', 'sent_at', 'received_at'], order: [['id', 'DESC']], raw: true }) : [];
  const items = tasks.map((t) => {
    const lastSent = msgs.find((m) => m.lead_id === t.lead_id && m.direction === 'outbound');
    const replied = msgs.some((m) => m.lead_id === t.lead_id && m.direction === 'inbound' && (!lastSent || new Date(m.received_at) >= new Date(lastSent.sent_at)));
    return { ...t.get({ plain: true }), last_sent: lastSent || null, replied };
  });
  return ok(res, { items });
};

exports.syncReplies = async (req, res) => {
  const result = await replies.syncReplies({ user: req.user });
  await audit.record(req, { action: 'email.replies_synced', resourceType: 'email_settings', metadata: result });
  return ok(res, result);
};

exports.recent = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = {};
  if (req.query.status && EmailMessage.STATUSES.includes(req.query.status)) where.status = req.query.status;
  const { rows, count } = await EmailMessage.findAndCountAll({
    where,
    include: [{ model: Lead, as: 'lead', attributes: ['id'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] }],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};
