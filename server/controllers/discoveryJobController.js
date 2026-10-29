/**
 * Scheduled location-based discovery jobs (Main Admin; mounted under /automation,
 * which is gated by discovery.use). See services/discoveryJobService.js for execution.
 */
const { Op } = require('sequelize');
const { DiscoveryJob, Location, BusinessCategory, SearchRun } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const audit = require('../services/auditService');
const { getSettings } = require('../services/automationSettingsService');
const { ensureSeeded } = require('../services/categoryService');
const { normalize } = require('../services/locationImportService');
const svc = require('../services/discoveryJobService');
const { withRunLock, isRunning } = require('../jobs/automationScheduler');
const { resolveUsable } = require('./locationController');
const { buildTarget } = require('./leadDiscoveryController');

const INCLUDE = [
  { model: Location, as: 'location', attributes: ['id', 'name', 'location_type', 'country_code', 'is_active', 'search_radius_km'] },
  { model: BusinessCategory, as: 'category', attributes: ['id', 'name', 'key', 'is_enabled'] },
];

async function withLabels(jobs) {
  return Promise.all(
    jobs.map(async (j) => {
      const o = j.get({ plain: true });
      try {
        o.location_label = (await resolveUsable(j.location_id)).label;
        o.location_usable = true;
      } catch (err) {
        o.location_label = o.location?.name || `#${j.location_id}`;
        o.location_usable = false;
        o.location_warning = err.message;
      }
      return o;
    })
  );
}

exports.list = async (req, res) => {
  const jobs = await DiscoveryJob.findAll({ include: INCLUDE, order: [['id', 'ASC']] });
  const runIds = jobs.map((j) => j.last_search_run_id).filter(Boolean);
  const runs = runIds.length ? await SearchRun.findAll({ where: { id: { [Op.in]: runIds } }, attributes: ['id', 'status', 'businesses_discovered', 'new_companies', 'duplicates_skipped', 'qualified_leads', 'errors'], raw: true }) : [];
  const rows = (await withLabels(jobs)).map((j) => ({ ...j, last_run: runs.find((r) => r.id === j.last_search_run_id) || null }));
  return ok(res, { jobs: rows, frequencies: DiscoveryJob.FREQUENCIES, running: isRunning() });
};

function fields(body) {
  const out = {};
  if (body.frequency !== undefined) {
    if (!DiscoveryJob.FREQUENCIES.includes(body.frequency)) throw ApiError.badRequest(`frequency must be one of ${DiscoveryJob.FREQUENCIES.join(', ')}`);
    out.frequency = body.frequency;
  }
  if (body.max_results !== undefined) {
    const n = Number(body.max_results);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw ApiError.badRequest('max_results must be 1-50');
    out.max_results = n;
  }
  if (body.radius_km !== undefined) out.radius_km = body.radius_km === '' || body.radius_km === null ? null : Number(body.radius_km);
  if (body.is_enabled !== undefined) out.is_enabled = Boolean(body.is_enabled);
  return out;
}

exports.create = async (req, res) => {
  await ensureSeeded();
  const f = fields(req.body);
  const category = await BusinessCategory.findByPk(req.body.business_category_id);
  if (!category || !category.is_enabled) throw ApiError.badRequest('Choose an enabled business category');
  await buildTarget(req.body.location_id, { radiusKm: f.radius_km, maxResults: f.max_results }); // validates location + radius now
  const existing = await DiscoveryJob.findOne({ where: { location_id: req.body.location_id, business_category_id: category.id } });
  if (existing) throw ApiError.conflict(`A job for this location and category already exists (#${existing.id})`);
  const job = await DiscoveryJob.create({
    ...f,
    location_id: Number(req.body.location_id),
    business_category_id: category.id,
    next_run_at: new Date(), // first run on the next tick
    created_by_user_id: req.user.id,
  });
  await audit.record(req, { action: 'discovery_job.created', resourceType: 'discovery_job', resourceId: job.id, metadata: { location_id: job.location_id, category: category.key, frequency: job.frequency, max_results: job.max_results, radius_km: job.radius_km } });
  return ok(res, { job }, 201);
};

exports.update = async (req, res) => {
  const job = await DiscoveryJob.findByPk(req.params.id);
  if (!job) throw ApiError.notFound('Job not found');
  const f = fields(req.body);
  if (f.radius_km !== undefined || f.max_results !== undefined) await buildTarget(job.location_id, { radiusKm: f.radius_km ?? job.radius_km, maxResults: f.max_results ?? job.max_results });
  const changed = Object.keys(f).filter((k) => String(job[k] ?? '') !== String(f[k] ?? ''));
  if (f.frequency && f.frequency !== job.frequency && job.last_run_at) f.next_run_at = svc.nextRun({ frequency: f.frequency }, job.last_run_at.getTime());
  if (f.is_enabled && !job.is_enabled && (!job.next_run_at || job.next_run_at < new Date())) f.next_run_at = new Date();
  await job.update(f);
  if (changed.length) await audit.record(req, { action: 'discovery_job.updated', resourceType: 'discovery_job', resourceId: job.id, metadata: { fields: changed.join(','), is_enabled: job.is_enabled } });
  return ok(res, { job });
};

exports.remove = async (req, res) => {
  const job = await DiscoveryJob.findByPk(req.params.id);
  if (!job) throw ApiError.notFound('Job not found');
  if (job.running_since) throw ApiError.conflict('This job is running — try again when it finishes');
  await job.destroy(); // search runs and leads it produced are kept
  await audit.record(req, { action: 'discovery_job.deleted', resourceType: 'discovery_job', resourceId: job.id, metadata: { location_id: job.location_id, category_id: job.business_category_id } });
  return ok(res, { deleted: true });
};

exports.runNow = async (req, res) => {
  const job = await DiscoveryJob.findByPk(req.params.id);
  if (!job) throw ApiError.notFound('Job not found');
  if (isRunning()) throw ApiError.conflict('A discovery run is already in progress');
  withRunLock('manual', () => svc.runJob(job, { triggeredBy: 'manual', triggeredByUserId: req.user.id })).catch((e) => console.error('[discovery-job] run failed:', e.message));
  await audit.record(req, { action: 'discovery_job.run_requested', resourceType: 'discovery_job', resourceId: job.id });
  return ok(res, { message: 'Job started' }, 202);
};

/**
 * Map the free-text automation locations (Automation Settings) onto location records.
 * Read-only: the free-text config keeps running unchanged; the admin converts what
 * resolves. "resolved" = exactly one active match whose ancestors agree with the text.
 */
exports.legacy = async (req, res) => {
  const settings = await getSettings();
  const out = [];
  for (const text of settings.locations || []) {
    const parts = String(text).split(',').map((p) => normalize(p)).filter(Boolean);
    // eslint-disable-next-line no-await-in-loop
    const candidates = await Location.findAll({ where: { normalized_name: parts[0] || '__none__' }, limit: 20 });
    const scored = [];
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const usable = await resolveUsable(c.id).catch(() => null);
      const chainNames = usable ? usable.chain.map((l) => normalize(l.name)) : [];
      const agrees = parts.slice(1).every((p) => chainNames.includes(p));
      if (usable) scored.push({ id: c.id, label: usable.label, location_type: c.location_type, agrees });
    }
    const agreeing = scored.filter((s) => s.agrees);
    const status = agreeing.length === 1 ? 'resolved' : scored.length ? 'ambiguous' : 'unresolved';
    out.push({ text, status, match: status === 'resolved' ? agreeing[0] : null, candidates: scored.slice(0, 5) });
  }
  return ok(res, { locations: out, industries: settings.industries || [] });
};
