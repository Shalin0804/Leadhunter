/**
 * Contacts page — the existing company_contacts records (no separate contact store).
 * Same rules as leads: employees only see contacts of companies whose lead they can
 * see, and values stay masked (revealed per field through the audited lead endpoint).
 */
const { Op } = require('sequelize');
const { CompanyContact, Company, Lead, User } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const { can } = require('../config/permissions');
const access = require('../services/accessService');

// What we can honestly say about a contact value.
const contactState = (c) =>
  c.verification_status === 'VERIFIED' ? 'verified' : c.verification_status === 'INVALID' ? 'invalid' : 'found_unverified';

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const q = req.query;
  const where = {};
  const and = [];
  if (['email', 'phone', 'linkedin'].includes(q.type)) where.type = q.type;
  if (q.verification === 'verified') where.verification_status = 'VERIFIED';
  if (q.verification === 'unverified') and.push({ [Op.or]: [{ verification_status: null }, { verification_status: { [Op.in]: ['VALID', 'RISKY', 'UNKNOWN'] } }] });
  if (q.verification === 'invalid') where.verification_status = 'INVALID';
  if (q.named === 'true') where.contact_name = { [Op.ne]: null };
  if (q.company_id) where.company_id = Number(q.company_id);

  // Record-level scope: companies of leads the user may see (Main Admin: everything).
  const leadScope = await access.leadScope(req.user);
  const scoped = Object.getOwnPropertySymbols(leadScope).length || Object.keys(leadScope).length;
  if (scoped || q.lead_id || q.has_lead) {
    const leadWhere = { ...leadScope, ...(q.lead_id ? { id: Number(q.lead_id) } : {}) };
    const companyIds = (await Lead.findAll({ where: leadWhere, attributes: ['company_id'], raw: true })).map((l) => l.company_id);
    and.push({ company_id: { [Op.in]: companyIds } });
  }

  if (q.search) {
    const term = `%${String(q.search).slice(0, 100)}%`;
    // Searching inside contact values would let a masked role probe for numbers/emails.
    const valueSearch = can(req.user, 'contacts.view_unmasked') ? [{ value: { [likeOp]: term } }] : [];
    and.push({ [Op.or]: [{ contact_name: { [likeOp]: term } }, { job_title: { [likeOp]: term } }, { '$company.company_name$': { [likeOp]: term } }, ...valueSearch] });
  }
  if (and.length) where[Op.and] = and;

  const { rows, count } = await CompanyContact.findAndCountAll({
    where,
    include: [
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'company_name', 'city', 'state', 'industry', 'enrichment_status', 'enriched_at'],
        include: [{ model: Lead, as: 'leads', attributes: ['id', 'status', 'contact_status', 'assigned_user_id'], include: [{ model: User, as: 'assignedUser', attributes: ['id', 'name'] }] }],
      },
    ],
    order: q.sort === 'company' ? [[{ model: Company, as: 'company' }, 'company_name', 'ASC'], ['id', 'DESC']] : [['updated_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  });

  const masked = rows.map((c) => {
    const company = access.maskCompany(req.user, { ...c.company.get({ plain: true }), contacts: [c.get({ plain: true })] });
    const contact = company.contacts[0];
    delete contact.company;
    return { ...contact, state: contactState(c), company: { ...company, contacts: undefined }, lead_id: c.company.leads?.[0]?.id || null };
  });
  return ok(res, paginated(masked, count, page, limit));
};
