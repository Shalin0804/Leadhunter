const { Outreach, Company, Activity } = require('../models');
const { scoreCompany } = require('../services/leadScoring');
const { generate } = require('../services/outreachGeneratorService');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { SCORING_INCLUDE } = require('../services/companyService');

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = {};
  if (req.query.lead_id) where.lead_id = req.query.lead_id;
  if (req.query.company_id) where.company_id = req.query.company_id;
  const { rows, count } = await Outreach.findAndCountAll({ where, order: [['created_at', 'DESC']], limit, offset });
  return ok(res, paginated(rows, count, page, limit));
};

exports.generate = async (req, res) => {
  const { company_id, lead_id, channel, contact_name } = req.body;
  if (!company_id) throw ApiError.badRequest('company_id is required');
  if (!Outreach.CHANNELS.includes(channel)) throw ApiError.badRequest(`channel must be one of: ${Outreach.CHANNELS.join(', ')}`);

  const company = await Company.findByPk(company_id, { include: SCORING_INCLUDE });
  if (!company) throw ApiError.notFound('Company not found');

  const analysis = scoreCompany(company);
  const draft = generate(channel, { company, analysis, contactName: contact_name });

  const outreach = await Outreach.create({
    lead_id: lead_id || null,
    company_id: company.id,
    created_by_user_id: req.user.id,
    channel,
    subject: draft.subject,
    body: draft.body,
    evidence: draft.evidence,
    generated_by: 'rule_based',
  });

  await Activity.create({
    company_id: company.id,
    lead_id: lead_id || null,
    user_id: req.user.id,
    type: 'outreach_generated',
    title: `${channel.replace(/_/g, ' ')} draft generated`,
    body: draft.subject || draft.body.slice(0, 120),
  });

  return ok(res, { outreach }, 201);
};

exports.remove = async (req, res) => {
  const row = await Outreach.findByPk(req.params.id);
  if (!row) throw ApiError.notFound('Outreach draft not found');
  await row.destroy();
  return ok(res, { message: 'Outreach draft deleted' });
};
