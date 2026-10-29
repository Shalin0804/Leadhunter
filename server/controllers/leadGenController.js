/**
 * Business-first lead-generation metrics and the duplicate-review queue (Main Admin).
 * Every number is a count over stored records; definitions are returned with the data
 * so the dashboard never has to guess. "Contacted" means a recorded contact status —
 * viewing a lead or revealing a number never counts.
 */
const { Op } = require('sequelize');
const { Company, Lead, User, SearchRun, CompanyContact, DuplicateReview } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const audit = require('../services/auditService');

const POSITIVE = ['REPLIED', 'INTERESTED', 'MEETING_BOOKED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON'];

function range(q) {
  const to = q.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(q.to).getTime() + 86400000 : q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400000);
  return { from, to };
}

const top = (map, n = 10) =>
  Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);

exports.metrics = async (req, res) => {
  const { from, to } = range(req.query);
  // ponytail: aggregates in JS over one lean lead query; move to GROUP BY if leads reach ~50k+.
  const [leads, uniqueBusinesses, verified, runs, openDuplicates, users] = await Promise.all([
    Lead.findAll({
      attributes: ['id', 'company_id', 'source', 'assigned_user_id', 'contact_status', 'lead_status', 'lead_temperature', 'lead_score', 'ever_contacted', 'created_at'],
      include: [{ model: Company, as: 'company', attributes: ['industry', 'city', 'has_website', 'has_phone', 'has_email'] }],
      raw: true,
      nest: true,
    }),
    Company.count(),
    CompanyContact.findAll({ where: { verification_status: 'VERIFIED' }, attributes: ['company_id', 'type'], raw: true }),
    SearchRun.findAll({ where: { started_at: { [Op.gte]: from, [Op.lt]: to } }, order: [['started_at', 'DESC']] }),
    DuplicateReview.count({ where: { status: 'open' } }),
    User.findAll({ attributes: ['id', 'name'], raw: true }),
  ]);

  const leadCompanies = new Set(leads.map((l) => l.company_id));
  const verifiedEmail = new Set(verified.filter((v) => v.type === 'email').map((v) => v.company_id));
  const verifiedPhone = new Set(verified.filter((v) => v.type === 'phone').map((v) => v.company_id));
  const count = (fnc) => leads.filter(fnc).length;
  const byIndustry = {};
  const byCity = {};
  const bySource = {};
  const byEmployee = {};
  for (const l of leads) {
    byIndustry[l.company?.industry || 'Unknown'] = (byIndustry[l.company?.industry || 'Unknown'] || 0) + 1;
    byCity[l.company?.city || 'Unknown'] = (byCity[l.company?.city || 'Unknown'] || 0) + 1;
    bySource[l.source || 'manual'] = (bySource[l.source || 'manual'] || 0) + 1;
    const owner = users.find((u) => u.id === l.assigned_user_id)?.name || 'Unassigned';
    byEmployee[owner] = (byEmployee[owner] || 0) + 1;
  }

  // Provider reliability over the period: runs a provider took part in vs. runs where it errored.
  const providers = {};
  for (const r of runs) {
    const used = r.providers_used || [];
    const errored = new Set((r.errors || []).map((e) => String(e.step || '')).filter((s) => s.startsWith('discovery:')).map((s) => s.slice(10)));
    for (const p of new Set([...used, ...errored])) {
      providers[p] ||= { provider: p, runs: 0, errors: 0 };
      providers[p].runs += 1;
      if (errored.has(p)) providers[p].errors += 1;
    }
  }

  const totals = {
    unique_businesses: uniqueBusinesses,
    leads: leads.length,
    new_leads: count((l) => new Date(l.created_at) >= from && new Date(l.created_at) < to),
    qualified: count((l) => l.lead_status === 'QUALIFIED'),
    high_priority: count((l) => l.lead_temperature === 'HOT'),
    with_website: count((l) => l.company?.has_website),
    no_website: count((l) => l.company && !l.company.has_website),
    with_phone: count((l) => l.company?.has_phone),
    with_email: count((l) => l.company?.has_email),
    verified_email: [...verifiedEmail].filter((id) => leadCompanies.has(id)).length,
    verified_phone: [...verifiedPhone].filter((id) => leadCompanies.has(id)).length,
    assigned: count((l) => l.assigned_user_id),
    contacted: count((l) => l.ever_contacted),
    not_contacted: count((l) => !l.ever_contacted),
    positive_responses: count((l) => POSITIVE.includes(l.contact_status)),
    converted: count((l) => l.contact_status === 'WON'),
    open_duplicate_reviews: openDuplicates,
  };

  return ok(res, {
    from,
    to,
    totals,
    breakdowns: { industry: top(byIndustry), city: top(byCity), source: top(bySource), employee: top(byEmployee, 20) },
    discovery: {
      runs: runs.length,
      failed_runs: runs.filter((r) => r.status === 'failed').length,
      businesses_discovered: runs.reduce((s, r) => s + r.businesses_discovered, 0),
      new_companies: runs.reduce((s, r) => s + r.new_companies, 0),
      duplicates_skipped: runs.reduce((s, r) => s + r.duplicates_skipped, 0),
      qualified_leads: runs.reduce((s, r) => s + r.qualified_leads, 0),
      providers: Object.values(providers).map((p) => ({ ...p, error_rate: p.runs ? Math.round((p.errors / p.runs) * 100) : 0 })),
      recent: runs.slice(0, 8).map((r) => ({ id: r.id, started_at: r.started_at, status: r.status, location: r.locations?.[0], industry: r.industries?.[0], discovered: r.businesses_discovered, new_companies: r.new_companies, errors: (r.errors || []).length })),
    },
    definitions: {
      unique_businesses: 'Company records (each business once, after de-duplication)',
      new_leads: 'Leads created in the date range',
      qualified: 'Leads with qualification status QUALIFIED',
      high_priority: 'Leads scored HOT (80+)',
      verified_email: 'Leads whose email passed the email verifier (not just found)',
      contacted: 'Leads with a recorded contact attempt (ever left NOT_CONTACTED) — views and reveals do not count',
      positive_responses: `Current contact status in ${POSITIVE.join(', ')}`,
      converted: 'Contact status WON',
    },
  });
};

exports.duplicates = async (req, res) => {
  const status = ['open', 'not_duplicate', 'confirmed'].includes(req.query.status) ? req.query.status : 'open';
  const attrs = ['id', 'company_name', 'city', 'state', 'website', 'registered_address', 'source', 'created_at'];
  const rows = await DuplicateReview.findAll({
    where: { status },
    include: [{ model: Company, as: 'company', attributes: attrs }, { model: Company, as: 'candidate', attributes: attrs }],
    order: [['id', 'DESC']],
    limit: 100,
  });
  return ok(res, { items: rows });
};

// An admin decision only — nothing is merged or deleted automatically.
exports.reviewDuplicate = async (req, res) => {
  const row = await DuplicateReview.findByPk(req.params.id);
  if (!row) throw ApiError.notFound('Review not found');
  if (!['not_duplicate', 'confirmed'].includes(req.body.status)) throw ApiError.badRequest('status must be not_duplicate or confirmed');
  await row.update({ status: req.body.status, reviewed_by_user_id: req.user.id, reviewed_at: new Date() });
  await audit.record(req, { action: 'company.duplicate_reviewed', resourceType: 'company', resourceId: row.company_id, companyId: row.company_id, metadata: { candidate_company_id: row.candidate_company_id, decision: row.status, reason: row.reason } });
  return ok(res, { review: row });
};
