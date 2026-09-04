const { Op } = require('sequelize');
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
} = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');
const { convertCompanyToLead, changeLeadStatus, markContacted, setContactStatus, setLeadStatus, recontact } = require('../services/leadService');
const { sendCsv } = require('../utils/csv');

const companyAttrs = ['id', 'company_name', 'cin', 'industry', 'state', 'city', 'website', 'date_of_incorporation'];

function buildLeadWhere(q) {
  const where = {};
  if (q.status) where.status = q.status.includes(',') ? { [Op.in]: q.status.split(',') } : q.status;
  if (q.lead_temperature) where.lead_temperature = q.lead_temperature;
  if (q.assigned_user_id) where.assigned_user_id = q.assigned_user_id;
  if (q.priority) where.priority = q.priority;
  if (q.contact_status) where.contact_status = q.contact_status.includes(',') ? { [Op.in]: q.contact_status.split(',') } : q.contact_status;
  if (q.lead_status) where.lead_status = q.lead_status;
  if (q.source) where.source = q.source;
  // "New leads" view: hide anything already engaged, unless explicitly asked to include it.
  if (q.new_only === 'true' && q.include_contacted !== 'true') where.contact_status = 'NOT_CONTACTED';

  const score = {};
  if (q.min_score) score[Op.gte] = Number(q.min_score);
  if (q.max_score) score[Op.lte] = Number(q.max_score);
  if (Object.getOwnPropertySymbols(score).length) where.lead_score = score;

  const created = {};
  if (q.created_from) created[Op.gte] = new Date(q.created_from);
  if (q.created_to) created[Op.lte] = new Date(q.created_to);
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
  if (q.search) {
    cw[Op.or] = [
      { company_name: { [likeOp]: `%${q.search}%` } },
      { cin: { [likeOp]: `%${q.search}%` } },
    ];
  }
  return Object.keys(cw).length || Object.getOwnPropertySymbols(cw).length ? cw : undefined;
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = buildLeadWhere(req.query);
  const cw = companyWhere(req.query);

  const sortable = ['lead_score', 'created_at', 'next_follow_up_at', 'status', 'estimated_value'];
  const sort = sortable.includes(req.query.sort) ? req.query.sort : 'lead_score';
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const { rows, count } = await Lead.findAndCountAll({
    where,
    include: [
      { model: Company, as: 'company', attributes: companyAttrs, ...(cw ? { where: cw, required: true } : {}) },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
    order: [[sort, dir], ['id', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return ok(res, paginated(rows, count, page, limit));
};

exports.exportCsv = async (req, res) => {
  const where = buildLeadWhere(req.query);
  const rows = await Lead.findAll({
    where,
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
    order: [['lead_score', 'DESC']],
    limit: 5000,
  });

  const flat = rows.map((l) => ({
    lead_id: l.id,
    company: l.company?.company_name || '',
    cin: l.company?.cin || '',
    industry: l.company?.industry || '',
    state: l.company?.state || '',
    city: l.company?.city || '',
    status: l.status,
    priority: l.priority,
    lead_score: l.lead_score,
    lead_temperature: l.lead_temperature,
    recommended_service: l.recommended_service || '',
    estimated_value: l.estimated_value ?? '',
    assigned_to: l.assignedUser?.name || '',
    next_follow_up_at: l.next_follow_up_at ? l.next_follow_up_at.toISOString() : '',
    last_contacted_at: l.last_contacted_at ? l.last_contacted_at.toISOString() : '',
    created_at: l.created_at.toISOString(),
  }));

  return sendCsv(res, `leads-${Date.now()}.csv`, flat);
};

exports.get = async (req, res) => {
  const lead = await Lead.findByPk(req.params.id, {
    include: [
      { model: Company, as: 'company' },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
      { model: User, as: 'createdBy', attributes: ['id', 'name', 'email'] },
      { model: LeadStatusHistory, as: 'statusHistory', include: [{ model: User, as: 'changedBy', attributes: ['id', 'name'] }] },
      { model: LeadScore, as: 'scoreHistory', separate: true, order: [['created_at', 'DESC']], limit: 5 },
    ],
    order: [[{ model: LeadStatusHistory, as: 'statusHistory' }, 'created_at', 'ASC']],
  });
  if (!lead) throw ApiError.notFound('Lead not found');

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

  return ok(res, { lead, activities, tasks, notes, signals });
};

exports.createFromCompany = async (req, res) => {
  const { company_id, assigned_user_id, priority, estimated_value } = req.body;
  if (!company_id) throw ApiError.badRequest('company_id is required');
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
  return ok(res, { lead: full, created }, created ? 201 : 200);
};

exports.update = async (req, res) => {
  const lead = await Lead.findByPk(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');

  const before = { assigned_user_id: lead.assigned_user_id };
  const fields = ['priority', 'estimated_value', 'next_follow_up_at', 'assigned_user_id', 'lost_reason'];
  for (const f of fields) if (req.body[f] !== undefined) lead[f] = req.body[f] === '' ? null : req.body[f];
  await lead.save();

  if (req.body.assigned_user_id !== undefined && req.body.assigned_user_id != before.assigned_user_id) {
    const u = lead.assigned_user_id ? await User.findByPk(lead.assigned_user_id) : null;
    await Activity.create({
      lead_id: lead.id,
      company_id: lead.company_id,
      user_id: req.user.id,
      type: 'assignment',
      title: u ? `Assigned to ${u.name}` : 'Unassigned',
    });
  }

  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  return ok(res, { lead: full });
};

exports.updateStatus = async (req, res) => {
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
  return ok(res, { lead: full });
};

// [ CONTACT ] button — always sets contact_status=CONTACTED, contacted_at=now.
exports.contact = async (req, res) => {
  const lead = await markContacted(req.params.id, {
    userId: req.user.id,
    method: req.body.method,
    note: req.body.note,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [
      { model: Company, as: 'company', attributes: companyAttrs },
      { model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] },
    ],
  });
  return ok(res, { lead: full });
};

// General contact-status transition (REPLIED, INTERESTED, MEETING_BOOKED, WON, LOST, DO_NOT_CONTACT, ...).
exports.updateContactStatus = async (req, res) => {
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
  return ok(res, { lead: full });
};

// Qualification state — independent of contact history.
exports.updateLeadStatus = async (req, res) => {
  const lead = await setLeadStatus(req.params.id, req.body.lead_status, { userId: req.user.id, note: req.body.note });
  const full = await Lead.findByPk(lead.id, {
    include: [{ model: Company, as: 'company', attributes: companyAttrs }],
  });
  return ok(res, { lead: full });
};

// [ RE-CONTACT ] — manual only, moves an already-engaged lead back to FOLLOW_UP (or a chosen state).
exports.recontact = async (req, res) => {
  const lead = await recontact(req.params.id, {
    userId: req.user.id,
    toContactStatus: req.body.contact_status,
    note: req.body.note,
  });
  const full = await Lead.findByPk(lead.id, {
    include: [{ model: Company, as: 'company', attributes: companyAttrs }],
  });
  return ok(res, { lead: full });
};

exports.remove = async (req, res) => {
  const lead = await Lead.findByPk(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  await lead.destroy();
  return ok(res, { message: 'Lead deleted' });
};
