const { Op, fn, col } = require('sequelize');
const { Signal, Company, Lead, User } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { createSignal, convertSignal } = require('../services/signalService');
const { sendCsv } = require('../utils/csv');

const include = [
  { model: Company, as: 'company', attributes: ['id', 'company_name', 'industry', 'state', 'city', 'lead_score', 'lead_temperature'] },
  { model: Lead, as: 'lead', attributes: ['id', 'status'] },
  { model: User, as: 'createdBy', attributes: ['id', 'name'] },
];

function buildWhere(q) {
  const where = {};
  if (q.service) where.service = q.service.includes(',') ? { [Op.in]: q.service.split(',') } : q.service;
  if (q.source) where.source = q.source;
  if (q.status) where.status = q.status;
  if (q.company_id) where.company_id = q.company_id;
  if (q.lead_id) where.lead_id = q.lead_id;
  if (q.confidence) where.confidence = q.confidence;

  const captured = {};
  if (q.date_from) captured[Op.gte] = new Date(q.date_from);
  if (q.date_to) captured[Op.lte] = new Date(q.date_to);
  if (Object.getOwnPropertySymbols(captured).length) where.captured_at = captured;

  if (q.search) {
    where[Op.or] = [
      { headline: { [Op.like]: `%${q.search}%` } },
      { detail: { [Op.like]: `%${q.search}%` } },
      { contact_name: { [Op.like]: `%${q.search}%` } },
      { company_name_raw: { [Op.like]: `%${q.search}%` } },
    ];
  }
  return where;
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, count } = await Signal.findAndCountAll({
    where: buildWhere(req.query),
    include,
    order: [['captured_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};

exports.meta = async (req, res) =>
  ok(res, { services: Signal.SERVICES, sources: Signal.SOURCES, statuses: Signal.STATUSES });

exports.stats = async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [total, newThisWeek, active, byService, bySource, converted] = await Promise.all([
    Signal.count(),
    Signal.count({ where: { captured_at: { [Op.gte]: weekAgo } } }),
    Signal.count({ where: { status: { [Op.in]: ['NEW', 'REVIEWED'] } } }),
    Signal.findAll({ attributes: ['service', [fn('COUNT', col('id')), 'count']], group: ['service'], raw: true }),
    Signal.findAll({ attributes: ['source', [fn('COUNT', col('id')), 'count']], group: ['source'], raw: true }),
    Signal.count({ where: { status: 'CONVERTED' } }),
  ]);

  return ok(res, {
    total,
    newThisWeek,
    active,
    converted,
    byService: byService.map((r) => ({ ...r, count: Number(r.count) })).sort((a, b) => b.count - a.count),
    bySource: bySource.map((r) => ({ ...r, count: Number(r.count) })).sort((a, b) => b.count - a.count),
  });
};

exports.get = async (req, res) => {
  const signal = await Signal.findByPk(req.params.id, { include });
  if (!signal) throw ApiError.notFound('Signal not found');
  return ok(res, { signal });
};

exports.create = async (req, res) => {
  const b = req.body;
  if (!b.company_name && !b.website && !b.contact_email) {
    throw ApiError.badRequest('Provide a company name, website or contact email');
  }
  const result = await createSignal(b, { userId: req.user.id });
  const full = await Signal.findByPk(result.signal.id, { include });
  return ok(res, { signal: full, company: result.company, companyCreated: result.companyCreated }, 201);
};

exports.update = async (req, res) => {
  const signal = await Signal.findByPk(req.params.id);
  if (!signal) throw ApiError.notFound('Signal not found');
  const fields = ['service', 'source', 'source_url', 'headline', 'detail', 'contact_name', 'contact_email', 'contact_phone', 'confidence', 'status', 'captured_at'];
  for (const f of fields) if (req.body[f] !== undefined) signal[f] = req.body[f] === '' ? null : req.body[f];
  await signal.save();
  const full = await Signal.findByPk(signal.id, { include });
  return ok(res, { signal: full });
};

exports.convert = async (req, res) => {
  const result = await convertSignal(req.params.id, {
    userId: req.user.id,
    assignedUserId: req.body.assigned_user_id,
    priority: req.body.priority,
  });
  if (!result) throw ApiError.notFound('Signal not found');
  return ok(res, { lead: result.lead, created: result.created });
};

exports.remove = async (req, res) => {
  const signal = await Signal.findByPk(req.params.id);
  if (!signal) throw ApiError.notFound('Signal not found');
  await signal.destroy();
  return ok(res, { message: 'Signal deleted' });
};

exports.exportCsv = async (req, res) => {
  const rows = await Signal.findAll({ where: buildWhere(req.query), include, order: [['captured_at', 'DESC']], limit: 5000 });
  const flat = rows.map((s) => ({
    id: s.id,
    company: s.company?.company_name || s.company_name_raw || '',
    service: s.service,
    source: s.source,
    status: s.status,
    confidence: s.confidence,
    headline: s.headline || '',
    contact_name: s.contact_name || '',
    contact_email: s.contact_email || '',
    contact_phone: s.contact_phone || '',
    source_url: s.source_url || '',
    captured_at: s.captured_at ? s.captured_at.toISOString() : '',
    lead_id: s.lead_id || '',
  }));
  return sendCsv(res, `signals-${Date.now()}.csv`, flat);
};
