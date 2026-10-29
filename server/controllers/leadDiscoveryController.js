/**
 * Location-driven business discovery. The geographic database answers "which places
 * exist"; this hands an admin-approved place to the EXISTING discovery engine
 * (discoveryOrchestrator.runForTarget), which queries the configured business
 * providers and runs the usual scoring, dedup, enrichment and SearchRun tracking.
 */
const { Op } = require('sequelize');
const { SearchRun, LeadSource, Lead, Company, CompanyContact, CompanyWebsite, DetectedSignal, User, BusinessCategory, Location } = require('../models');
const { ok } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');
const { can } = require('../config/permissions');
const audit = require('../services/auditService');
const { getSettings } = require('../services/automationSettingsService');
const { runForTarget } = require('../services/discoveryOrchestrator');
const { withRunLock, isRunning } = require('../jobs/automationScheduler');
const { getDiscoveryProvider } = require('../providers');
const { ensureSeeded } = require('../services/categoryService');
const geoSearch = require('../services/geoSearch');
const { resolveUsable } = require('./locationController');
const access = require('../services/accessService');

const OPPORTUNITY_TYPES = ['WEBSITE', 'BOOKING_SYSTEM', 'APPOINTMENT_SYSTEM', 'CRM', 'ECOMMERCE', 'CUSTOM_SOFTWARE', 'ADMIN_DASHBOARD', 'MOBILE_APP'];

function providerStatus(settings) {
  const keys = settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider];
  return keys.map((key) => {
    try {
      const p = getDiscoveryProvider(key);
      return { key, label: p.label, status: p.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED', radius: geoSearch.PROVIDER_RADIUS[key]?.mode || 'none' };
    } catch {
      return { key, label: key, status: 'UNKNOWN', radius: 'none' };
    }
  });
}

exports.options = async (req, res) => {
  await ensureSeeded();
  const categories = await BusinessCategory.findAll({ where: { is_enabled: true }, order: [['priority', 'DESC'], ['name', 'ASC']] });
  return ok(res, { categories, providers: providerStatus(await getSettings()), running: isRunning(), max_radius_km: geoSearch.MAX_RADIUS_KM });
};

/* ---------------- Business categories (Main Admin) ---------------- */

exports.listCategories = async (req, res) => {
  await ensureSeeded();
  const where = {};
  if (req.query.status === 'enabled') where.is_enabled = true;
  if (req.query.status === 'disabled') where.is_enabled = false;
  if (req.query.parent_id) where.parent_id = Number(req.query.parent_id);
  if (req.query.search) where[Op.or] = [{ name: { [likeOp]: `%${req.query.search}%` } }, { keyword: { [likeOp]: `%${req.query.search}%` } }];
  const sort = ['name', 'priority', 'updated_at', 'created_at'].includes(req.query.sort) ? req.query.sort : 'priority';
  const dir = req.query.dir === 'asc' || (!req.query.dir && sort === 'name') ? 'ASC' : 'DESC';
  const categories = await BusinessCategory.findAll({ where, include: [{ model: BusinessCategory, as: 'parent', attributes: ['id', 'name'] }], order: [[sort, dir], ['name', 'ASC']] });
  return ok(res, { categories, opportunity_types: OPPORTUNITY_TYPES });
};

function categoryFields(body, existing) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim().slice(0, 80);
  if (body.description !== undefined) out.description = body.description ? String(body.description).trim().slice(0, 500) : null;
  if (body.keyword !== undefined) out.keyword = String(body.keyword).trim().toLowerCase().slice(0, 60);
  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 1 || p > 5) throw ApiError.badRequest('priority must be 1-5');
    out.priority = p;
  }
  if (body.is_enabled !== undefined) out.is_enabled = Boolean(body.is_enabled);
  if (body.opportunity_types !== undefined) {
    const list = [...new Set(body.opportunity_types || [])];
    const bad = list.filter((t) => !OPPORTUNITY_TYPES.includes(t));
    if (bad.length) throw ApiError.badRequest(`Unknown opportunity type: ${bad.join(', ')}`);
    out.opportunity_types = list;
  }
  if (body.parent_id !== undefined) out.parent_id = body.parent_id ? Number(body.parent_id) : null;
  if (existing && out.parent_id === existing.id) throw ApiError.badRequest('A category cannot be its own parent');
  return out;
}

exports.createCategory = async (req, res) => {
  await ensureSeeded();
  const f = categoryFields(req.body);
  if (!f.name) throw ApiError.badRequest('name is required');
  f.keyword = f.keyword || f.name.toLowerCase();
  const key = String(req.body.key || f.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (await BusinessCategory.findOne({ where: { key } })) throw ApiError.conflict('A category with this key already exists');
  if (f.parent_id && !(await BusinessCategory.findByPk(f.parent_id))) throw ApiError.badRequest('parent_id not found');
  const cat = await BusinessCategory.create({ ...f, key, created_by_user_id: req.user.id, updated_by_user_id: req.user.id });
  await audit.record(req, { action: 'category.created', resourceType: 'business_category', resourceId: cat.id, metadata: { key, name: cat.name } });
  return ok(res, { category: cat }, 201);
};

exports.updateCategory = async (req, res) => {
  const cat = await BusinessCategory.findByPk(req.params.id);
  if (!cat) throw ApiError.notFound('Category not found');
  const f = categoryFields(req.body, cat);
  if (f.parent_id && !(await BusinessCategory.findByPk(f.parent_id))) throw ApiError.badRequest('parent_id not found');
  const changed = Object.keys(f).filter((k) => JSON.stringify(cat[k]) !== JSON.stringify(f[k]));
  if (!changed.length) return ok(res, { category: cat });
  await cat.update({ ...f, updated_by_user_id: req.user.id });
  const toggled = changed.includes('is_enabled');
  await audit.record(req, {
    action: toggled && changed.length === 1 ? (cat.is_enabled ? 'category.enabled' : 'category.disabled') : 'category.updated',
    resourceType: 'business_category',
    resourceId: cat.id,
    metadata: { key: cat.key, fields: changed.join(',') },
  });
  return ok(res, { category: cat });
};

/* ---------------- Running discovery ---------------- */

/** Validated, structured target for one location (shared with scheduled discovery jobs). */
async function buildTarget(locationId, { radiusKm, maxResults, minScore, filters } = {}) {
  const { loc, chain, label } = await resolveUsable(locationId);
  const radius = radiusKm !== undefined && radiusKm !== null && radiusKm !== '' ? radiusKm : loc.search_radius_km;
  let geo = null;
  try {
    geo = geoSearch.normalizeGeo({ latitude: loc.latitude, longitude: loc.longitude, radiusKm: radius, locationId: loc.id, countryCode: loc.country_code });
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }
  const max = maxResults ? Number(maxResults) : null;
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 50)) throw ApiError.badRequest('max_results must be 1-50');
  const min = minScore !== undefined && minScore !== null && minScore !== '' ? Number(minScore) : null;
  if (min !== null && (!Number.isInteger(min) || min < 0 || min > 100)) throw ApiError.badRequest('min_score must be 0-100');
  return {
    loc,
    chain,
    label,
    minScore: min,
    target: {
      locationId: loc.id,
      countryCode: loc.country_code,
      latitude: loc.latitude == null ? null : Number(loc.latitude),
      longitude: loc.longitude == null ? null : Number(loc.longitude),
      geo,
      maxResults: max,
      filters: filters || undefined,
    },
  };
}

async function resolveCategories(body) {
  await ensureSeeded();
  const ids = (body.category_ids || []).map(Number).filter(Number.isInteger);
  const keys = body.categories || []; // legacy: keys
  const cats = await BusinessCategory.findAll({ where: { is_enabled: true, [Op.or]: [{ id: { [Op.in]: ids } }, { key: { [Op.in]: keys } }] } });
  if (!cats.length || cats.length > 5) throw ApiError.badRequest('Choose 1-5 enabled business categories');
  return cats;
}

// POST /lead-discovery/run { location_id, category_ids:[], radius_km?, max_results?, min_score?, filters? }
exports.run = async (req, res) => {
  const filters = {};
  if (['yes', 'no'].includes(req.body.website)) filters.website = req.body.website;
  if (['phone', 'email'].includes(req.body.contact)) filters.contact = req.body.contact;
  const { loc, chain, label, target, minScore } = await buildTarget(req.body.location_id, { radiusKm: req.body.radius_km, maxResults: req.body.max_results, minScore: req.body.min_score, filters });
  const picked = await resolveCategories(req.body);
  if (isRunning()) throw ApiError.conflict('Another discovery run is in progress — try again when it finishes');

  const settings = await getSettings();
  // Main Admin runs behave like automation (unassigned leads); anyone else owns what their run finds,
  // otherwise their own scope would hide the leads they just discovered.
  const assignToUserId = (await access.visibleUserIds(req.user)) ? req.user.id : undefined;

  await audit.record(req, {
    action: 'discovery.location_selected',
    resourceType: 'location',
    resourceId: loc.id,
    metadata: { location: label, path: chain.map((l) => l.id).join('>'), categories: picked.map((c) => c.key).join(','), radius_km: target.geo?.radiusKm ?? null },
  });

  withRunLock('manual', async () => {
    const runs = [];
    for (const cat of picked) {
      // eslint-disable-next-line no-await-in-loop
      const run = await runForTarget({
        location: label,
        industry: cat.keyword,
        providerKey: settings.provider,
        discoveryProviders: settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider],
        minLeadScore: minScore ?? settings.minLeadScore,
        dailyLimit: settings.dailyLeadLimit,
        triggeredBy: 'manual',
        triggeredByUserId: req.user.id,
        settings,
        assignToUserId,
        target: { ...target, categoryId: cat.id },
      });
      runs.push(run);
      // eslint-disable-next-line no-await-in-loop
      await audit.record(req, {
        action: 'discovery.completed',
        resourceType: 'search_run',
        resourceId: run.id,
        result: run.status === 'failed' ? 'failure' : 'success',
        metadata: { location_id: loc.id, category: cat.key, status: run.status, discovered: run.businesses_discovered, new_companies: run.new_companies, duplicates: run.duplicates_skipped, qualified: run.qualified_leads },
      }).catch(() => {});
    }
    return { runs };
  }).catch((e) => console.error('[lead-discovery] run failed:', e.message));

  await audit.record(req, { action: 'discovery.started', resourceType: 'location', resourceId: loc.id, metadata: { location: label, categories: picked.map((c) => c.key).join(',') } });
  return ok(res, { message: 'Discovery started', location: label, categories: picked, radius_km: target.geo?.radiusKm ?? null }, 202);
};

const RUN_INCLUDE = [
  { model: Location, as: 'location', attributes: ['id', 'name', 'location_type', 'country_code'] },
  { model: BusinessCategory, as: 'category', attributes: ['id', 'name', 'key'] },
];

// Runs started by this user (Main Admin: everyone's), newest first.
exports.runs = async (req, res) => {
  const where = can(req.user, 'discovery.use') ? {} : { triggered_by_user_id: req.user.id };
  if (req.query.since) where.started_at = { [Op.gte]: new Date(req.query.since) };
  const runs = await SearchRun.findAll({ where, include: RUN_INCLUDE, order: [['started_at', 'DESC']], limit: Math.min(Number(req.query.limit) || 20, 100) });
  const users = await User.findAll({ where: { id: [...new Set(runs.map((r) => r.triggered_by_user_id).filter(Boolean))] }, attributes: ['id', 'name'], raw: true });
  return ok(res, { runs: runs.map((r) => ({ ...r.get({ plain: true }), triggered_by_name: users.find((u) => u.id === r.triggered_by_user_id)?.name || null })), running: isRunning() });
};

// Leads found by one run, with result filters (website / phone / email). Scoped like any lead list.
exports.runLeads = async (req, res) => {
  const run = await SearchRun.findByPk(req.params.id, { include: RUN_INCLUDE });
  if (!run || (!can(req.user, 'discovery.use') && run.triggered_by_user_id !== req.user.id)) throw ApiError.notFound('Search run not found');
  const sources = await LeadSource.findAll({ where: { search_run_id: run.id }, attributes: ['company_id'], raw: true });
  const companyWhere = { id: { [Op.in]: [...new Set(sources.map((s) => s.company_id))] } };
  if (req.query.website === 'yes') companyWhere.has_website = true;
  if (req.query.website === 'no') companyWhere.has_website = false;
  if (req.query.contact === 'phone') companyWhere.has_phone = true;
  if (req.query.contact === 'email') companyWhere.has_email = true;
  const leadWhere = { ...(await access.leadScope(req.user)) };
  if (req.query.min_score) leadWhere.lead_score = { [Op.gte]: Number(req.query.min_score) };
  const leads = await Lead.findAll({
    where: leadWhere,
    include: [
      {
        model: Company,
        as: 'company',
        where: companyWhere,
        attributes: ['id', 'company_name', 'industry', 'city', 'state', 'website', 'has_website', 'has_phone', 'has_email'],
        include: [
          { model: CompanyContact, as: 'contacts' },
          { model: CompanyWebsite, as: 'websites', attributes: ['id', 'url', 'status', 'health', 'opportunity_score', 'is_https'] },
          { model: DetectedSignal, as: 'detectedSignals', attributes: ['id', 'signal_type', 'signal_strength', 'signal_description'] },
        ],
      },
    ],
    order: [['lead_score', 'DESC']],
    limit: 200,
  });
  return ok(res, { run, leads: leads.map((l) => access.maskLead(req.user, l)) });
};

exports.buildTarget = buildTarget;
exports.OPPORTUNITY_TYPES = OPPORTUNITY_TYPES;
