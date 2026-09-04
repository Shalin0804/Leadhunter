const { fn, col, literal, Op } = require('sequelize');
const { Company } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const { buildCompanyWhere, buildOrder } = require('../utils/companyQuery');

exports.companies = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = buildCompanyWhere(req.query);
  const order = buildOrder(req.query);
  const { rows, count } = await Company.findAndCountAll({ where, order, limit, offset });
  return ok(res, paginated(rows, count, page, limit));
};

exports.stats = async (req, res) => {
  const where = buildCompanyWhere(req.query);

  const total = await Company.count({ where });

  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const newCompanies = await Company.count({
    where: { ...where, date_of_incorporation: { [Op.gte]: since } },
  });

  const byIndustry = await Company.findAll({
    where,
    attributes: ['industry', [fn('COUNT', col('id')), 'count']],
    group: ['industry'],
    order: [[literal('count'), 'DESC']],
    limit: 12,
    raw: true,
  });

  const byState = await Company.findAll({
    where,
    attributes: ['state', [fn('COUNT', col('id')), 'count']],
    group: ['state'],
    order: [[literal('count'), 'DESC']],
    limit: 15,
    raw: true,
  });

  const byTemperature = await Company.findAll({
    where,
    attributes: ['lead_temperature', [fn('COUNT', col('id')), 'count']],
    group: ['lead_temperature'],
    raw: true,
  });

  const byDay = await Company.findAll({
    where: { ...where, date_of_incorporation: { [Op.gte]: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10) } },
    attributes: [[fn('DATE', col('date_of_incorporation')), 'day'], [fn('COUNT', col('id')), 'count']],
    group: [literal('day')],
    order: [[literal('day'), 'ASC']],
    raw: true,
  });

  return ok(res, {
    total,
    newCompanies,
    byIndustry,
    byState,
    byTemperature,
    byDay,
  });
};
