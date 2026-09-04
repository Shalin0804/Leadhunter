const { Op } = require('sequelize');
const {
  Company,
  CompanyContact,
  CompanyWebsite,
  CompanySocial,
  Lead,
  LeadScore,
  Activity,
  Note,
  Task,
  User,
  Signal,
} = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { buildCompanyWhere, buildOrder, applySignalFilter } = require('../utils/companyQuery');
const { rescoreCompany, PRESENCE_INCLUDE } = require('../services/companyService');
const { scoreCompany } = require('../services/leadScoring');
const { sendCsv } = require('../utils/csv');

const EXPORT_COLUMNS = [
  'id', 'company_name', 'cin', 'registration_number', 'date_of_incorporation',
  'company_status', 'company_type', 'industry', 'roc', 'state', 'city',
  'registered_address', 'authorized_capital', 'paid_up_capital', 'website',
  'has_website', 'has_email', 'has_phone', 'lead_score', 'lead_temperature', 'recommended_service',
];

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = await applySignalFilter(buildCompanyWhere(req.query), req.query, Signal);
  const order = buildOrder(req.query);

  const { rows, count } = await Company.findAndCountAll({ where, order, limit, offset });
  return ok(res, paginated(rows, count, page, limit));
};

exports.exportCsv = async (req, res) => {
  const where = await applySignalFilter(buildCompanyWhere(req.query), req.query, Signal);
  const order = buildOrder(req.query);
  const rows = await Company.findAll({ where, order, limit: 5000 });
  const plain = rows.map((r) => {
    const o = r.get({ plain: true });
    return EXPORT_COLUMNS.reduce((acc, c) => ((acc[c] = o[c] ?? ''), acc), {});
  });
  return sendCsv(res, `companies-${Date.now()}.csv`, plain, EXPORT_COLUMNS);
};

exports.get = async (req, res) => {
  const company = await Company.findByPk(req.params.id, {
    include: [
      { model: CompanyContact, as: 'contacts' },
      { model: CompanyWebsite, as: 'websites' },
      { model: CompanySocial, as: 'socials' },
      { model: Signal, as: 'signals', separate: true, order: [['captured_at', 'DESC']] },
      {
        model: Lead,
        as: 'leads',
        include: [{ model: User, as: 'assignedUser', attributes: ['id', 'name', 'email'] }],
      },
      { model: LeadScore, as: 'scoreHistory', separate: true, order: [['created_at', 'DESC']], limit: 10 },
    ],
  });
  if (!company) throw ApiError.notFound('Company not found');

  const analysis = scoreCompany(company);

  const activities = await Activity.findAll({
    where: {
      [Op.or]: [
        { company_id: company.id },
        { lead_id: { [Op.in]: company.leads.map((l) => l.id) } },
      ],
    },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['occurred_at', 'DESC']],
    limit: 100,
  });

  const notes = await Note.findAll({
    where: {
      [Op.or]: [
        { company_id: company.id },
        { lead_id: { [Op.in]: company.leads.map((l) => l.id) } },
      ],
    },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
  });

  return ok(res, { company, analysis, activities, notes });
};

exports.create = async (req, res) => {
  const b = req.body;
  if (b.cin) {
    const existing = await Company.findOne({ where: { cin: String(b.cin).toUpperCase() } });
    if (existing) throw ApiError.conflict('A company with this CIN already exists');
  }
  const company = await Company.create({
    company_name: b.company_name,
    cin: b.cin ? String(b.cin).toUpperCase() : null,
    registration_number: b.registration_number,
    date_of_incorporation: b.date_of_incorporation || null,
    company_status: b.company_status || 'Active',
    company_type: b.company_type,
    company_category: b.company_category,
    industry: b.industry,
    roc: b.roc,
    state: b.state,
    city: b.city,
    registered_address: b.registered_address,
    authorized_capital: b.authorized_capital || null,
    paid_up_capital: b.paid_up_capital || null,
    website: b.website,
    source: 'manual',
  });

  if (b.email) await CompanyContact.create({ company_id: company.id, type: 'email', value: b.email, is_primary: true });
  if (b.phone) await CompanyContact.create({ company_id: company.id, type: 'phone', value: b.phone, is_primary: true });
  if (b.website)
    await CompanyWebsite.create({ company_id: company.id, url: b.website, is_https: /^https:/i.test(b.website) });

  company.has_email = !!b.email;
  company.has_phone = !!b.phone;
  company.has_website = !!b.website;
  await company.save();

  await rescoreCompany(company.id);
  await Activity.create({ company_id: company.id, user_id: req.user.id, type: 'system', title: 'Company created' });

  const fresh = await Company.findByPk(company.id, { include: PRESENCE_INCLUDE });
  return ok(res, { company: fresh }, 201);
};

exports.update = async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) throw ApiError.notFound('Company not found');

  const fields = [
    'company_name', 'cin', 'registration_number', 'date_of_incorporation', 'company_status',
    'company_type', 'company_category', 'industry', 'roc', 'state', 'city',
    'registered_address', 'authorized_capital', 'paid_up_capital', 'website',
  ];
  for (const f of fields) if (req.body[f] !== undefined) company[f] = req.body[f];
  if (company.cin) company.cin = String(company.cin).toUpperCase();
  await company.save();

  await rescoreCompany(company.id);
  const fresh = await Company.findByPk(company.id, { include: PRESENCE_INCLUDE });
  return ok(res, { company: fresh });
};

exports.remove = async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) throw ApiError.notFound('Company not found');
  await company.destroy();
  return ok(res, { message: 'Company deleted' });
};

exports.rescore = async (req, res) => {
  const result = await rescoreCompany(req.params.id);
  if (!result) throw ApiError.notFound('Company not found');
  return ok(res, { company: result.company, analysis: result.result });
};

// --- Sub-resources ---

exports.addContact = async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) throw ApiError.notFound('Company not found');
  const contact = await CompanyContact.create({
    company_id: company.id,
    type: req.body.type,
    value: req.body.value,
    label: req.body.label,
    is_public_business: req.body.is_public_business !== false,
  });
  company[req.body.type === 'email' ? 'has_email' : 'has_phone'] = true;
  await company.save();
  await rescoreCompany(company.id);
  return ok(res, { contact }, 201);
};

exports.addSocial = async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) throw ApiError.notFound('Company not found');
  const social = await CompanySocial.create({
    company_id: company.id,
    platform: req.body.platform,
    url: req.body.url,
  });
  await rescoreCompany(company.id);
  return ok(res, { social }, 201);
};

exports.EXPORT_COLUMNS = EXPORT_COLUMNS;
