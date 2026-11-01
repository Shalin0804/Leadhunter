/**
 * What the Claude Code agent produces and what admins decide on:
 *   - research reports (agent_reports)
 *   - outreach drafts awaiting approval (outreach.status) — never sent by the system
 *   - lead status proposals (agent_tasks type lead_change_proposal, AWAITING_APPROVAL)
 * plus the read-only analysis bundles behind the MCP research/reporting tools and the
 * dashboard analytics.
 *
 * The analysis bundles reuse the CRM's existing pure functions (website audit, opportunity
 * detection, signal detection, rule-based scoring and qualification) WITHOUT saving
 * anything, so discovery/enrichment/scoring behaviour is unchanged. Claude does the
 * reasoning and public-web research itself, inside the user's Claude Code session.
 */
const { Op } = require('sequelize');
const {
  Company, CompanyContact, CompanyWebsite, CompanySocial, DetectedSignal, Signal, Lead, LeadStatusHistory, SearchRun, Outreach, AgentTask, AgentReport, User, SalesPlaybook,
} = require('../models');
const access = require('./accessService');
const agent = require('./agentService');
const { auditWebsite } = require('./websiteAuditService');
const { detectOpportunities } = require('./opportunityDetectionService');
const { detectSignals } = require('./signalDetectionService');
const { scoreCompany } = require('./leadScoring');
const { qualify } = require('./aiQualificationService');
const { changeLeadStatus, setLeadStatus } = require('./leadService');
const ApiError = require('../utils/ApiError');

const bad = (m) => {
  throw ApiError.badRequest(m);
};
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const URL_RE = /^https?:\/\/[^\s]{3,1990}$/i;

/** The task a write is linked to must be RUNNING under this very session. */
async function ownTask(taskId, sessionId) {
  if (taskId == null) return null;
  const t = await AgentTask.findByPk(taskId);
  if (!t) throw ApiError.notFound(`Task #${taskId} not found`);
  if (t.status !== 'RUNNING' || t.claimed_by_session !== sessionId) throw ApiError.conflict(`Task #${taskId} is not running under this session`);
  return t;
}

/** Resolve lead/company through the normal scope checks; returns { leadId, companyId }. */
async function resolveRecord(user, leadId, companyId) {
  if (leadId != null) {
    if (!isInt(leadId, 1, 2 ** 31)) bad('lead_id must be a positive integer');
    const lead = await access.loadAccessibleLead(user, leadId);
    return { leadId, companyId: lead.company_id };
  }
  if (companyId != null) {
    if (!isInt(companyId, 1, 2 ** 31)) bad('company_id must be a positive integer');
    await access.assertCompanyAccess(user, companyId);
    return { leadId: null, companyId };
  }
  return { leadId: null, companyId: null };
}

/* ---------------- reports ---------------- */

async function saveReport(b, user, sessionId) {
  if (!b || typeof b !== 'object') bad('Body must be an object');
  if (!AgentReport.KINDS.includes(b.kind)) bad(`kind must be one of: ${AgentReport.KINDS.join(', ')}`);
  if (typeof b.title !== 'string' || b.title.trim().length < 3 || b.title.length > 200) bad('title must be 3-200 characters');
  if (b.summary != null && (typeof b.summary !== 'string' || b.summary.length > 10000)) bad('summary must be text up to 10000 characters');
  if (b.content != null && (typeof b.content !== 'object' || Array.isArray(b.content) || JSON.stringify(b.content).length > 200000)) bad('content must be a JSON object under 200 KB');
  const urls = b.source_urls ?? [];
  if (!Array.isArray(urls) || urls.length > 100 || !urls.every((u) => typeof u === 'string' && URL_RE.test(u))) bad('source_urls must be a list of up to 100 http(s) URLs');
  if (!isInt(b.confidence, 0, 100)) bad('confidence must be an integer 0-100');
  if (b.ai_score != null && (!isInt(b.ai_score, 0, 100) || b.kind !== 'lead_qualification')) bad('ai_score (0-100) is only for lead_qualification reports');
  if (['company_research', 'lead_qualification'].includes(b.kind) && b.lead_id == null && b.company_id == null) bad(`${b.kind} needs a lead_id or company_id`);
  if (b.kind === 'lead_qualification' && b.lead_id == null) bad('lead_qualification needs a lead_id');

  const task = await ownTask(b.task_id, sessionId);
  const { leadId, companyId } = await resolveRecord(user, b.lead_id ?? null, b.company_id ?? null);
  const report = await AgentReport.create({
    kind: b.kind,
    task_id: task?.id ?? null,
    company_id: companyId,
    lead_id: leadId,
    title: b.title.trim(),
    summary: b.summary ?? null,
    content: b.content ?? null,
    source_urls: urls,
    confidence: b.confidence,
    ai_score: b.ai_score ?? null,
    session_id: sessionId,
    created_by_user_id: user.id,
  });
  await agent.logActivity({ type: 'report_saved', action: `Report #${report.id} saved: ${report.title}`, taskId: task?.id, leadId, companyId, sessionId, metadata: { kind: report.kind, confidence: report.confidence } });
  return report.get({ plain: true });
}

/* ---------------- outreach drafts + approvals ---------------- */

const AGENT_CHANNELS = ['EMAIL', 'FOLLOW_UP', 'LINKEDIN', 'PROPOSAL', 'WHATSAPP', 'PHONE_TALKING_POINTS'];
// Which message of a sales pack a draft is -> the channel it must use.
const PURPOSES = {
  cold_email: ['EMAIL'],
  follow_up_email: ['EMAIL', 'FOLLOW_UP'],
  meeting_request: ['EMAIL', 'WHATSAPP', 'LINKEDIN'],
  whatsapp: ['WHATSAPP'],
  follow_up_whatsapp: ['WHATSAPP'],
  linkedin: ['LINKEDIN'],
  call_script: ['PHONE_TALKING_POINTS'],
  proposal: ['PROPOSAL'],
};

async function createDraft(b, user, sessionId) {
  if (!b || typeof b !== 'object') bad('Body must be an object');
  if (!AGENT_CHANNELS.includes(b.channel)) bad(`channel must be one of: ${AGENT_CHANNELS.join(', ')}`);
  if (b.lead_id == null) bad('lead_id is required');
  if (b.subject != null && (typeof b.subject !== 'string' || b.subject.length > 255)) bad('subject must be up to 255 characters');
  if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 20000) bad('body must be 1-20000 characters');
  const evidence = b.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 30 || !evidence.every((e) => typeof e === 'string' && e.length <= 500)) bad('evidence must be a list of up to 30 short facts');
  if (b.purpose != null && !PURPOSES[b.purpose]?.includes(b.channel)) bad(`purpose must be one of ${Object.keys(PURPOSES).join(', ')} and match the channel`);
  const task = await ownTask(b.task_id, sessionId);
  const { leadId, companyId } = await resolveRecord(user, b.lead_id, null);
  if (b.playbook_id != null && !(await SalesPlaybook.count({ where: { id: b.playbook_id, lead_id: leadId } }))) bad('playbook_id does not belong to this lead');
  const o = await Outreach.create({
    lead_id: leadId,
    company_id: companyId,
    created_by_user_id: user.id,
    channel: b.channel,
    subject: b.subject ?? null,
    body: b.body.trim(),
    evidence,
    generated_by: 'claude_code',
    status: 'PENDING_APPROVAL',
    agent_task_id: task?.id ?? null,
    purpose: b.purpose ?? null,
    playbook_id: b.playbook_id ?? null,
  });
  await agent.logActivity({ type: 'draft_created', action: `Outreach draft #${o.id} (${b.channel}) awaiting approval`, taskId: task?.id, leadId, companyId, sessionId });
  return o.get({ plain: true });
}

async function editDraft(id, { subject, body }, user) {
  const o = await Outreach.findOne({ where: { id, generated_by: 'claude_code' } });
  if (!o) throw ApiError.notFound('Draft not found');
  if (o.status === 'APPROVED') throw ApiError.conflict('An approved draft cannot be edited — reject it first');
  if (subject !== undefined && (subject !== null && (typeof subject !== 'string' || subject.length > 255))) bad('subject must be up to 255 characters');
  if (body !== undefined && (typeof body !== 'string' || !body.trim() || body.length > 20000)) bad('body must be 1-20000 characters');
  await o.update({ ...(subject !== undefined ? { subject } : {}), ...(body !== undefined ? { body: body.trim() } : {}) });
  await agent.logActivity({ type: 'draft_edited', action: `Outreach draft #${id} edited by ${user.name}`, leadId: o.lead_id, companyId: o.company_id });
  return o.get({ plain: true });
}

/** Approval only marks the draft ready for a human to send — the system never sends it. */
async function decideDraft(id, decision, note, user) {
  if (!['approve', 'reject'].includes(decision)) bad('Unknown decision');
  if (note != null && (typeof note !== 'string' || note.length > 500)) bad('note must be up to 500 characters');
  const o = await Outreach.findOne({ where: { id, generated_by: 'claude_code' } });
  if (!o) throw ApiError.notFound('Draft not found');
  const to = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const [n] = await Outreach.update(
    { status: to, reviewed_by_user_id: user.id, reviewed_at: new Date(), review_note: note || null },
    { where: { id, status: { [Op.in]: ['PENDING_APPROVAL', ...(decision === 'approve' ? ['REJECTED'] : ['APPROVED'])] } } }
  );
  if (!n) throw ApiError.conflict(`Draft is already ${o.status.toLowerCase().replace('_', ' ')}`);
  await agent.logActivity({ type: `draft_${decision === 'approve' ? 'approved' : 'rejected'}`, action: `Outreach draft #${id} ${to.toLowerCase()} by ${user.name}`, leadId: o.lead_id, companyId: o.company_id });
  return (await Outreach.findByPk(id)).get({ plain: true });
}

/* ---------------- lead status proposals ---------------- */

const PROPOSAL_FIELDS = { status: () => Lead.STATUSES, lead_status: () => Lead.LEAD_QUALIFICATION_STATUSES };

async function proposeLeadChange({ lead_id: leadId, field, value, reason, task_id: taskId }, user, sessionId) {
  if (!PROPOSAL_FIELDS[field]) bad(`field must be one of: ${Object.keys(PROPOSAL_FIELDS).join(', ')}`);
  if (!PROPOSAL_FIELDS[field]().includes(value)) bad(`value must be one of: ${PROPOSAL_FIELDS[field]().join(', ')}`);
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 2000) bad('reason must be 10-2000 characters');
  await ownTask(taskId, sessionId);
  const lead = await access.loadAccessibleLead(user, leadId);
  if (lead[field] === value) bad(`Lead ${field} is already ${value}`);
  return agent.createTask(
    { type: 'lead_change_proposal', leadId, title: `Change ${field === 'status' ? 'pipeline status' : 'qualification'} of LEAD-${leadId} to ${value}`, input: { field, from: lead[field], value, reason: reason.trim(), source_task_id: taskId ?? null }, priority: 5 },
    user,
    { internal: true, status: 'AWAITING_APPROVAL' }
  );
}

/** Approving applies the change through the same service the lead page uses (status history + timeline). */
async function decideProposal(id, decision, note, user, req) {
  if (!['approve', 'reject'].includes(decision)) bad('Unknown decision');
  const t = await AgentTask.findByPk(id);
  if (!t || t.type !== 'lead_change_proposal') throw ApiError.notFound('Proposal not found');
  if (t.status !== 'AWAITING_APPROVAL') throw ApiError.conflict(`Proposal is already ${t.status.toLowerCase()}`);
  const { field, value, reason } = t.input || {};
  if (!PROPOSAL_FIELDS[field]) throw ApiError.conflict('Proposal is malformed — reject it');
  // Load the lead before deciding, so a deleted lead can't leave a proposal marked done but not applied.
  const before = decision === 'approve' ? await access.loadAccessibleLead(user, t.lead_id) : null;
  // Claim the decision first so a double click can't apply it twice.
  const [n] = await AgentTask.update({ status: decision === 'approve' ? 'COMPLETED' : 'CANCELLED', completed_at: new Date(), dedupe_key: null }, { where: { id, status: 'AWAITING_APPROVAL' } });
  if (!n) throw ApiError.conflict('Proposal was decided meanwhile');
  let result = { decision, decided_by_user_id: user.id, note: note || null };
  if (decision === 'approve') {
    const opts = { userId: user.id, note: `Approved AI proposal: ${reason}`.slice(0, 1000) };
    try {
      if (field === 'status') await changeLeadStatus(t.lead_id, value, opts);
      else await setLeadStatus(t.lead_id, value, opts);
    } catch (err) {
      await AgentTask.update({ status: 'AWAITING_APPROVAL', completed_at: null }, { where: { id } });
      throw err;
    }
    result = { ...result, applied: true, from: before[field], to: value };
    await require('./auditService').record(req, { action: field === 'status' ? 'lead.status_changed' : 'lead.lead_status_changed', resourceType: 'lead', resourceId: t.lead_id, leadId: t.lead_id, companyId: t.company_id, metadata: { field, from: before[field], to: value, via: 'agent_proposal', proposal_id: id } });
  }
  await AgentTask.update({ result }, { where: { id } });
  await agent.logActivity({ type: `proposal_${decision === 'approve' ? 'approved' : 'rejected'}`, action: `Proposal #${id} ${decision === 'approve' ? 'approved and applied' : 'rejected'} by ${user.name}: ${t.title}`, taskId: id, leadId: t.lead_id, companyId: t.company_id });
  return (await AgentTask.findByPk(id)).get({ plain: true });
}

/* ---------------- research bundles (read-only, nothing saved) ---------------- */

const COMPANY_INCLUDE = [
  { model: CompanyContact, as: 'contacts' },
  { model: CompanyWebsite, as: 'websites' },
  { model: CompanySocial, as: 'socials' },
  { model: DetectedSignal, as: 'detectedSignals' },
  { model: Signal, as: 'signals' },
];

function storedAudit(company) {
  const w = (company.websites || []).find((x) => x.status !== 'no_website') || company.websites?.[0];
  if (!w) return null;
  return {
    status: w.status, health: w.health, isHttps: w.is_https, isMobileFriendly: w.is_mobile_friendly, httpStatus: w.http_status, responseTimeMs: w.response_time_ms,
    pageTitle: w.page_title, metaDescription: w.meta_description, technologies: w.detected_technologies, signals: w.audit_signals, featureFlags: w.feature_flags, checked_at: w.updated_at,
  };
}

/**
 * Everything the CRM already knows about a company, plus the rule-based analysis.
 * live=true re-fetches the homepage now (same single-page audit discovery uses).
 */
async function companyAnalysis(user, companyId, { live = false } = {}) {
  await access.assertCompanyAccess(user, companyId);
  const company = await Company.findByPk(companyId, { include: COMPANY_INCLUDE });
  if (!company) throw ApiError.notFound('Company not found');
  const websiteAudit = live ? { ...(await auditWebsite(company.website || null)), checked_at: new Date().toISOString(), live: true } : storedAudit(company);
  const scoring = scoreCompany(company);
  const opportunities = detectOpportunities({ industry: company.industry, websiteAudit: websiteAudit || { status: company.website ? 'unknown' : 'no_website' } });
  const signals = detectSignals({ company, websiteAudit: websiteAudit || undefined });
  const masked = access.maskCompany(user, company.get({ plain: true }));
  const reports = await AgentReport.findAll({ where: { company_id: companyId }, attributes: ['id', 'kind', 'title', 'summary', 'confidence', 'ai_score', 'created_at'], order: [['id', 'DESC']], limit: 5 });
  return {
    company: {
      id: masked.id, company_name: masked.company_name, website: masked.website, industry: masked.industry, company_category: masked.company_category, city: masked.city, state: masked.state,
      company_status: masked.company_status, date_of_incorporation: masked.date_of_incorporation, employee_count: masked.employee_count, linkedin_url: masked.linkedin_url, is_demo: masked.is_demo,
      lead_score: masked.lead_score, lead_temperature: masked.lead_temperature, recommended_service: masked.recommended_service,
    },
    contact_channels: (masked.contacts || []).map((c) => ({ type: c.type, value_masked: c.value, contact_name: c.contact_name, job_title: c.job_title, source: c.source, verification_status: c.verification_status })),
    socials: (company.socials || []).map((s) => ({ platform: s.platform, url: s.url })),
    website_audit: websiteAudit,
    rule_based: { score: scoring.score, temperature: scoring.temperature, recommended_service: scoring.recommendedService, breakdown: scoring.breakdown, reasons: scoring.reasons, missing_assets: scoring.missingAssets },
    opportunities,
    signals: { stored: (company.detectedSignals || []).map((s) => s.get({ plain: true })), detected_now: signals, buying_signals: (company.signals || []).map((s) => ({ service: s.service, headline: s.headline, status: s.status, source: s.source, captured_at: s.captured_at })) },
    previous_agent_reports: reports.map((r) => r.get({ plain: true })),
    _note: 'Rule-based CRM analysis only. Verify on the public web before claiming anything; cite source URLs in your report.',
  };
}

async function leadAnalysis(user, leadId, opts) {
  const lead = await access.loadAccessibleLead(user, leadId);
  const analysis = await companyAnalysis(user, lead.company_id, opts);
  const company = await Company.findByPk(lead.company_id, { include: COMPANY_INCLUDE });
  const scoring = scoreCompany(company);
  return {
    lead: {
      id: lead.id, status: lead.status, lead_status: lead.lead_status, contact_status: lead.contact_status, lead_score: lead.lead_score, lead_temperature: lead.lead_temperature,
      ai_qualification_status: lead.ai_qualification_status, ai_summary: lead.ai_summary, ai_problem: lead.ai_problem, next_follow_up_at: lead.next_follow_up_at, last_contacted_at: lead.last_contacted_at,
    },
    rule_based_qualification: qualify({ company, scoring, opportunities: analysis.opportunities, websiteAudit: analysis.website_audit || undefined }),
    ...analysis,
  };
}

/* ---------------- report data ---------------- */

const DAY = 24 * 3600 * 1000;

async function reportData(user, period) {
  if (!['daily', 'weekly', 'prospecting'].includes(period)) bad('period must be daily, weekly or prospecting');
  const since = new Date(Date.now() - (period === 'weekly' ? 7 : 1) * DAY);
  const scope = await access.leadScope(user);
  const slim = (l) => ({ id: l.id, company: l.company?.company_name, industry: l.company?.industry, city: l.company?.city, lead_score: l.lead_score, lead_temperature: l.lead_temperature, status: l.status, contact_status: l.contact_status });
  const leadInc = [{ model: Company, as: 'company', attributes: ['company_name', 'industry', 'city', 'is_demo'] }];
  if (period === 'prospecting') {
    const top = await Lead.findAll({ where: { [Op.and]: [scope, { contact_status: 'NOT_CONTACTED' }] }, include: leadInc, order: [['lead_score', 'DESC']], limit: 25 });
    const byIndustry = {};
    for (const l of top) byIndustry[l.company?.industry || 'Unknown'] = (byIndustry[l.company?.industry || 'Unknown'] || 0) + 1;
    return { period, generated_at: new Date().toISOString(), top_uncontacted_leads: top.map(slim), industries_in_top: byIndustry, config: await agent.getConfig() };
  }
  const [newLeads, statusChanges, companies, runs, tasks, drafts, reports, hot] = await Promise.all([
    Lead.count({ where: { [Op.and]: [scope, { created_at: { [Op.gte]: since } }] } }),
    LeadStatusHistory.count({ where: { created_at: { [Op.gte]: since } } }),
    Company.count({ where: { created_at: { [Op.gte]: since } } }),
    SearchRun.findAll({ where: { started_at: { [Op.gte]: since } }, attributes: ['id', 'status', 'started_at'], raw: true }),
    AgentTask.findAll({ where: { updated_at: { [Op.gte]: since } }, attributes: ['type', 'status'], raw: true }),
    Outreach.findAll({ where: { generated_by: 'claude_code', created_at: { [Op.gte]: since } }, attributes: ['status'], raw: true }),
    AgentReport.count({ where: { created_at: { [Op.gte]: since } } }),
    Lead.findAll({ where: { [Op.and]: [scope, { created_at: { [Op.gte]: since } }] }, include: leadInc, order: [['lead_score', 'DESC']], limit: 10 }),
  ]);
  const tally = (rows, key) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] || 0) + 1 }), {});
  return {
    period,
    from: since.toISOString(),
    to: new Date().toISOString(),
    crm: { new_leads: newLeads, status_changes: statusChanges, new_companies: companies, discovery_runs: runs.length, discovery_runs_by_status: tally(runs, 'status') },
    agent: { tasks_by_status: tally(tasks, 'status'), tasks_by_type: tally(tasks, 'type'), reports_saved: reports, outreach_drafts_by_status: tally(drafts, 'status') },
    top_new_leads: hot.map(slim),
  };
}

/* ---------------- analytics ---------------- */

async function analytics({ from, to }) {
  // A bare date (YYYY-MM-DD) means the whole of that day, not its first millisecond.
  const end = to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * DAY);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) bad('Invalid date range');
  if (end - start > 366 * DAY) bad('Date range can be at most one year');
  const range = { [Op.between]: [start, end] };
  const [tasks, reports, drafts, config] = await Promise.all([
    AgentTask.findAll({ where: { completed_at: range }, attributes: ['type', 'status', 'completed_at', 'duration_ms'], raw: true }),
    AgentReport.findAll({ where: { created_at: range }, attributes: ['kind', 'ai_score', 'created_at'], raw: true }),
    Outreach.findAll({ where: { generated_by: 'claude_code', created_at: range }, attributes: ['status', 'created_at'], raw: true }),
    agent.getConfig(),
  ]);
  const days = {};
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + DAY)) days[agent.dayKey(d)] = { date: agent.dayKey(d), leads_analysed: 0, companies_researched: 0, outreach_drafts: 0, completed: 0, failed: 0, reports: 0 };
  days[agent.dayKey(end)] ||= { date: agent.dayKey(end), leads_analysed: 0, companies_researched: 0, outreach_drafts: 0, completed: 0, failed: 0, reports: 0 };
  const bump = (date, k) => {
    const row = days[agent.dayKey(new Date(date))];
    if (row) row[k] += 1;
  };
  for (const t of tasks) {
    if (t.type === 'lead_change_proposal') continue;
    if (t.status === 'COMPLETED') {
      bump(t.completed_at, 'completed');
      if (t.type === 'analyse_lead') bump(t.completed_at, 'leads_analysed');
      if (t.type === 'research_company') bump(t.completed_at, 'companies_researched');
    } else if (t.status === 'FAILED') bump(t.completed_at, 'failed');
  }
  for (const r of reports) bump(r.created_at, 'reports');
  for (const o of drafts) bump(o.created_at, 'outreach_drafts');

  const research = tasks.filter((t) => t.type === 'research_company' && ['COMPLETED', 'FAILED'].includes(t.status));
  const scored = reports.filter((r) => r.kind === 'lead_qualification' && r.ai_score != null);
  const work = tasks.filter((t) => t.type !== 'lead_change_proposal');
  const done = work.filter((t) => t.status === 'COMPLETED' && t.duration_ms != null);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    series: Object.values(days),
    totals: {
      leads_analysed: work.filter((t) => t.type === 'analyse_lead' && t.status === 'COMPLETED').length,
      companies_researched: research.filter((t) => t.status === 'COMPLETED').length,
      qualified_leads: scored.filter((r) => r.ai_score >= config.min_lead_score).length,
      average_ai_score: scored.length ? Math.round(scored.reduce((a, r) => a + r.ai_score, 0) / scored.length) : null,
      research_success_rate: research.length ? Math.round((100 * research.filter((t) => t.status === 'COMPLETED').length) / research.length) : null,
      failed_tasks: work.filter((t) => t.status === 'FAILED').length,
      completed_tasks: work.filter((t) => t.status === 'COMPLETED').length,
      average_duration_ms: done.length ? Math.round(done.reduce((a, t) => a + t.duration_ms, 0) / done.length) : null,
      outreach_drafts: drafts.length,
      outreach_by_status: drafts.reduce((m, o) => ({ ...m, [o.status]: (m[o.status] || 0) + 1 }), {}),
      reports: reports.length,
    },
    qualified_threshold: config.min_lead_score,
  };
}

/* ---------------- admin listings ---------------- */

async function listReports({ kind, company_id: companyId, lead_id: leadId, search, page, limit, offset }) {
  const where = {};
  if (kind && AgentReport.KINDS.includes(kind)) where.kind = kind;
  if (Number(companyId) > 0) where.company_id = Number(companyId);
  if (Number(leadId) > 0) where.lead_id = Number(leadId);
  if (search) where.title = { [require('../utils/dialect').likeOp]: `%${String(search).slice(0, 100)}%` };
  const { rows, count } = await AgentReport.findAndCountAll({
    where,
    attributes: { exclude: ['content'] },
    include: [{ model: Company, as: 'company', attributes: ['id', 'company_name', 'website', 'industry', 'company_category', 'city'] }],
    order: [['id', 'DESC']],
    limit,
    offset,
  });
  return { rows, count, page, limit };
}

async function getReport(id) {
  const r = await AgentReport.findByPk(id, { include: [{ model: Company, as: 'company', attributes: ['id', 'company_name', 'website', 'industry', 'company_category', 'city', 'state', 'is_demo'] }, { model: AgentTask, as: 'task', attributes: ['id', 'title', 'type'] }] });
  if (!r) throw ApiError.notFound('Report not found');
  return r;
}

async function listDrafts({ status, page, limit, offset }) {
  const where = { generated_by: 'claude_code' };
  if (status && Outreach.STATUSES.includes(status)) where.status = status;
  const { rows, count } = await Outreach.findAndCountAll({
    where,
    include: [{ model: Company, as: 'company', attributes: ['id', 'company_name', 'website', 'is_demo'] }, { model: User, as: 'reviewedBy', attributes: ['id', 'name'] }],
    order: [['id', 'DESC']],
    limit,
    offset,
  });
  return { rows, count, page, limit };
}

module.exports = {
  saveReport, createDraft, editDraft, decideDraft, proposeLeadChange, decideProposal, companyAnalysis, leadAnalysis, reportData, analytics, listReports, getReport, listDrafts, AGENT_CHANNELS, PURPOSES, ownTask, resolveRecord,
};
