/**
 * Location-driven business discovery. The geographic database answers "which places
 * exist"; this hands an admin-approved place to the EXISTING discovery engine
 * (discoveryOrchestrator.runForTarget), which queries the configured business
 * providers and runs the usual scoring, dedup, enrichment and SearchRun tracking.
 */
const { Op } = require('sequelize');
const { SearchRun, LeadSource, Lead, Company, CompanyContact, CompanyWebsite, DetectedSignal, Setting, User } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { can } = require('../config/permissions');
const audit = require('../services/auditService');
const { getSettings } = require('../services/automationSettingsService');
const { runForTarget } = require('../services/discoveryOrchestrator');
const { withRunLock, isRunning } = require('../jobs/automationScheduler');
const { getDiscoveryProvider } = require('../providers');
const { resolveUsable } = require('./locationController');
const access = require('../services/accessService');

const CATEGORY_KEY = 'business_categories';
// Initial categories; `keyword` is what providers search for (OSM maps these to tags).
const DEFAULT_CATEGORIES = [
  { key: 'hotels', label: 'Hotels and Resorts', keyword: 'hotels', enabled: true },
  { key: 'restaurants', label: 'Restaurants and Cafes', keyword: 'restaurants', enabled: true },
  { key: 'manufacturers', label: 'Manufacturers', keyword: 'manufacturers', enabled: true },
  { key: 'real_estate', label: 'Real Estate Companies', keyword: 'real estate', enabled: true },
  { key: 'travel', label: 'Travel Agencies', keyword: 'travel agencies', enabled: true },
  { key: 'logistics', label: 'Logistics and Transport', keyword: 'logistics', enabled: true },
  { key: 'clinics', label: 'Clinics and Healthcare', keyword: 'clinics', enabled: true },
  { key: 'wholesale', label: 'Wholesalers and Distributors', keyword: 'wholesale', enabled: true },
  { key: 'professional', label: 'Professional Services', keyword: 'consulting', enabled: true },
  { key: 'education', label: 'Education and Training', keyword: 'education', enabled: true },
  { key: 'it', label: 'IT and Technology', keyword: 'it', enabled: true },
  { key: 'sme', label: 'Other Small and Medium Enterprises', keyword: 'retail', enabled: false },
];

async function getCategories() {
  const row = await Setting.findOne({ where: { key: CATEGORY_KEY } });
  const v = row?.value;
  const list = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(list) && list.length ? list : DEFAULT_CATEGORIES;
}

exports.options = async (req, res) => {
  const settings = await getSettings();
  const keys = settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider];
  const providers = keys.map((key) => {
    try {
      const p = getDiscoveryProvider(key);
      return { key, label: p.label, status: p.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED' };
    } catch {
      return { key, label: key, status: 'UNKNOWN' };
    }
  });
  const categories = await getCategories();
  return ok(res, { categories: can(req.user, 'settings.manage') ? categories : categories.filter((c) => c.enabled), providers, running: isRunning() });
};

exports.updateCategories = async (req, res) => {
  const list = req.body.categories;
  if (!Array.isArray(list) || !list.length || list.length > 60) throw ApiError.badRequest('categories must be a non-empty array (max 60)');
  const clean = list.map((c, i) => {
    const label = String(c.label || '').trim().slice(0, 80);
    const keyword = String(c.keyword || label).trim().toLowerCase().slice(0, 60);
    if (!label || !keyword) throw ApiError.badRequest(`Category #${i + 1} needs a label`);
    return { key: String(c.key || keyword).replace(/\W+/g, '_').slice(0, 40), label, keyword, enabled: c.enabled !== false };
  });
  const [row] = await Setting.findOrCreate({ where: { key: CATEGORY_KEY }, defaults: { key: CATEGORY_KEY, value: clean } });
  await row.update({ value: clean });
  await audit.record(req, { action: 'discovery.categories_changed', resourceType: 'setting', resourceId: CATEGORY_KEY, metadata: { enabled: clean.filter((c) => c.enabled).map((c) => c.key).join(',') } });
  return ok(res, { categories: clean });
};

// POST /lead-discovery/run { location_id, categories: [key] }
exports.run = async (req, res) => {
  const { label, loc, chain } = await resolveUsable(req.body.location_id);
  const enabled = (await getCategories()).filter((c) => c.enabled);
  const picked = [...new Set(req.body.categories || [])].map((k) => enabled.find((c) => c.key === k)).filter(Boolean);
  if (!picked.length || picked.length > 5) throw ApiError.badRequest('Choose 1-5 enabled business categories');
  if (isRunning()) throw ApiError.conflict('Another discovery run is in progress — try again when it finishes');

  const settings = await getSettings();
  // Main Admin runs behave like automation (unassigned leads); anyone else owns what their run finds,
  // otherwise their own scope would hide the leads they just discovered.
  const assignToUserId = can(req.user, 'leads.view') && (await access.visibleUserIds(req.user)) ? req.user.id : undefined;

  await audit.record(req, {
    action: 'discovery.location_selected',
    resourceType: 'location',
    resourceId: loc.id,
    metadata: { location: label, path: chain.map((l) => l.id).join('>'), categories: picked.map((c) => c.key).join(',') },
  });

  const startedAt = new Date();
  withRunLock('manual', async () => {
    const runs = [];
    for (const cat of picked) {
      // eslint-disable-next-line no-await-in-loop
      const run = await runForTarget({
        location: label,
        industry: cat.keyword,
        providerKey: settings.provider,
        discoveryProviders: settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider],
        minLeadScore: settings.minLeadScore,
        dailyLimit: settings.dailyLeadLimit,
        triggeredBy: 'manual',
        triggeredByUserId: req.user.id,
        settings,
        assignToUserId,
      });
      runs.push(run);
      // eslint-disable-next-line no-await-in-loop
      await audit.record(req, {
        action: 'discovery.completed',
        resourceType: 'search_run',
        resourceId: run.id,
        result: run.status === 'failed' ? 'failure' : 'success',
        metadata: { location_id: loc.id, location: label, category: cat.key, status: run.status, discovered: run.businesses_discovered, new_companies: run.new_companies, duplicates: run.duplicates_skipped, qualified: run.qualified_leads },
      }).catch(() => {});
    }
    return { runs };
  }).catch((e) => console.error('[lead-discovery] run failed:', e.message));

  await audit.record(req, { action: 'discovery.started', resourceType: 'location', resourceId: loc.id, metadata: { location: label, categories: picked.map((c) => c.key).join(',') } });
  return ok(res, { message: 'Discovery started', location: label, categories: picked, started_at: startedAt }, 202);
};

// Runs started by this user (Main Admin: everyone's), newest first.
exports.runs = async (req, res) => {
  const where = can(req.user, 'discovery.use') ? {} : { triggered_by_user_id: req.user.id };
  if (req.query.since) where.started_at = { [Op.gte]: new Date(req.query.since) };
  const runs = await SearchRun.findAll({ where, order: [['started_at', 'DESC']], limit: Math.min(Number(req.query.limit) || 20, 100) });
  const users = await User.findAll({ where: { id: [...new Set(runs.map((r) => r.triggered_by_user_id).filter(Boolean))] }, attributes: ['id', 'name'], raw: true });
  return ok(res, { runs: runs.map((r) => ({ ...r.get(), triggered_by_name: users.find((u) => u.id === r.triggered_by_user_id)?.name || null })), running: isRunning() });
};

// Leads found by one run, with result filters (website / phone / email). Scoped like any lead list.
exports.runLeads = async (req, res) => {
  const run = await SearchRun.findByPk(req.params.id);
  if (!run || (!can(req.user, 'discovery.use') && run.triggered_by_user_id !== req.user.id)) throw ApiError.notFound('Search run not found');
  const sources = await LeadSource.findAll({ where: { search_run_id: run.id }, attributes: ['company_id'], raw: true });
  const companyWhere = { id: { [Op.in]: [...new Set(sources.map((s) => s.company_id))] } };
  if (req.query.website === 'yes') companyWhere.has_website = true;
  if (req.query.website === 'no') companyWhere.has_website = false;
  if (req.query.contact === 'phone') companyWhere.has_phone = true;
  if (req.query.contact === 'email') companyWhere.has_email = true;
  const leads = await Lead.findAll({
    where: await access.leadScope(req.user),
    include: [{ model: Company, as: 'company', where: companyWhere, attributes: ['id', 'company_name', 'industry', 'city', 'state', 'website', 'has_website', 'has_phone', 'has_email'], include: [{ model: CompanyContact, as: 'contacts' }, { model: CompanyWebsite, as: 'websites', attributes: ['id', 'url', 'status', 'health', 'opportunity_score', 'is_https'] }, { model: DetectedSignal, as: 'detectedSignals', attributes: ['id', 'signal_type', 'signal_strength', 'signal_description'] }] }],
    order: [['lead_score', 'DESC']],
    limit: 200,
  });
  return ok(res, { run, leads: leads.map((l) => access.maskLead(req.user, l)) });
};

exports.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
