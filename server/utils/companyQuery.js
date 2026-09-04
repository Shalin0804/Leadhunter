const { Op } = require('sequelize');
const { likeOp } = require('./dialect');

const DATE_PRESETS = {
  today: () => startOfDay(new Date()),
  last_7_days: () => daysAgo(7),
  last_30_days: () => daysAgo(30),
  last_90_days: () => daysAgo(90),
};

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function daysAgo(n) {
  return startOfDay(new Date(Date.now() - n * 86400000));
}

/**
 * Build a Sequelize `where` object for the companies table from discovery filters.
 * Accepts query params from /api/discovery/companies and /api/companies.
 */
function buildCompanyWhere(q = {}) {
  const where = {};
  const and = [];

  // Text search across a few columns
  if (q.search && q.search.trim()) {
    const term = `%${q.search.trim()}%`;
    and.push({
      [Op.or]: [
        { company_name: { [likeOp]: term } },
        { cin: { [likeOp]: term } },
        { city: { [likeOp]: term } },
        { state: { [likeOp]: term } },
        { industry: { [likeOp]: term } },
      ],
    });
  }

  if (q.state) where.state = q.state;
  if (q.city) where.city = q.city;
  if (q.industry) where.industry = { [likeOp]: `%${q.industry}%` };
  if (q.company_status) where.company_status = q.company_status;
  if (q.company_type) where.company_type = q.company_type;

  if (q.has_website !== undefined && q.has_website !== '') where.has_website = toBool(q.has_website);
  if (q.has_email !== undefined && q.has_email !== '') where.has_email = toBool(q.has_email);
  if (q.has_phone !== undefined && q.has_phone !== '') where.has_phone = toBool(q.has_phone);

  if (q.lead_temperature) where.lead_temperature = q.lead_temperature;

  const scoreWhere = {};
  if (q.min_score !== undefined && q.min_score !== '') scoreWhere[Op.gte] = Number(q.min_score);
  if (q.max_score !== undefined && q.max_score !== '') scoreWhere[Op.lte] = Number(q.max_score);
  if (Object.getOwnPropertySymbols(scoreWhere).length) where.lead_score = scoreWhere;

  // Registration date filtering
  const dateWhere = {};
  if (q.date_preset && DATE_PRESETS[q.date_preset]) {
    dateWhere[Op.gte] = DATE_PRESETS[q.date_preset]().toISOString().slice(0, 10);
  }
  if (q.date_from) dateWhere[Op.gte] = new Date(q.date_from).toISOString().slice(0, 10);
  if (q.date_to) dateWhere[Op.lte] = new Date(q.date_to).toISOString().slice(0, 10);
  if (Object.getOwnPropertySymbols(dateWhere).length) where.date_of_incorporation = dateWhere;

  if (q.is_demo !== undefined && q.is_demo !== '') where.is_demo = toBool(q.is_demo);

  if (and.length) where[Op.and] = and;
  return where;
}

function toBool(v) {
  return v === true || v === 'true' || v === '1' || v === 1;
}

const SORTABLE = ['company_name', 'date_of_incorporation', 'lead_score', 'state', 'city', 'industry', 'created_at'];

function buildOrder(q = {}) {
  const field = SORTABLE.includes(q.sort) ? q.sort : 'lead_score';
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return [[field, dir], ['id', 'DESC']];
}

/**
 * When the query asks for a signal filter, return the set of company ids that
 * have a matching signal (to AND into the main where). Returns null if no
 * signal filter was requested.
 */
async function signalCompanyIds(q = {}, Signal) {
  if (!Signal) return null;
  const wantsSignal = q.has_signal === 'true' || q.has_signal === '1';
  const service = q.wants_service;
  const source = q.signal_source;
  if (!wantsSignal && !service && !source) return null;

  const where = {};
  if (wantsSignal) where.status = { [Op.in]: ['NEW', 'REVIEWED'] };
  if (service) where.service = service;
  if (source) where.source = source;

  const rows = await Signal.findAll({ where, attributes: ['company_id'], group: ['company_id'], raw: true });
  return rows.map((r) => r.company_id).filter(Boolean);
}

async function applySignalFilter(where, q, Signal) {
  const ids = await signalCompanyIds(q, Signal);
  if (ids === null) return where;
  return { ...where, id: ids.length ? { [Op.in]: ids } : -1 };
}

module.exports = { buildCompanyWhere, buildOrder, signalCompanyIds, applySignalFilter, DATE_PRESETS };
