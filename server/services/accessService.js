/**
 * Record-level authorization: which leads a user may see, and how contact details
 * are masked for them. Every lead/company/note/task/outreach controller routes
 * through here so the rules live in one place (and so IDOR — swapping an id in a
 * URL — returns 404 instead of someone else's record).
 */
const { Op } = require('sequelize');
const { User, Lead } = require('../models');
const { can } = require('../config/permissions');
const ApiError = require('../utils/ApiError');

/** User ids whose leads/activity `user` may see. null = unrestricted (Main Admin). */
async function visibleUserIds(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'manager') {
    const team = await User.findAll({ where: { manager_id: user.id }, attributes: ['id'], raw: true });
    return [user.id, ...team.map((u) => u.id)];
  }
  return [user.id];
}

/** Sequelize `where` fragment restricting Lead rows to the user's scope. */
async function leadScope(user) {
  const ids = await visibleUserIds(user);
  return ids ? { assigned_user_id: { [Op.in]: ids } } : {};
}

async function canSeeLead(user, lead) {
  const ids = await visibleUserIds(user);
  return !ids || ids.includes(lead.assigned_user_id);
}

/** Load a lead the user is allowed to see, or 404 (never 403 — don't confirm it exists). */
async function loadAccessibleLead(user, id, options) {
  const lead = await Lead.findByPk(id, options);
  if (!lead || !(await canSeeLead(user, lead))) throw ApiError.notFound('Lead not found');
  return lead;
}

/** A company is visible to discovery users, or to anyone who can see one of its leads. */
async function assertCompanyAccess(user, companyId) {
  if (can(user, 'discovery.use')) return;
  const n = await Lead.count({ where: { company_id: companyId, ...(await leadScope(user)) } });
  if (!n) throw ApiError.notFound('Company not found');
}

/** Lead ids the user can see, or null when unrestricted. */
async function accessibleLeadIds(user) {
  const ids = await visibleUserIds(user);
  if (!ids) return null;
  const rows = await Lead.findAll({ where: { assigned_user_id: { [Op.in]: ids } }, attributes: ['id'], raw: true });
  return rows.map((r) => r.id);
}

/* ---------------- Contact masking ---------------- */

function maskValue(type, value) {
  const v = String(value || '');
  if (type === 'email') {
    const [local, domain] = v.split('@');
    return domain ? `${local.slice(0, 1)}•••@${domain}` : '•••••';
  }
  if (type === 'phone') {
    const digits = v.replace(/\D/g, '');
    return digits.length > 2 ? `•••• ••${digits.slice(-2)}` : '••••';
  }
  return '•••••';
}

const plain = (x) => (x && typeof x.get === 'function' ? x.get({ plain: true }) : x);

function maskContact(c) {
  const o = { ...plain(c) };
  return { ...o, value: null, value_masked: maskValue(o.type, o.value), linkedin_url: o.linkedin_url ? '•••••' : null, masked: true };
}

/**
 * Returns a plain copy of a company with contact values withheld unless the user may
 * see them unmasked. Values are then only reachable through the logged reveal endpoint.
 */
// Buying signals can carry a contact's email/phone and the provider's raw payload.
function maskSignals(user, signals) {
  if (!signals || can(user, 'contacts.view_unmasked')) return signals;
  return signals.map((s) => {
    const o = { ...plain(s) };
    return {
      ...o,
      contact_email: o.contact_email ? maskValue('email', o.contact_email) : null,
      contact_phone: o.contact_phone ? maskValue('phone', o.contact_phone) : null,
      raw: null,
    };
  });
}

function maskCompany(user, company) {
  if (!company) return company;
  const o = plain(company);
  if (can(user, 'contacts.view_unmasked')) return o;
  return {
    ...o,
    ...(o.contacts ? { contacts: o.contacts.map(maskContact) } : {}),
    ...(o.signals ? { signals: maskSignals(user, o.signals) } : {}),
    ...(o.normalized_phone ? { normalized_phone: null } : {}),
  };
}

function maskLead(user, lead) {
  if (!lead) return lead;
  const o = plain(lead);
  return o.company ? { ...o, company: maskCompany(user, o.company) } : o;
}

/** Field names (not values) a response exposes — recorded in the audit log. */
function exposedContactFields(user, company) {
  if (!can(user, 'contacts.view_unmasked')) return [];
  const types = new Set((plain(company)?.contacts || []).map((c) => c.type));
  return [...types].sort();
}

module.exports = {
  visibleUserIds,
  leadScope,
  canSeeLead,
  loadAccessibleLead,
  assertCompanyAccess,
  accessibleLeadIds,
  maskValue,
  maskCompany,
  maskLead,
  maskSignals,
  exposedContactFields,
};
