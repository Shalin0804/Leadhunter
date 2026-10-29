/**
 * Geographic location management (Main Admin: locations.manage) and browsing of
 * approved locations for discovery (discovery.run). Employees can only ever read
 * active locations; every write is admin-only and audited.
 */
const { Op } = require('sequelize');
const { Location, LocationImportJob, User } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');
const { can } = require('../config/permissions');
const audit = require('../services/auditService');
const importer = require('../services/locationImportService');

const LIST_ATTRS = ['id', 'name', 'location_type', 'country_code', 'parent_id', 'latitude', 'longitude', 'population', 'search_radius_km', 'is_active', 'source', 'feature_code', 'created_by_user_id', 'created_at', 'updated_at'];
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Ancestors from the country down to `loc` itself. */
async function lineage(loc) {
  const chain = [loc];
  let cur = loc;
  for (let i = 0; i < 5 && cur.parent_id; i += 1) {
    cur = await Location.findByPk(cur.parent_id); // eslint-disable-line no-await-in-loop
    if (!cur) break;
    chain.unshift(cur);
  }
  return chain;
}

/** A location usable for discovery: exists, active, and every ancestor active. Throws otherwise. */
async function resolveUsable(id) {
  const loc = Number.isInteger(Number(id)) ? await Location.findByPk(id) : null;
  if (!loc) throw ApiError.badRequest('Unknown location');
  const chain = await lineage(loc);
  if (chain.some((l) => !l.is_active)) throw ApiError.forbidden('This location is not approved for discovery');
  return { loc, chain, label: [...chain].reverse().map((l) => l.name).join(', ') };
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
  const manage = can(req.user, 'locations.manage');
  const where = {};
  if (!manage || req.query.include_inactive !== 'true') where.is_active = true;
  if (req.query.status === 'inactive' && manage) where.is_active = false;
  if (req.query.parent_id) where.parent_id = req.query.parent_id === 'root' ? null : Number(req.query.parent_id);
  if (req.query.type && Location.TYPES.includes(req.query.type)) where.location_type = req.query.type;
  if (req.query.country_code) where.country_code = String(req.query.country_code).toUpperCase().slice(0, 2);
  if (req.query.search) {
    const term = `%${importer.normalize(req.query.search).slice(0, 80)}%`;
    where[Op.or] = [{ normalized_name: { [likeOp]: term } }, { name: { [likeOp]: `%${String(req.query.search).slice(0, 80)}%` } }];
  }
  const sortable = { name: 'name', population: 'population', created_at: 'created_at', updated_at: 'updated_at', type: 'administrative_level' };
  const order = [[sortable[req.query.sort] || 'name', String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'], ['id', 'ASC']];
  const { rows, count } = await Location.findAndCountAll({
    where,
    attributes: LIST_ATTRS,
    include: manage ? [{ model: User, as: 'createdBy', attributes: ['id', 'name'] }, { model: Location, as: 'parent', attributes: ['id', 'name', 'location_type'] }] : [],
    order,
    limit,
    offset,
  });
  if (req.query.search) {
    await audit.record(req, { action: 'location.searched', resourceType: 'location', metadata: { search: String(req.query.search).slice(0, 80), type: req.query.type, results: count } });
  }
  return ok(res, paginated(rows, count, page, limit));
};

exports.get = async (req, res) => {
  const loc = await Location.findByPk(req.params.id, { include: [{ model: User, as: 'createdBy', attributes: ['id', 'name'] }] });
  if (!loc || (!loc.is_active && !can(req.user, 'locations.manage'))) throw ApiError.notFound('Location not found');
  const chain = await lineage(loc);
  const children = await Location.count({ where: { parent_id: loc.id } });
  return ok(res, { location: loc, breadcrumb: chain.map((l) => ({ id: l.id, name: l.name, location_type: l.location_type, is_active: l.is_active })), children });
};

/* ---------------- Admin writes ---------------- */

function validateCoords(lat, lon, radius) {
  if (lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) throw ApiError.badRequest('latitude must be between -90 and 90');
  if (lon !== null && (Number.isNaN(lon) || lon < -180 || lon > 180)) throw ApiError.badRequest('longitude must be between -180 and 180');
  if (radius !== null && (!Number.isInteger(radius) || radius < 1 || radius > 500)) throw ApiError.badRequest('search_radius_km must be 1-500');
}

const LEVEL = { country: 0, state: 1, city: 2, area: 3 };

exports.create = async (req, res) => {
  const { name, location_type, parent_id, country_code } = req.body;
  if (!Location.TYPES.includes(location_type)) throw ApiError.badRequest(`location_type must be one of ${Location.TYPES.join(', ')}`);
  let parent = null;
  if (location_type !== 'country') {
    parent = await Location.findByPk(parent_id);
    if (!parent) throw ApiError.badRequest('parent_id is required and must exist');
    if (LEVEL[parent.location_type] >= LEVEL[location_type]) throw ApiError.badRequest(`A ${location_type} cannot sit under a ${parent.location_type}`);
  }
  const cc = (parent?.country_code || String(country_code || '')).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw ApiError.badRequest('country_code (2 letters) is required for a country');
  const lat = num(req.body.latitude);
  const lon = num(req.body.longitude);
  const radius = num(req.body.search_radius_km);
  validateCoords(lat, lon, radius);

  const loc = await Location.create({
    source: 'manual',
    source_external_id: null,
    name: String(name).trim(),
    normalized_name: importer.normalize(name),
    country_code: cc,
    location_type,
    administrative_level: LEVEL[location_type],
    parent_id: parent?.id || null,
    latitude: lat,
    longitude: lon,
    search_radius_km: radius,
    created_by_user_id: req.user.id,
    updated_by_user_id: req.user.id,
  });
  await audit.record(req, { action: 'location.created', resourceType: 'location', resourceId: loc.id, metadata: { name: loc.name, type: location_type, parent_id: loc.parent_id, country: cc } });
  return ok(res, { location: loc }, 201);
};

// Collect every descendant id (bounded depth: country > state > city > area).
async function descendantIds(ids) {
  const all = [];
  let frontier = ids;
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    // eslint-disable-next-line no-await-in-loop
    const kids = await Location.findAll({ where: { parent_id: { [Op.in]: frontier } }, attributes: ['id'], raw: true });
    frontier = kids.map((k) => k.id);
    all.push(...frontier);
  }
  return all;
}

exports.update = async (req, res) => {
  const loc = await Location.findByPk(req.params.id);
  if (!loc) throw ApiError.notFound('Location not found');
  const changes = {};
  if (req.body.name !== undefined && String(req.body.name).trim() && String(req.body.name).trim() !== loc.name) {
    changes.name = { from: loc.name, to: String(req.body.name).trim().slice(0, 200) };
    loc.name = changes.name.to;
    loc.normalized_name = importer.normalize(loc.name);
  }
  for (const f of ['latitude', 'longitude', 'search_radius_km']) {
    if (req.body[f] === undefined) continue; // eslint-disable-line no-continue
    const v = num(req.body[f]);
    if (String(v ?? '') !== String(loc[f] == null ? '' : Number(loc[f]))) {
      changes[f] = { from: loc[f] == null ? null : Number(loc[f]), to: v };
      loc[f] = v;
    }
  }
  validateCoords(loc.latitude == null ? null : Number(loc.latitude), loc.longitude == null ? null : Number(loc.longitude), loc.search_radius_km == null ? null : Number(loc.search_radius_km));
  let cascaded = 0;
  if (req.body.is_active !== undefined && Boolean(req.body.is_active) !== loc.is_active) {
    changes.is_active = { from: loc.is_active, to: Boolean(req.body.is_active) };
    loc.is_active = Boolean(req.body.is_active);
    if (req.body.cascade) {
      const ids = await descendantIds([loc.id]);
      if (ids.length) [cascaded] = await Location.update({ is_active: loc.is_active, updated_by_user_id: req.user.id }, { where: { id: { [Op.in]: ids } } });
    }
  }
  if (!Object.keys(changes).length) return ok(res, { location: loc });
  loc.updated_by_user_id = req.user.id;
  await loc.save();

  const { is_active: active, ...config } = changes;
  if (active) await audit.record(req, { action: loc.is_active ? 'location.activated' : 'location.deactivated', resourceType: 'location', resourceId: loc.id, metadata: { name: loc.name, cascaded } });
  if (Object.keys(config).length) {
    const configChange = config.latitude || config.longitude || config.search_radius_km;
    await audit.record(req, { action: configChange ? 'location.config_changed' : 'location.updated', resourceType: 'location', resourceId: loc.id, metadata: { name: loc.name, changes: config } });
  }
  return ok(res, { location: loc, cascaded });
};

/** Manual locations with no children are deleted; anything else is deactivated (imported data is kept). */
exports.remove = async (req, res) => {
  const loc = await Location.findByPk(req.params.id);
  if (!loc) throw ApiError.notFound('Location not found');
  const children = await Location.count({ where: { parent_id: loc.id } });
  if (loc.source === 'manual' && !children) {
    await loc.destroy();
    await audit.record(req, { action: 'location.deleted', resourceType: 'location', resourceId: loc.id, metadata: { name: loc.name, type: loc.location_type } });
    return ok(res, { deleted: true });
  }
  await loc.update({ is_active: false, updated_by_user_id: req.user.id });
  await audit.record(req, { action: 'location.deactivated', resourceType: 'location', resourceId: loc.id, metadata: { name: loc.name, reason: children ? 'has children' : 'imported record' } });
  return ok(res, { deleted: false, deactivated: true });
};

/* ---------------- Country import ---------------- */

exports.catalog = async (req, res) => {
  try {
    return ok(res, { countries: await importer.listCountries(), source: 'GeoNames (CC BY 4.0)', dataset: importer.geonamesSource.dataset });
  } catch (err) {
    console.error('[locations] country catalog failed:', err.message);
    throw new ApiError(503, 'Could not reach GeoNames to list countries — try again shortly');
  }
};

exports.importCountry = async (req, res) => {
  try {
    const { job } = await importer.startImport({ countryCode: req.body.country_code, userId: req.user.id });
    await audit.record(req, { action: 'location.import_started', resourceType: 'location_import', resourceId: job.id, metadata: { country: job.country_code, dataset: job.dataset } });
    return ok(res, { job }, 202);
  } catch (err) {
    if (err.statusCode) throw new ApiError(err.statusCode, err.message);
    throw err;
  }
};

exports.jobs = async (req, res) => {
  const jobs = await LocationImportJob.findAll({ include: [{ model: User, as: 'startedBy', attributes: ['id', 'name'] }], order: [['id', 'DESC']], limit: 50 });
  const lastSync = await LocationImportJob.findAll({ where: { status: 'completed' }, attributes: ['country_code', 'finished_at'], order: [['finished_at', 'DESC']], raw: true });
  const countries = await Location.findAll({ where: { location_type: 'country' }, attributes: ['id', 'name', 'country_code', 'is_active'], order: [['name', 'ASC']] });
  const counts = await Location.findAll({
    attributes: ['country_code', 'location_type', [Location.sequelize.fn('COUNT', Location.sequelize.col('id')), 'n']],
    group: ['country_code', 'location_type'],
    raw: true,
  });
  return ok(res, {
    jobs,
    countries: countries.map((c) => ({
      ...c.get(),
      last_synced_at: lastSync.find((j) => j.country_code === c.country_code)?.finished_at || null,
      counts: Object.fromEntries(counts.filter((x) => x.country_code === c.country_code).map((x) => [x.location_type, Number(x.n)])),
    })),
  });
};

exports.resumeJob = async (req, res) => {
  try {
    const { job } = await importer.resumeJob(req.params.id);
    await audit.record(req, { action: 'location.import_resumed', resourceType: 'location_import', resourceId: job.id, metadata: { country: job.country_code, from: job.checkpoint } });
    return ok(res, { job }, 202);
  } catch (err) {
    if (err.statusCode) throw new ApiError(err.statusCode, err.message);
    throw err;
  }
};

exports.cancelJob = async (req, res) => {
  const job = await LocationImportJob.findByPk(req.params.id);
  if (!job) throw ApiError.notFound('Import job not found');
  if (!['queued', 'running'].includes(job.status)) throw ApiError.badRequest('Only queued or running jobs can be cancelled');
  await job.update({ status: 'cancelled' }); // the worker stops at its next checkpoint
  await audit.record(req, { action: 'location.import_cancel_requested', resourceType: 'location_import', resourceId: job.id, metadata: { country: job.country_code } });
  return ok(res, { job });
};

exports.resolveUsable = resolveUsable;
