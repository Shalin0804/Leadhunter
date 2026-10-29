/**
 * Activity Log, Lead Access History, Audit Trail and Team Performance.
 * Everything is read-only (audit rows are append-only) and scoped by actor:
 * Main Admin sees everyone, a manager their team, everyone else only themselves.
 */
const { Op } = require('sequelize');
const { sequelize, AuditLog, User, Lead, Company, LeadAssignment } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');
const { sendCsv } = require('../utils/csv');
const { visibleUserIds } = require('../services/accessService');
const audit = require('../services/auditService');
const { ROLES, ROLE_LABELS, PERMISSIONS, MATRIX } = require('../config/permissions');

const DISPLAY_TZ = process.env.DISPLAY_TIMEZONE || 'Asia/Kolkata';

// Named views over the same log — the three UI pages are presets of one query.
const ACCESS_ACTIONS = ['lead.viewed', 'company.viewed', 'lead.searched', 'lead.exported'];
const SECURITY_ACTIONS = [
  'lead.exported', 'lead.deleted', 'lead.assigned', 'lead.reassigned', 'lead.unassigned', 'lead.bulk_assigned', 'audit.exported',
];
const presetWhere = (preset) => {
  if (preset === 'access') return { [Op.or]: [{ action: { [Op.in]: ACCESS_ACTIONS } }, { action: { [likeOp]: 'contact.%' } }] };
  if (preset === 'security') {
    return { [Op.or]: [{ action: { [likeOp]: 'auth.%' } }, { action: { [likeOp]: 'user.%' } }, { action: { [Op.in]: SECURITY_ACTIONS } }] };
  }
  return {};
};

const parseDate = (v, endOfDay) => {
  if (!v) return null;
  // A bare date means that whole day in the display timezone (IST has no DST, so a fixed offset is exact).
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const offset = DISPLAY_TZ === 'Asia/Kolkata' ? '+05:30' : 'Z';
    const d = new Date(`${v}T00:00:00${offset}`);
    return endOfDay ? new Date(d.getTime() + 86400000) : d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`Invalid date: ${v}`);
  return d;
};

const int = (v) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : undefined);

async function buildWhere(req) {
  const q = req.query;
  const and = [presetWhere(q.preset)];
  const ids = await visibleUserIds(req.user);
  if (ids) and.push({ actor_user_id: { [Op.in]: ids } });
  if (int(q.actor_user_id)) and.push({ actor_user_id: int(q.actor_user_id) });
  if (q.action) and.push({ action: { [Op.in]: String(q.action).split(',').slice(0, 30) } });
  if (q.resource_type) and.push({ resource_type: q.resource_type });
  if (q.result) and.push({ result: q.result });
  for (const k of ['lead_id', 'company_id', 'contact_id']) if (int(q[k])) and.push({ [k]: int(q[k]) });

  const created = {};
  const from = parseDate(q.from, false);
  const to = parseDate(q.to, true);
  if (from) created[Op.gte] = from;
  if (to) created[/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? Op.lt : Op.lte] = to;
  if (Object.getOwnPropertySymbols(created).length) and.push({ created_at: created });

  // Current lead status ("where applicable") and company/actor text search use sub-selects
  // so pagination counts stay exact.
  if (q.lead_status) {
    const leadIds = (await Lead.findAll({ where: { status: q.lead_status }, attributes: ['id'], raw: true })).map((l) => l.id);
    and.push({ lead_id: { [Op.in]: leadIds } });
  }
  if (q.search) {
    const term = `%${String(q.search).slice(0, 100)}%`;
    const companyIds = (await Company.findAll({ where: { company_name: { [likeOp]: term } }, attributes: ['id'], limit: 500, raw: true })).map((c) => c.id);
    and.push({ [Op.or]: [{ actor_name: { [likeOp]: term } }, { action: { [likeOp]: term } }, { company_id: { [Op.in]: companyIds } }] });
  }
  return { [Op.and]: and };
}

const LIST_INCLUDE = [
  { model: User, as: 'actor', attributes: ['id', 'name', 'email', 'role'] },
  { model: Lead, as: 'lead', attributes: ['id', 'status', 'contact_status'] },
  { model: Company, as: 'company', attributes: ['id', 'company_name'] },
];

function order(q) {
  const cols = { created_at: 'created_at', action: 'action', actor: 'actor_name' };
  const col = cols[q.sort] || 'created_at';
  return [[col, String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'], ['id', 'DESC']];
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 200 });
  const { rows, count } = await AuditLog.findAndCountAll({ where: await buildWhere(req), include: LIST_INCLUDE, order: order(req.query), limit, offset });
  return ok(res, paginated(rows, count, page, limit));
};

exports.get = async (req, res) => {
  const ids = await visibleUserIds(req.user);
  const row = await AuditLog.findOne({
    where: { id: req.params.id, ...(ids ? { actor_user_id: { [Op.in]: ids } } : {}) },
    include: LIST_INCLUDE,
  });
  if (!row) throw ApiError.notFound('Activity record not found');
  return ok(res, { log: row });
};

exports.meta = async (req, res) => {
  const ids = await visibleUserIds(req.user);
  const scope = ids ? { actor_user_id: { [Op.in]: ids } } : {};
  const [actions, first, users] = await Promise.all([
    AuditLog.findAll({ where: scope, attributes: [[sequelize.fn('DISTINCT', sequelize.col('action')), 'action']], raw: true }),
    AuditLog.min('created_at'),
    User.findAll({ where: ids ? { id: { [Op.in]: ids } } : {}, attributes: ['id', 'name', 'role'], order: [['name', 'ASC']], raw: true }),
  ]);
  return ok(res, {
    actions: actions.map((a) => a.action).filter(Boolean).sort(),
    users,
    // Nothing before this moment was tracked — the UI states it so no history is implied.
    tracking_started_at: first || null,
    display_timezone: DISPLAY_TZ,
  });
};

exports.exportCsv = async (req, res) => {
  const rows = await AuditLog.findAll({ where: await buildWhere(req), include: LIST_INCLUDE, order: order(req.query), limit: 10000 });
  await audit.record(req, {
    action: 'audit.exported',
    resourceType: 'audit_log',
    metadata: { rows: rows.length, preset: req.query.preset || 'all', from: req.query.from, to: req.query.to },
  });
  const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: DISPLAY_TZ, hour12: false });
  return sendCsv(
    res,
    `activity-log-${Date.now()}.csv`,
    rows.map((r) => ({
      id: r.id,
      time: fmt(r.created_at),
      time_utc: new Date(r.created_at).toISOString(),
      employee: r.actor?.name || r.actor_name || '(anonymous)',
      role: r.actor_role || '',
      action: r.action,
      result: r.result,
      company: r.company?.company_name || '',
      lead_id: r.lead_id ?? '',
      contact_id: r.contact_id ?? '',
      accessed_fields: (r.accessed_fields || []).join('; '),
      details: r.metadata ? JSON.stringify(r.metadata) : '',
      request_id: r.request_id || '',
      ip: r.ip || '',
    }))
  );
};

/* ---------------- Team performance ---------------- */

// Metric definitions — shared by the cards, table and chart so they always agree.
const METRICS = {
  lead_views: ['lead.viewed'],
  contact_reveals: ['contact.phone_revealed', 'contact.email_revealed', 'contact.revealed'],
  contacted: ['lead.contacted'], // only recorded contact attempts — never inferred from views/reveals
  follow_ups: ['lead.follow_up_added'],
  notes: ['lead.note_added'],
  updates: ['lead.updated', 'lead.status_changed', 'lead.contact_status_changed', 'lead.lead_status_changed'],
};
const METRIC_ACTIONS = Object.values(METRICS).flat();

const bucketKey = (date, granularity) => {
  const ist = new Date(new Date(date).toLocaleString('en-US', { timeZone: DISPLAY_TZ }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, '0');
  if (granularity === 'month') return `${y}-${m}`;
  if (granularity === 'week') {
    const monday = new Date(ist);
    monday.setDate(ist.getDate() - ((ist.getDay() + 6) % 7));
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  }
  return `${y}-${m}-${String(ist.getDate()).padStart(2, '0')}`;
};

exports.performance = async (req, res) => {
  const to = parseDate(req.query.to, true) || new Date();
  const from = parseDate(req.query.from, false) || new Date(to.getTime() - 30 * 86400000);
  if (to - from > 366 * 86400000) throw ApiError.badRequest('Date range is limited to one year');
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';

  let ids = await visibleUserIds(req.user);
  if (int(req.query.user_id)) {
    if (ids && !ids.includes(int(req.query.user_id))) throw ApiError.notFound('Employee not found');
    ids = [int(req.query.user_id)];
  }
  const userWhere = ids ? { id: { [Op.in]: ids } } : {};
  const users = await User.findAll({ where: userWhere, attributes: ['id', 'name', 'role', 'is_active', 'last_activity_at', 'last_login_at'], order: [['name', 'ASC']] });
  const userIds = users.map((u) => u.id);
  const range = { [Op.gte]: from, [Op.lt]: to };

  const [assignedNow, assignedInRange, grouped, uniqueViews, wonRows, series] = await Promise.all([
    Lead.findAll({ where: { assigned_user_id: { [Op.in]: userIds } }, attributes: ['assigned_user_id', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['assigned_user_id'], raw: true }),
    LeadAssignment.findAll({ where: { new_user_id: { [Op.in]: userIds }, created_at: range }, attributes: ['new_user_id', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['new_user_id'], raw: true }),
    AuditLog.findAll({
      where: { actor_user_id: { [Op.in]: userIds }, action: { [Op.in]: METRIC_ACTIONS }, created_at: range },
      attributes: ['actor_user_id', 'action', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
      group: ['actor_user_id', 'action'],
      raw: true,
    }),
    AuditLog.findAll({
      where: { actor_user_id: { [Op.in]: userIds }, action: 'lead.viewed', created_at: range },
      attributes: ['actor_user_id', [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('lead_id'))), 'n']],
      group: ['actor_user_id'],
      raw: true,
    }),
    // A "win" is a recorded transition to WON — derived from the audit trail, so it only counts from tracking start.
    AuditLog.findAll({ where: { actor_user_id: { [Op.in]: userIds }, action: { [Op.in]: ['lead.contact_status_changed', 'lead.status_changed'] }, created_at: range }, attributes: ['actor_user_id', 'lead_id', 'metadata'], raw: true }),
    // ponytail: buckets in JS from raw rows (bounded by the 1-year range); move to SQL date_trunc if volume grows.
    AuditLog.findAll({ where: { actor_user_id: { [Op.in]: userIds }, action: { [Op.in]: METRIC_ACTIONS }, created_at: range }, attributes: ['action', 'created_at'], raw: true }),
  ]);

  const parse = (m) => (typeof m === 'string' ? JSON.parse(m || 'null') : m);
  const n = (rows, key, id) => Number(rows.find((r) => r[key] === id)?.n || 0);
  const wonByUser = {};
  for (const r of wonRows) {
    if (parse(r.metadata)?.to !== 'WON') continue;
    (wonByUser[r.actor_user_id] ||= new Set()).add(r.lead_id); // unique leads, so a re-click can't double-count
  }

  const employees = users.map((u) => {
    const row = { user: { id: u.id, name: u.name, role: u.role, is_active: u.is_active }, last_activity_at: u.last_activity_at, last_login_at: u.last_login_at };
    row.leads_assigned = n(assignedNow, 'assigned_user_id', u.id);
    row.assigned_in_period = n(assignedInRange, 'new_user_id', u.id);
    for (const [metric, actions] of Object.entries(METRICS)) {
      row[metric] = grouped.filter((g) => g.actor_user_id === u.id && actions.includes(g.action)).reduce((s, g) => s + Number(g.n), 0);
    }
    row.unique_leads_viewed = n(uniqueViews, 'actor_user_id', u.id);
    row.won = wonByUser[u.id]?.size || 0;
    return row;
  });

  const totals = employees.reduce((t, e) => {
    for (const k of ['leads_assigned', 'assigned_in_period', 'lead_views', 'unique_leads_viewed', 'contact_reveals', 'contacted', 'follow_ups', 'notes', 'updates', 'won']) t[k] = (t[k] || 0) + e[k];
    return t;
  }, {});

  const buckets = {};
  for (const r of series) {
    const k = bucketKey(r.created_at, granularity);
    const b = (buckets[k] ||= { period: k, lead_views: 0, contact_reveals: 0, contacted: 0, follow_ups: 0, notes: 0, updates: 0 });
    const metric = Object.keys(METRICS).find((m) => METRICS[m].includes(r.action));
    b[metric] += 1;
  }

  return ok(res, {
    from,
    to,
    granularity,
    display_timezone: DISPLAY_TZ,
    tracking_started_at: await AuditLog.min('created_at'),
    definitions: {
      leads_assigned: 'Leads currently owned (snapshot, not limited to the date range)',
      assigned_in_period: 'Assignments received in the date range',
      lead_views: 'Times a lead was opened (every open counts)',
      unique_leads_viewed: 'Distinct leads opened',
      contact_reveals: 'Phone/email reveals — viewing a number is not proof of a call',
      contacted: 'Contact attempts the employee recorded with the Contact action',
      follow_ups: 'Follow-up tasks created',
      notes: 'Notes added',
      updates: 'Lead edits and status changes',
      won: 'Distinct leads the employee moved to WON (tracked events only)',
    },
    totals,
    employees,
    series: Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period)),
  });
};

exports.settings = async (req, res) =>
  ok(res, {
    roles: ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r], permissions: MATRIX[r] })),
    permissions: PERMISSIONS,
    audit_retention_days: parseInt(process.env.AUDIT_RETENTION_DAYS || '0', 10) || null,
    contact_reveal_limit_per_hour: parseInt(process.env.CONTACT_REVEAL_LIMIT_PER_HOUR || '120', 10),
    display_timezone: DISPLAY_TZ,
    tracking_started_at: await AuditLog.min('created_at'),
  });
