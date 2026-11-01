const { Op } = require('sequelize');
const { SalesPlaybook, Outreach, AgentTask, Lead, Company, Task, Activity, EmailMessage } = require('../models');
const agent = require('./agentService');
const work = require('./agentWorkService');
const leadService = require('./leadService');
const audit = require('./auditService');
const ApiError = require('../utils/ApiError');

/**
 * AI Sales Intelligence: Claude Code's per-lead sales playbook (versioned), the
 * buttons that queue work for it, "mark as sent" for hand-sent outreach, follow-up
 * scheduling and the admin dashboard. Claude only ever writes; a person approves and sends.
 */

// Codefloor IT's actual services (FOUNDER_CONTEXT.md). A playbook may only recommend these.
const CODEFLOOR_SERVICES = ['Business website development', 'Custom web application development', 'E-commerce development', 'Website modernization', 'Maintenance and support'];

// Lead-page buttons -> what the queued sales_strategy task asks Claude for.
const FOCUS = {
  full: 'Full sales strategy',
  intelligence: 'Lead analysis',
  cold_email: 'Cold email',
  whatsapp: 'WhatsApp pitch',
  call_script: 'Call script',
  objections: 'Objection handling',
  follow_up_plan: 'Follow-up plan',
};
const FOLLOW_UP_CHANNELS = ['EMAIL', 'WHATSAPP', 'PHONE', 'LINKEDIN'];

const bad = (m) => {
  throw ApiError.badRequest(m);
};

/* ---------------- content validation ---------------- */

const str = (max) => (v, p) => {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > max) bad(`${p} must be text up to ${max} characters`);
  return v.trim();
};
const list = (item, maxN = 20) => (v, p) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > maxN) bad(`${p} must be a list of up to ${maxN} items`);
  return v.map((x, i) => item(x, `${p}[${i}]`));
};
const obj = (shape) => (v, p) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${p} must be an object`);
  const out = {};
  for (const k of Object.keys(v)) {
    if (!shape[k]) bad(`${p}.${k} is not a known field (allowed: ${Object.keys(shape).join(', ')})`);
    out[k] = shape[k](v[k], `${p}.${k}`);
  }
  return out;
};
const oneOf = (vals) => (v, p) => {
  if (!vals.includes(v)) bad(`${p} must be one of: ${vals.join(', ')}`);
  return v;
};
const int = (min, max) => (v, p) => {
  if (!Number.isInteger(v) || v < min || v > max) bad(`${p} must be a whole number ${min}-${max}`);
  return v;
};
const s = str(2000);
const items = list(str(500));

const SECTIONS = {
  intelligence: obj({
    industry: str(200),
    business_model: s,
    services: items,
    website_findings: items,
    technology_problems: items,
    software_opportunities: items,
    relevant_services: list(oneOf(CODEFLOOR_SERVICES), 5),
    lead_quality: obj({ rating: oneOf(SalesPlaybook.QUALITIES), reasons: items }),
    missing_information: items,
  }),
  sales_angle: obj({
    best_angle: s,
    primary_pain_point: s,
    recommended_solution: s,
    why_needed: s,
    expected_benefits: items,
    conversation_opener: s,
    why_codefloor: s,
    alternative_angles: items,
  }),
  objections: list(obj({ objection: str(300), response: s, next_action: str(500) }), 15),
  closing: obj({ negotiation_strategy: s, meeting_strategy: s, closing_approach: s, recommended_next_step: str(500) }),
  follow_up_schedule: list(obj({ day: int(0, 365), channel: oneOf(FOLLOW_UP_CHANNELS), action: str(300) }), 12),
};
const validateSections = obj(SECTIONS);

/* ---------------- agent side (bridge) ---------------- */

const latest = (leadId) => SalesPlaybook.findOne({ where: { lead_id: leadId }, order: [['version', 'DESC']] });

/**
 * Save a new playbook version. `sections` may hold only the parts this task produced;
 * the rest carries over from the previous version, so focused tasks keep history intact.
 */
async function savePlaybook(b, user, sessionId) {
  if (!b || typeof b !== 'object') bad('Body must be an object');
  if (b.lead_id == null) bad('lead_id is required');
  const sections = validateSections(b.sections, 'sections');
  if (!Object.keys(sections).length) bad('sections must contain at least one section');
  if (!Number.isInteger(b.confidence) || b.confidence < 0 || b.confidence > 100) bad('confidence must be an integer 0-100');
  const urls = b.source_urls ?? [];
  if (!Array.isArray(urls) || urls.length > 100 || !urls.every((u) => typeof u === 'string' && /^https?:\/\/[^\s]{3,1990}$/i.test(u))) bad('source_urls must be a list of up to 100 http(s) URLs');
  const task = await work.ownTask(b.task_id, sessionId);
  const { leadId, companyId } = await work.resolveRecord(user, b.lead_id, null);

  const prev = await latest(leadId);
  const content = { ...(prev?.content || {}), ...sections };
  let row;
  try {
    row = await SalesPlaybook.create({
      lead_id: leadId,
      company_id: companyId,
      version: (prev?.version || 0) + 1,
      task_id: task?.id ?? null,
      content,
      lead_quality: content.intelligence?.lead_quality?.rating || 'unknown',
      next_step: content.closing?.recommended_next_step || null,
      confidence: b.confidence,
      source_urls: [...new Set([...(prev?.source_urls || []), ...urls])].slice(0, 100),
      session_id: sessionId,
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw ApiError.conflict('Another playbook version was saved at the same time — fetch the latest and retry');
    throw err;
  }
  await agent.logActivity({ type: 'playbook_saved', action: `Sales playbook v${row.version} saved (${Object.keys(sections).join(', ')})`, taskId: task?.id, leadId, companyId, sessionId });
  return row.get({ plain: true });
}

/** What Claude needs before writing: the latest playbook, its drafts and the allowed services. */
async function playbookContext(user, leadId) {
  const { leadId: id } = await work.resolveRecord(user, leadId, null);
  const [pb, drafts] = await Promise.all([
    latest(id),
    Outreach.findAll({ where: { lead_id: id, generated_by: 'claude_code' }, attributes: ['id', 'channel', 'purpose', 'status', 'subject', 'created_at', 'sent_at'], order: [['created_at', 'DESC']], limit: 30 }),
  ]);
  return { playbook: pb, drafts, codefloor_services: CODEFLOOR_SERVICES, purposes: Object.keys(work.PURPOSES), sections: Object.keys(SECTIONS) };
}

/* ---------------- admin side ---------------- */

async function leadSales(leadId) {
  const lead = await Lead.findByPk(leadId, { attributes: ['id', 'company_id', 'contact_status', 'lead_score'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] });
  if (!lead) throw ApiError.notFound('Lead not found');
  const [playbooks, drafts, tasks] = await Promise.all([
    SalesPlaybook.findAll({ where: { lead_id: leadId }, order: [['version', 'DESC']], limit: 20 }),
    Outreach.findAll({ where: { lead_id: leadId, generated_by: 'claude_code' }, order: [['created_at', 'DESC']], limit: 50 }),
    AgentTask.findAll({ where: { lead_id: leadId }, attributes: ['id', 'type', 'title', 'status', 'error', 'input', 'created_at', 'completed_at'], order: [['created_at', 'DESC']], limit: 20 }),
  ]);
  return { lead, playbooks, drafts, tasks, codefloor_services: CODEFLOOR_SERVICES, focus: FOCUS };
}

async function queue(user, leadId, focus) {
  if (!FOCUS[focus]) bad(`focus must be one of: ${Object.keys(FOCUS).join(', ')}`);
  const lead = await Lead.findByPk(leadId, { include: [{ model: Company, as: 'company', attributes: ['company_name'] }] });
  if (!lead) throw ApiError.notFound('Lead not found');
  return agent.createTask({ type: 'sales_strategy', leadId: lead.id, title: `${FOCUS[focus]}: ${lead.company?.company_name || `lead #${lead.id}`}`, input: { focus } }, user);
}

/** Admin edit of a playbook version. Only the sections sent are replaced. */
async function editPlaybook(id, sectionsIn, user, req) {
  const pb = await SalesPlaybook.findByPk(id);
  if (!pb) throw ApiError.notFound('Playbook not found');
  const sections = validateSections(sectionsIn, 'sections');
  const content = { ...pb.content, ...sections };
  await pb.update({ content, lead_quality: content.intelligence?.lead_quality?.rating || 'unknown', next_step: content.closing?.recommended_next_step || null, edited_by_user_id: user.id, edited_at: new Date() });
  await audit.record(req, { action: 'sales.playbook_edited', resourceType: 'sales_playbook', resourceId: pb.id, leadId: pb.lead_id, companyId: pb.company_id, metadata: { sections: Object.keys(sections), version: pb.version } });
  return pb.get({ plain: true });
}

const CONTACT_METHOD = { EMAIL: 'EMAIL', FOLLOW_UP: 'EMAIL', PROPOSAL: 'EMAIL', WHATSAPP: 'WHATSAPP', LINKEDIN: 'LINKEDIN', PHONE_TALKING_POINTS: 'PHONE' };

/** A person sent an approved draft themselves (WhatsApp, call, LinkedIn, own mail client). Records it once. */
async function markSent(id, user, req) {
  const o = await Outreach.findByPk(id);
  if (!o) throw ApiError.notFound('Draft not found');
  if (o.status !== 'APPROVED') throw ApiError.conflict('Only approved drafts can be marked as sent');
  const [n] = await Outreach.update({ sent_at: new Date(), sent_by_user_id: user.id }, { where: { id, sent_at: null } });
  if (!n) throw ApiError.conflict('This draft is already marked as sent');
  const method = CONTACT_METHOD[o.channel] || 'OTHER';
  const lead = o.lead_id ? await Lead.findByPk(o.lead_id) : null;
  if (lead) {
    await Activity.create({ lead_id: lead.id, company_id: lead.company_id, user_id: user.id, type: method === 'PHONE' ? 'call' : method === 'EMAIL' ? 'email' : 'contacted', title: `${(o.purpose || o.channel).replace(/_/g, ' ')} sent by ${user.name}`.slice(0, 200), body: (o.subject || o.body).slice(0, 500), meta: { outreach_id: o.id } });
    if (lead.contact_status === 'NOT_CONTACTED') await leadService.markContacted(lead.id, { userId: user.id, method });
    else await lead.update({ last_contacted_at: new Date() });
  }
  await audit.record(req, { action: 'sales.outreach_marked_sent', resourceType: 'outreach', resourceId: o.id, leadId: o.lead_id, companyId: o.company_id, metadata: { channel: o.channel, purpose: o.purpose } });
  return (await Outreach.findByPk(id)).get({ plain: true });
}

/** Turn a playbook's follow-up schedule into CRM follow-up tasks. Re-running skips steps already created. */
async function scheduleFollowUps(id, user, req) {
  const pb = await SalesPlaybook.findByPk(id);
  if (!pb) throw ApiError.notFound('Playbook not found');
  const steps = pb.content?.follow_up_schedule || [];
  if (!steps.length) bad('This playbook has no follow-up schedule');
  const created = [];
  for (const [i, step] of steps.entries()) {
    const marker = `Sales playbook #${pb.id}, step ${i + 1}`;
    // eslint-disable-next-line no-await-in-loop
    if (await Task.count({ where: { lead_id: pb.lead_id, description: marker } })) continue;
    // eslint-disable-next-line no-await-in-loop
    const t = await Task.create({ lead_id: pb.lead_id, company_id: pb.company_id, assigned_user_id: user.id, created_by_user_id: user.id, title: `Follow-up (${step.channel.toLowerCase()}): ${step.action}`.slice(0, 200), description: marker, due_date: new Date(Date.now() + step.day * 86400e3), is_follow_up: true, follow_up_method: step.channel, status: 'TODO' });
    created.push(t.id);
  }
  await audit.record(req, { action: 'sales.follow_ups_scheduled', resourceType: 'sales_playbook', resourceId: pb.id, leadId: pb.lead_id, companyId: pb.company_id, metadata: { created: created.length } });
  return { created: created.length, skipped: steps.length - created.length };
}

const distinct = async (model, where, col = 'lead_id') => (await model.findAll({ where, attributes: [col], group: [col], raw: true })).length;

async function dashboard() {
  const since = new Date(Date.now() - 30 * 86400e3);
  const latestRows = await SalesPlaybook.findAll({ attributes: ['lead_id', 'version', 'lead_quality'], raw: true });
  const newest = new Map();
  for (const r of latestRows) if (!newest.has(r.lead_id) || newest.get(r.lead_id).version < r.version) newest.set(r.lead_id, r);
  const claude = { generated_by: 'claude_code', lead_id: { [Op.ne]: null } };

  const [analysed, withPitches, awaitingApproval, approvedUnsent, followUpsDue, history, recentDrafts, emailsSent, replies, tasksByStatus] = await Promise.all([
    distinct(AgentTask, { type: { [Op.in]: ['sales_strategy', 'analyse_lead'] }, status: 'COMPLETED', lead_id: { [Op.ne]: null } }),
    distinct(Outreach, claude),
    distinct(Outreach, { ...claude, status: 'PENDING_APPROVAL' }),
    Outreach.count({ where: { ...claude, status: 'APPROVED', sent_at: null } }),
    Task.count({ where: { is_follow_up: true, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] }, due_date: { [Op.lte]: new Date() } } }),
    SalesPlaybook.findAll({ attributes: ['id', 'lead_id', 'version', 'lead_quality', 'next_step', 'confidence', 'created_at', 'edited_at'], include: [{ model: Company, as: 'company', attributes: ['company_name'] }], order: [['created_at', 'DESC']], limit: 20 }),
    Outreach.findAll({ where: { generated_by: 'claude_code', created_at: { [Op.gte]: since } }, attributes: ['status', 'sent_at'], raw: true }),
    EmailMessage.count({ where: { direction: 'outbound', status: 'SENT', kind: { [Op.ne]: 'test' }, sent_at: { [Op.gte]: since } } }),
    EmailMessage.count({ where: { direction: 'inbound', received_at: { [Op.gte]: since } } }),
    AgentTask.findAll({ where: { type: 'sales_strategy' }, attributes: ['status'], raw: true }),
  ]);
  const tally = (rows, k) => rows.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] || 0) + 1 }), {});
  return {
    totals: {
      leads_analysed: Math.max(analysed, newest.size),
      leads_with_playbook: newest.size,
      high_potential: [...newest.values()].filter((r) => r.lead_quality === 'high').length,
      follow_ups_due: followUpsDue,
      leads_with_pitches: withPitches,
      leads_awaiting_approval: awaitingApproval,
      pending_sales_actions: approvedUnsent, // approved, not yet sent by anyone
    },
    quality: tally([...newest.values()], 'lead_quality'),
    sales_tasks: tally(tasksByStatus, 'status'),
    last_30_days: {
      drafts_created: recentDrafts.length,
      drafts_approved: recentDrafts.filter((d) => d.status === 'APPROVED').length,
      drafts_rejected: recentDrafts.filter((d) => d.status === 'REJECTED').length,
      drafts_sent: recentDrafts.filter((d) => d.sent_at).length,
      emails_sent: emailsSent,
      replies_received: replies,
    },
    history,
  };
}

module.exports = { CODEFLOOR_SERVICES, FOCUS, SECTIONS, validateSections, savePlaybook, playbookContext, leadSales, queue, editPlaybook, markSent, scheduleFollowUps, dashboard };
