const { Op } = require('sequelize');
const { safeText, evidenceText } = require('../services/leadExportService');
const {
  Lead,
  Company,
  User,
  Activity,
  Task,
  Note,
  LeadStatusHistory,
  LeadScore,
  Signal,
  CompanyContact,
  CompanyWebsite,
  DetectedSignal,
  LeadSource,
  LeadAssignment,
} = require('../models');
const access = require('../services/accessService');
const audit = require('../services/auditService');
const { can } = require('../config/permissions');
const { ok, parsePagination, paginated } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');
const { assignLead, convertCompanyToLead, changeLeadStatus, markContacted, setContactStatus, setLeadStatus, recontact } = require('../services/leadService');
const { qualifyWithNemotron } = require('../services/aiQualificationService');
const { sendCsv } = require('../utils/csv');

const companyAttrs = ['id', 'company_name', 'cin', 'industry', 'state', 'city', 'website', 'date_of_incorporation'];
const companyAttrsFull = [...companyAttrs, 'contactability_score', 'has_email', 'has_phone', 'has_website'];

function buildLeadWhere(q) {
  const where = {};
  if (q.status) where.status = q.status.includes(',') ? { [Op.in]: q.status.split(',') } : q.status;
  if (q.lead_temperature) where.lead_temperature = q.lead_temperature;
  if (q.assigned_user_id) where.assigned_user_id = q.assigned_user_id === 'unassigned' ? null : q.assigned_user_id;
  if (q.priority) where.priority = q.priority;
  if (q.contact_status) where.contact_status = q.contact_status.includes(',') ? { [Op.in]: q.contact_status.split(',') } : q.contact_status;
  if (q.lead_status) where.lead_status = q.lead_status;
  if (q.source) where.source = q.source;
  // "New leads" view (Priority 13): NOT_CONTACTED + not archived + score >= configured
  // minimum, unless the caller explicitly opts into seeing previously-contacted ones.
  if (q.new_only === 'true' && q.include_contacted !== 'true') {
    where.contact_status = 'NOT_CONTACTED';
    where.lead_status = { [Op.ne]: 'ARCHIVED' };
  }

  const score = {};
  if (q.min_score) score[Op.gte] = Number(q.min_score);
  else if (q.new_only === 'true' && q.new_leads_min_score) score[Op.gte] = Number(q.new_leads_min_score);
  if (q.max_score) score[Op.lte] = Number(q.max_score);
  if (Object.getOwnPropertySymbols(score).length) where.lead_score = score;

  const created = {};
  if (q.created_from) created[Op.gte] = new Date(q.created_from);
  // A plain date ("2026-10-29") means the whole day, so stop before the next midnight.
  if (q.created_to) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.created_to)) created[Op.lt] = new Date(new Date(q.created_to).getTime() + 86400000);
    else created[Op.lte] = new Date(q.created_to);
  }
  if (Object.getOwnPropertySymbols(created).length) where.created_at = created;

  const follow = {};
  if (q.follow_up_from) follow[Op.gte] = new Date(q.follow_up_from);
  if (q.follow_up_to) follow[Op.lte] = new Date(q.follow_up_to);
  if (q.follow_up_due === 'true') follow[Op.lte] = new Date();
  if (Object.getOwnPropertySymbols(follow).length) where.next_follow_up_at = follow;

  return where;
}

function companyWhere(q) {
  const cw = {};
  if (q.industry) cw.industry = { [likeOp]: `%${q.industry}%` };
  if (q.state) cw.state = q.state;
  if (q.city) cw.city = q.city;
  // Website prospects: businesses where discovery found no website (a signal, not proof they lack one).
  if (q.has_website === 'false') cw.has_website = false;
  if (q.has_website === 'true') cw.has_website = true;
  if (q.search) {
    cw[Op.or] = [
      { company_name: { [likeOp]: `%${q.search}%` } },
      { cin: { [likeOp]: `%${q.search}%` } },
      { website: { [likeOp]: `%${q.search}%` } },
    ];
  }
  return Object.keys(cw).length || Object.getOwnPropertySymbols(cw).length ? cw : undefined;
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);

  // "New leads" view's score floor is server-configured (Automation Settings ->
  // Minimum lead score), not something the client passes — keeps the definition
  // of "new" consistent with what automation itself qualifies as a lead.
  if (req.query.new_only === 'true' && !req.query.min_score) {
    const { getSettings } = require('../services/automationSettingsService');
    const settings = await getSettings();
    req.query.new_leads_min_score = settings.minLeadScore;
  }

  if (req.query.mine === 'true') req.query.assigned_user_id = req.user.id;
  const where = { [Op.and]: [buildLeadWhere(req.query), await access.leadScope(req.user)] };
  const cw = companyWhere(req.query);

  const sortable = ['lead_score', 'created_at', 'next_follow_up_at', 'status', 'estimated_value'];
  const sort = sortable.includes(req.query.sort) ? req.query.sort : 'lead_score';
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const { rows, count } = await Lead.findAndCountAll({
    where,
    include: [
      {
        model: Company,
        as: 'company',
        attributes: companyAttrsFull,
        include: [
          { model: CompanyContact, as: 'contacts' },
          { model: CompanyWebsite, as: 'websites' },
          { model: DetectedSignal, as: 'detectedSignals' },
          {
            model: LeadSource,
            as: 'sources',
            attributes: ['provider', 'search_run_id', 'discovered_at'],
            separate: true,
            limit: 3,
            order: [['discovered_at', 'DESC']],
          },
        ],
        ...(cw ? { where: cw, required: true } : {}),
      },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
    order: [[sort, dir], ['id', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  // Searches are audited (plain paging/sorting is not — it isn't a meaningful business event).
  if (req.query.search) {
    const filters = ['status', 'lead_temperature', 'assigned_user_id', 'priority', 'contact_status', 'lead_status', 'source', 'industry', 'state', 'city']
      .filter((k) => req.query[k]);
    await audit.record(req, {
      action: 'lead.searched',
      resourceType: 'lead',
      metadata: { search: String(req.query.search).slice(0, 100), filters: filters.join(','), results: count, page },
    });
  }

  return ok(res, paginated(rows.map((l) => access.maskLead(req.user, l)), count, page, limit));
};

exports.exportCsv = async (req, res) => {
  const where = { [Op.and]: [buildLeadWhere(req.query), await access.leadScope(req.user)] };
  const cw = companyWhere(req.query);
  const rows = await Lead.findAll({
    where,
    include: [
      { model: Company, as: 'company', attributes: companyAttrs, ...(cw ? { where: cw, required: true } : {}) },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
    order: [['lead_score', 'DESC']],
    limit: 5000,
  });

  // One batch query for every row's phones/emails (no N+1).
  const contacts = await CompanyContact.findAll({
    where: { company_id: [...new Set(rows.map((l) => l.company_id))], type: ['phone', 'email'] },
    attributes: ['company_id', 'type', 'value'],
    order: [['is_primary', 'DESC'], ['id', 'ASC']],
    raw: true,
  });
  const byKey = new Map();
  for (const c of contacts) {
    const k = `${c.company_id}:${c.type}`;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(c.value);
  }
  const contactsOf = (companyId, type) => [...(byKey.get(`${companyId}:${type}`) || [])].join('; ');

  const flat = rows.map((l) => ({
    lead_id: l.id,
    company: l.company?.company_name || '',
    phone: contactsOf(l.company_id, 'phone'),
    email: contactsOf(l.company_id, 'email'),
    website: l.company?.website || '',
    cin: l.company?.cin || '',
    industry: l.company?.industry || '',
    state: l.company?.state || '',
    city: l.company?.city || '',
    status: l.status,
    priority: l.priority,
    lead_score: l.lead_score,
    lead_temperature: l.lead_temperature,
    recommended_service: l.recommended_service || '',
    // Free text from the AI qualification step — guarded against spreadsheet formula injection.
    problem: safeText(l.ai_problem) || '',
    evidence: safeText(evidenceText(l.ai_evidence)) || '',
    sales_angle: safeText(l.ai_sales_angle) || '',
    ai_summary: safeText(l.ai_summary) || '',
    ai_outreach_angle: safeText(l.ai_outreach_angle) || '',
    ai_recommended_service: l.ai_recommended_service || '',
    estimated_value: l.estimated_value ?? '',
    assigned_to: l.assignedUser?.name || '',
    next_follow_up_at: l.next_follow_up_at ? l.next_follow_up_at.toISOString() : '',
    last_contacted_at: l.last_contacted_at ? l.last_contacted_at.toISOString() : '',
    created_at: l.created_at.toISOString(),
  }));

  const filters = Object.fromEntries(
    Object.entries(req.query).filter(([k, v]) => v && k !== 'search').map(([k, v]) => [k, String(v).slice(0, 60)])
  );
  await audit.record(req, {
    action: 'lead.exported',
    resourceType: 'lead',
    fields: ['phone', 'email'],
    metadata: { format: 'csv', rows: flat.length, ...filters, ...(req.query.search ? { search: String(req.query.search).slice(0, 100) } : {}) },
  });
  return sendCsv(res, `leads-${Date.now()}.csv`, flat);
};

exports.get = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.id, {
    include: [
      {
        model: Company,
        as: 'company',
        include: [
          { model: CompanyContact, as: 'contacts' },
          { model: CompanyWebsite, as: 'websites' },
          { model: DetectedSignal, as: 'detectedSignals' },
          {
            model: LeadSource,
            as: 'sources',
            attributes: ['provider', 'search_run_id', 'discovered_at'],
            separate: true,
            limit: 5,
            order: [['discovered_at', 'DESC']],
          },
        ],
      },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
      { model: User, as: 'createdBy', attributes: ['id', 'name', 'email'] },
      { model: LeadStatusHistory, as: 'statusHistory', include: [{ model: User, as: 'changedBy', attributes: ['id', 'name'] }] },
      { model: LeadScore, as: 'scoreHistory', separate: true, order: [['created_at', 'DESC']], limit: 5 },
    ],
    order: [[{ model: LeadStatusHistory, as: 'statusHistory' }, 'created_at', 'ASC']],
  });
  const activities = await Activity.findAll({
    where: { lead_id: lead.id },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['occurred_at', 'DESC']],
  });
  const tasks = await Task.findAll({
    where: { lead_id: lead.id },
    include: [{ model: User, as: 'assignedUser', attributes: ['id', 'name'] }],
    order: [['due_date', 'ASC']],
  });
  const notes = await Note.findAll({
    where: { lead_id: lead.id },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
  });
  const signals = await Signal.findAll({
    where: { [Op.or]: [{ lead_id: lead.id }, { company_id: lead.company_id }] },
    order: [['captured_at', 'DESC']],
  });

  const assignments = await LeadAssignment.findAll({
    where: { lead_id: lead.id },
    include: ASSIGNMENT_INCLUDE,
    order: [['created_at', 'DESC']],
    limit: 50,
  });

  // "Lead opened": records which contact fields this response actually carried
  // (none for masked roles — those are logged per reveal instead).
  await audit.record(req, {
    action: 'lead.viewed',
    resourceType: 'lead',
    resourceId: lead.id,
    leadId: lead.id,
    companyId: lead.company_id,
    fields: access.exposedContactFields(req.user, lead.company),
    metadata: { status: lead.status, contact_status: lead.contact_status },
  });

  return ok(res, { lead: access.maskLead(req.user, lead), activities, tasks, notes, signals: access.maskSignals(req.user, signals), assignments });
};

exports.createFromCompany = async (req, res) => {
  const { company_id, assigned_user_id, priority, estimated_value } = req.body;
  if (!company_id) throw ApiError.badRequest('company_id is required');
  if (assigned_user_id) await assertAssignable(req.user, assigned_user_id);
  const { lead, created } = await convertCompanyToLead(company_id, {
    userId: req.user.id,
    assignedUserId: assigned_user_id,
    priority,
    estimatedValue: estimated_value,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (created) {
    if (lead.assigned_user_id) {
      await LeadAssignment.create({ lead_id: lead.id, previous_user_id: null, new_user_id: lead.assigned_user_id, assigned_by_user_id: req.user.id, reason: 'Initial owner' });
    }
    await audit.record(req, {
      action: 'lead.created',
      resourceType: 'lead',
      resourceId: lead.id,
      leadId: lead.id,
      companyId: lead.company_id,
      metadata: { assigned_user_id: lead.assigned_user_id },
    });
  }
  return ok(res, { lead: full, created }, created ? 201 : 200);
};

exports.update = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.id);

  const changed = [];
  const fields = ['priority', 'estimated_value', 'next_follow_up_at', 'lost_reason'];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    const v = req.body[f] === '' ? null : req.body[f];
    if (String(lead[f] ?? '') !== String(v ?? '')) changed.push(f);
    lead[f] = v;
  }
  await lead.save();
  if (changed.length) {
    await audit.record(req, {
      action: 'lead.updated',
      resourceType: 'lead',
      resourceId: lead.id,
      leadId: lead.id,
      companyId: lead.company_id,
      metadata: { fields: changed.join(',') },
    });
  }

  // Ownership changes go through the assignment workflow (permission + history + audit).
  if (req.body.assigned_user_id !== undefined) {
    const to = req.body.assigned_user_id === '' || req.body.assigned_user_id === null ? null : Number(req.body.assigned_user_id);
    if (to !== (lead.assigned_user_id ?? null)) await assignOne(req, lead, to, req.body.reason);
  }

  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  return ok(res, { lead: full });
};

/* ---------------- Assignment ---------------- */

const ASSIGNMENT_INCLUDE = [
  { model: User, as: 'previousUser', attributes: ['id', 'name'] },
  { model: User, as: 'newUser', attributes: ['id', 'name'] },
  { model: User, as: 'assignedBy', attributes: ['id', 'name'] },
];

// An actor may only assign to active users inside their own scope (Main Admin: anyone).
async function assertAssignable(actor, userId) {
  if (!can(actor, 'leads.assign')) throw ApiError.forbidden('You do not have permission to assign leads');
  const target = await User.findByPk(userId);
  if (!target || !target.is_active) throw ApiError.badRequest('Assignee not found or inactive');
  const ids = await access.visibleUserIds(actor);
  if (ids && !ids.includes(target.id)) throw ApiError.forbidden('You can only assign leads within your team');
  return target;
}

async function assignOne(req, lead, to, reason) {
  if (to === null) {
    if (!can(req.user, 'leads.assign')) throw ApiError.forbidden('You do not have permission to assign leads');
  } else {
    await assertAssignable(req.user, to);
  }
  const r = await assignLead(lead, to, { byUserId: req.user.id, reason });
  if (r.changed) {
    await audit.record(req, {
      action: r.from ? (to ? 'lead.reassigned' : 'lead.unassigned') : 'lead.assigned',
      resourceType: 'lead',
      resourceId: lead.id,
      leadId: lead.id,
      companyId: lead.company_id,
      metadata: { from_user_id: r.from, to_user_id: r.to, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) },
    });
  }
  return r;
}

// POST /leads/assign { lead_ids: [], user_id: number|null, reason? } — bulk (re)assignment.
exports.assign = async (req, res) => {
  const ids = [...new Set((req.body.lead_ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length || ids.length > 500) throw ApiError.badRequest('lead_ids must contain 1-500 lead ids');
  const raw = req.body.user_id;
  const to = raw === null || raw === '' || raw === undefined ? null : Number(raw);
  if (to !== null) await assertAssignable(req.user, to);

  const leads = await Lead.findAll({ where: { id: { [Op.in]: ids }, ...(await access.leadScope(req.user)) } });
  if (leads.length !== ids.length) throw ApiError.notFound('One or more leads were not found');

  let changed = 0;
  for (const lead of leads) {
    // eslint-disable-next-line no-await-in-loop
    if ((await assignOne(req, lead, to, req.body.reason)).changed) changed += 1;
  }
  if (ids.length > 1) {
    await audit.record(req, { action: 'lead.bulk_assigned', resourceType: 'lead', metadata: { count: ids.length, changed, to_user_id: to } });
  }
  return ok(res, { updated: changed, total: ids.length });
};

exports.assignments = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.id);
  const rows = await LeadAssignment.findAll({ where: { lead_id: lead.id }, include: ASSIGNMENT_INCLUDE, order: [['created_at', 'DESC']] });
  return ok(res, { assignments: rows });
};

/* ---------------- Contact reveal ---------------- */

// POST /leads/:id/contacts/:contactId/reveal — the only way a masked role gets a
// phone/email value. Logged (field names only, never the value) before it is returned.
exports.revealContact = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.id);
  const contact = await CompanyContact.findOne({ where: { id: req.params.contactId, company_id: lead.company_id } });
  if (!contact) throw ApiError.notFound('Contact not found');
  const actions = { phone: 'contact.phone_revealed', email: 'contact.email_revealed' };
  await audit.record(req, {
    action: actions[contact.type] || 'contact.revealed',
    resourceType: 'contact',
    resourceId: contact.id,
    leadId: lead.id,
    companyId: lead.company_id,
    contactId: contact.id,
    fields: [contact.type, ...(contact.linkedin_url ? ['linkedin_url'] : [])],
  });
  return ok(res, { contact: { id: contact.id, type: contact.type, value: contact.value, linkedin_url: contact.linkedin_url } });
};

exports.updateStatus = async (req, res) => {
  const before = await access.loadAccessibleLead(req.user, req.params.id);
  const lead = await changeLeadStatus(req.params.id, req.body.status, {
    userId: req.user.id,
    note: req.body.note,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (full.status !== before.status) {
    await audit.record(req, { action: 'lead.status_changed', resourceType: 'lead', resourceId: before.id, leadId: before.id, companyId: before.company_id, metadata: { field: 'status', from: before.status, to: full.status } });
  }
  return ok(res, { lead: full });
};

// [ CONTACT ] button — always sets contact_status=CONTACTED, contacted_at=now.
exports.contact = async (req, res) => {
  const before = await access.loadAccessibleLead(req.user, req.params.id);
  const lead = await markContacted(req.params.id, {
    userId: req.user.id,
    method: req.body.method,
    note: req.body.note,
    nextFollowUpAt: req.body.next_follow_up_at || undefined,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (true) {
    await audit.record(req, { action: 'lead.contacted', resourceType: 'lead', resourceId: before.id, leadId: before.id, companyId: before.company_id, metadata: { method: req.body.method || null, from: before.contact_status, to: full.contact_status } });
  }
  return ok(res, { lead: full });
};

// General contact-status transition (REPLIED, INTERESTED, MEETING_BOOKED, WON, LOST, DO_NOT_CONTACT, ...).
exports.updateContactStatus = async (req, res) => {
  const before = await access.loadAccessibleLead(req.user, req.params.id);
  const lead = await setContactStatus(req.params.id, req.body.contact_status, {
    userId: req.user.id,
    note: req.body.note,
    method: req.body.method,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (full.contact_status !== before.contact_status) {
    await audit.record(req, { action: 'lead.contact_status_changed', resourceType: 'lead', resourceId: before.id, leadId: before.id, companyId: before.company_id, metadata: { field: 'contact_status', from: before.contact_status, to: full.contact_status } });
  }
  return ok(res, { lead: full });
};

// Qualification state — independent of contact history.
exports.updateLeadStatus = async (req, res) => {
  const before = await access.loadAccessibleLead(req.user, req.params.id);
  const lead = await setLeadStatus(req.params.id, req.body.lead_status, { userId: req.user.id, note: req.body.note });
  const full = await Lead.findByPk(lead.id, {
    include: [{ model: Company, as: 'company', attributes: companyAttrs }],
  });
  if (full.lead_status !== before.lead_status) {
    await audit.record(req, { action: 'lead.lead_status_changed', resourceType: 'lead', resourceId: before.id, leadId: before.id, companyId: before.company_id, metadata: { field: 'lead_status', from: before.lead_status, to: full.lead_status } });
  }
  return ok(res, { lead: full });
};

// [ RE-CONTACT ] — manual only, moves an already-engaged lead back to FOLLOW_UP (or a chosen state).
exports.recontact = async (req, res) => {
  const before = await access.loadAccessibleLead(req.user, req.params.id);
  const lead = await recontact(req.params.id, {
    userId: req.user.id,
    toContactStatus: req.body.contact_status,
    note: req.body.note,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [{ model: Company, as: 'company', attributes: companyAttrs }],
  });
  if (true) {
    await audit.record(req, { action: 'lead.recontacted', resourceType: 'lead', resourceId: before.id, leadId: before.id, companyId: before.company_id, metadata: { from: before.contact_status, to: full.contact_status } });
  }
  return ok(res, { lead: full });
};

exports.remove = async (req, res) => {
  const lead = await access.loadAccessibleLead(req.user, req.params.id);
  await lead.destroy();
  await audit.record(req, { action: 'lead.deleted', resourceType: 'lead', resourceId: lead.id, leadId: lead.id, companyId: lead.company_id });
  return ok(res, { message: 'Lead deleted' });
};

// [ ANALYZE LEAD ] — Nemotron AI qualification. Idempotent: no-ops (status: 'skipped')
// if this lead was already successfully AI-qualified, so repeated clicks never spend
// an extra API call. Never throws for an ordinary AI failure — see qualifyWithNemotron.
exports.analyzeAI = async (req, res) => {
  await access.loadAccessibleLead(req.user, req.params.id);
  const result = await qualifyWithNemotron(req.params.id, { triggeredBy: 'manual', triggeredByUserId: req.user.id, force: false });
  if (result.status === 'failed' && result.reason === 'Lead not found') throw ApiError.notFound('Lead not found');
  const full = result.lead
    ? await Lead.findByPk(result.lead.id, { include: [{ model: Company, as: 'company', attributes: companyAttrs }] })
    : null;
  return ok(res, { status: result.status, reason: result.reason, lead: full });
};

// [ RE-ANALYZE LEAD ] — same as above but always makes a fresh Nemotron call, even if
// this lead already has a completed AI qualification (data may have changed since).
exports.reanalyzeAI = async (req, res) => {
  await access.loadAccessibleLead(req.user, req.params.id);
  const result = await qualifyWithNemotron(req.params.id, { triggeredBy: 'manual', triggeredByUserId: req.user.id, force: true });
  if (result.status === 'failed' && result.reason === 'Lead not found') throw ApiError.notFound('Lead not found');
  const full = result.lead
    ? await Lead.findByPk(result.lead.id, { include: [{ model: Company, as: 'company', attributes: companyAttrs }] })
    : null;
  return ok(res, { status: result.status, reason: result.reason, lead: full });
};
