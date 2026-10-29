/**
 * Country -> state -> city -> area import from GeoNames bulk dumps (CC BY 4.0,
 * https://download.geonames.org/export/dump/, attribution required, no API key).
 *
 * Why bulk files instead of an API: one download per import instead of thousands
 * of per-place requests, no daily credit limits, and the official recommended path
 * for large imports. Everything is streamed line by line (never held in memory).
 *
 * Coverage (reported on every job): GeoNames' citiesN dataset = populated places
 * with population >= N plus admin seats; neighbourhoods (feature PPLX) only where
 * GeoNames has them. Villages and many small areas are NOT included. States come
 * from admin1CodesASCII.txt. Nothing is invented — absent fields stay null.
 *
 * Reliability: the job row is checkpointed (stage + line) every batch, so a restart
 * (e.g. a sleeping free-tier host) resumes where it stopped; imports are idempotent
 * (rows are keyed by source + GeoNames id, never by name), so a retry never duplicates.
 */
const readline = require('readline');
const { Readable } = require('stream');
const { Op } = require('sequelize');
const { Location, LocationImportJob, User } = require('../models');
const audit = require('./auditService');

const BASE = process.env.GEONAMES_BASE_URL || 'https://download.geonames.org/export/dump';
const DATASET = ['cities500', 'cities1000', 'cities5000', 'cities15000'].includes(process.env.GEONAMES_DATASET)
  ? process.env.GEONAMES_DATASET
  : 'cities1000';
const BATCH = parseInt(process.env.LOCATION_IMPORT_BATCH || '500', 10);
const AREA_LINK_KM = 25; // an area is linked to the nearest city within this distance
const STALE_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const normalize = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------------- GeoNames source (network) ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastDownload = 0;

// Throttled (>= 2s between requests to the GeoNames server) with exponential-backoff retries.
async function download(url, { attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const wait = Math.max(0, 2000 - (Date.now() - lastDownload));
    if (wait) await sleep(wait); // eslint-disable-line no-await-in-loop
    lastDownload = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'LeadHunterCRM/1.0 (location import)' } }); // eslint-disable-line no-await-in-loop
      if (res.ok) return res;
      lastErr = new Error(`GeoNames responded ${res.status} for ${url.split('/').pop()}`);
      if (res.status < 500 && res.status !== 429) break; // 4xx other than rate-limit: retrying won't help
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000 * 2 ** (i + 1)); // eslint-disable-line no-await-in-loop
  }
  throw lastErr;
}

const lines = (nodeStream) => readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

const geonamesSource = {
  name: 'geonames',
  dataset: DATASET,
  coverageNote:
    `GeoNames ${DATASET}: populated places with population >= ${DATASET.replace('cities', '')} and administrative seats; ` +
    'neighbourhoods only where GeoNames records them (feature PPLX). Villages and smaller localities are not included.',
  async countryLines() {
    const res = await download(`${BASE}/countryInfo.txt`);
    return lines(Readable.fromWeb(res.body));
  },
  async admin1Lines() {
    const res = await download(`${BASE}/admin1CodesASCII.txt`);
    return lines(Readable.fromWeb(res.body));
  },
  async placeLines() {
    const unzipper = require('unzipper');
    const res = await download(`${BASE}/${DATASET}.zip`);
    return lines(Readable.fromWeb(res.body).pipe(unzipper.ParseOne(new RegExp(`${DATASET}\\.txt$`))));
  },
};

/* ---------------- Countries ---------------- */

let countryCache = null;
async function listCountries(source = geonamesSource) {
  if (countryCache && Date.now() - countryCache.at < 24 * 3600 * 1000 && source === geonamesSource) return countryCache.list;
  const list = [];
  for await (const line of await source.countryLines()) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c[0]?.length === 2) list.push({ code: c[0], name: c[4], capital: c[5] || null, population: Number(c[7]) || null, geonameid: c[16] || null });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  if (source === geonamesSource) countryCache = { at: Date.now(), list };
  return list;
}

/* ---------------- Upsert ---------------- */

// Insert new rows, update only rows whose source data changed, count the rest as already present.
// Never touches is_active, so an admin's deactivation survives a re-sync.
async function upsertBatch(rows, counts) {
  if (!rows.length) return new Map();
  const existing = await Location.findAll({
    where: { source: rows[0].source, source_external_id: { [Op.in]: rows.map((r) => r.source_external_id) } },
  });
  const byExt = new Map(existing.map((e) => [e.source_external_id, e]));
  const fresh = rows.filter((r) => !byExt.has(r.source_external_id));
  const now = new Date();
  if (fresh.length) {
    const created = await Location.bulkCreate(fresh.map((r) => ({ ...r, discovered_at: now, last_verified_at: now })));
    created.forEach((c) => byExt.set(c.source_external_id, c));
    counts.imported += fresh.length;
  }
  for (const r of rows) {
    const e = existing.find((x) => x.source_external_id === r.source_external_id);
    if (!e) continue; // eslint-disable-line no-continue
    // Areas are re-parented to their nearest city after import, so their parent isn't a source change.
    const fields = r.location_type === 'area' ? ['name', 'population', 'feature_code'] : ['name', 'population', 'feature_code', 'parent_id'];
    const changed = fields.filter((k) => r[k] !== undefined && String(e[k] ?? '') !== String(r[k] ?? ''));
    const moved = r.latitude != null && Number(e.latitude) !== Number(r.latitude);
    if (changed.length || moved) {
      // eslint-disable-next-line no-await-in-loop
      await e.update({ ...Object.fromEntries(changed.map((k) => [k, r[k]])), latitude: r.latitude, longitude: r.longitude, alternate_names: r.alternate_names, last_verified_at: now });
      counts.updated += 1;
    } else {
      counts.skipped_existing += 1;
    }
  }
  return byExt;
}

/* ---------------- Job runner ---------------- */

const running = new Set(); // job ids executing in this process

async function saveProgress(job, patch) {
  await job.update({ ...patch, heartbeat_at: new Date() });
  if (job.status === 'running') {
    const fresh = await LocationImportJob.findByPk(job.id, { attributes: ['status'] });
    if (fresh.status === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true });
  }
}

async function actorFor(job) {
  return job.started_by_user_id ? User.findByPk(job.started_by_user_id) : null;
}

async function runJob(jobId, source = geonamesSource) {
  if (running.has(jobId)) return;
  running.add(jobId);
  const job = await LocationImportJob.findByPk(jobId);
  const cc = job.country_code;
  const counts = { imported: job.imported, updated: job.updated, skipped_existing: job.skipped_existing };
  const cp = job.checkpoint || {};
  const errors = job.errors || [];
  try {
    await job.update({ status: 'running', attempts: job.attempts + 1, started_at: job.started_at || new Date(), heartbeat_at: new Date(), coverage_note: source.coverageNote, dataset: source.dataset });

    // 1. Country row
    await saveProgress(job, { stage: 'country' });
    const country = (await listCountries(source)).find((c) => c.code === cc);
    if (!country) throw new Error(`Country ${cc} not found in GeoNames countryInfo`);
    const countryRow = (
      await upsertBatch([{ source: source.name, source_external_id: String(country.geonameid || `country:${cc}`), name: country.name, normalized_name: normalize(country.name), country_code: cc, location_type: 'country', administrative_level: 0, feature_code: 'PCLI', population: country.population }], counts)
    ).values().next().value;

    // 2. States (admin1)
    await saveProgress(job, { stage: 'states', ...counts });
    const stateRows = [];
    for await (const line of await source.admin1Lines()) {
      if (!line.startsWith(`${cc}.`)) continue; // eslint-disable-line no-continue
      const [code, name, ascii, gid] = line.split('\t');
      stateRows.push({ source: source.name, source_external_id: String(gid), name, normalized_name: normalize(ascii || name), alternate_names: ascii && ascii !== name ? [ascii] : null, country_code: cc, location_type: 'state', administrative_level: 1, parent_id: countryRow.id, metadata: { admin1_code: code.split('.')[1] } });
    }
    const states = await upsertBatch(stateRows, counts);
    const stateByAdmin1 = new Map([...states.values()].map((s) => [s.metadata?.admin1_code, s.id]));
    await saveProgress(job, { stage: 'places', states_found: stateRows.length, ...counts, checkpoint: { stage: 'places', line: cp.stage === 'places' ? cp.line : 0 } });

    // 3. Cities and areas — streamed, checkpointed every batch
    if (cp.stage !== 'linking') {
      const resumeFrom = cp.stage === 'places' ? cp.line || 0 : 0;
      let n = 0;
      let batch = [];
      let cities = job.cities_found;
      let areas = job.areas_found;
      if (!resumeFrom) cities = areas = 0; // eslint-disable-line no-multi-assign
      const flush = async () => {
        try {
          await upsertBatch(batch, counts);
        } catch (err) {
          job.failed_records += batch.length;
          errors.push({ at: new Date().toISOString(), line: n, message: String(err.message).slice(0, 200) });
        }
        batch = [];
        await saveProgress(job, { stage: 'places', cities_found: cities, areas_found: areas, failed_records: job.failed_records, errors: errors.slice(-10), ...counts, checkpoint: { stage: 'places', line: n } });
      };
      for await (const line of await source.placeLines()) {
        n += 1;
        if (n <= resumeFrom) continue; // eslint-disable-line no-continue
        const c = line.split('\t');
        if (c[8] !== cc || c[6] !== 'P') continue; // eslint-disable-line no-continue
        const isArea = c[7] === 'PPLX';
        if (isArea) areas += 1;
        else cities += 1;
        const alts = (c[3] || '').split(',').filter((a) => a && a !== c[1] && /^[\p{L}\s.'-]+$/u.test(a)).slice(0, 8);
        batch.push({
          source: source.name,
          source_external_id: c[0],
          name: c[1],
          normalized_name: normalize(c[2] || c[1]),
          alternate_names: alts.length ? alts : null,
          country_code: cc,
          location_type: isArea ? 'area' : 'city',
          administrative_level: isArea ? 3 : 2,
          feature_code: c[7],
          parent_id: stateByAdmin1.get(c[10]) || countryRow.id,
          latitude: c[4] ? Number(c[4]) : null,
          longitude: c[5] ? Number(c[5]) : null,
          population: Number(c[14]) || null,
          metadata: { admin1_code: c[10] || null, admin2_code: c[11] || null, timezone: c[17] || null },
        });
        if (batch.length >= BATCH) await flush(); // eslint-disable-line no-await-in-loop
      }
      await flush();
    }

    // 4. Link areas to their nearest city (GeoNames has no explicit area->city relation)
    await saveProgress(job, { stage: 'linking', checkpoint: { stage: 'linking' } });
    for (const stateId of [...stateByAdmin1.values(), countryRow.id]) {
      // eslint-disable-next-line no-await-in-loop
      const [cityRows, areaRows] = await Promise.all([
        Location.findAll({ where: { country_code: cc, location_type: 'city', parent_id: stateId }, attributes: ['id', 'latitude', 'longitude'], raw: true }),
        Location.findAll({ where: { country_code: cc, location_type: 'area', parent_id: stateId }, attributes: ['id', 'latitude', 'longitude'], raw: true }),
      ]);
      for (const a of areaRows) {
        let best = null;
        for (const city of cityRows) {
          const d = haversineKm(a, city);
          if (d <= AREA_LINK_KM && (!best || d < best.d)) best = { id: city.id, d };
        }
        // eslint-disable-next-line no-await-in-loop
        if (best) await Location.update({ parent_id: best.id }, { where: { id: a.id } });
      }
    }

    await job.update({ status: 'completed', stage: 'done', finished_at: new Date(), heartbeat_at: new Date(), ...counts, errors: errors.slice(-10), checkpoint: null });
    await audit.record(null, { actor: await actorFor(job), action: 'location.import_completed', resourceType: 'location_import', resourceId: job.id, metadata: { country: cc, ...counts, cities: job.cities_found, areas: job.areas_found, states: job.states_found } }).catch(() => {});
  } catch (err) {
    const cancelled = err.cancelled;
    errors.push({ at: new Date().toISOString(), message: String(err.message).slice(0, 300) });
    await job.update({ status: cancelled ? 'cancelled' : 'failed', finished_at: new Date(), ...counts, errors: errors.slice(-10) });
    await audit.record(null, { actor: await actorFor(job), action: cancelled ? 'location.import_cancelled' : 'location.import_failed', resourceType: 'location_import', resourceId: job.id, result: cancelled ? 'success' : 'failure', metadata: { country: cc, stage: job.stage, error: cancelled ? null : String(err.message).slice(0, 200) } }).catch(() => {});
    if (!cancelled) console.error(`[locations] import ${job.id} (${cc}) failed at ${job.stage}:`, err.message);
  } finally {
    running.delete(jobId);
  }
}

function haversineKm(a, b) {
  if (a.latitude == null || b.latitude == null) return Infinity;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Create a job and run it in the background (the HTTP request returns immediately). */
async function startImport({ countryCode, userId }, source = geonamesSource) {
  const cc = String(countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw Object.assign(new Error('country_code must be a 2-letter ISO code'), { statusCode: 400 });
  const active = await LocationImportJob.findOne({ where: { country_code: cc, status: { [Op.in]: ['queued', 'running'] } } });
  if (active) throw Object.assign(new Error(`An import for ${cc} is already in progress (job #${active.id})`), { statusCode: 409 });
  const country = (await listCountries(source)).find((c) => c.code === cc);
  if (!country) throw Object.assign(new Error(`Unknown country code ${cc}`), { statusCode: 400 });
  const job = await LocationImportJob.create({ country_code: cc, country_name: country.name, source: source.name, dataset: source.dataset, status: 'queued', started_by_user_id: userId });
  const done = runJob(job.id, source);
  return { job, done };
}

/** Resume a failed/cancelled/stale job from its checkpoint. */
async function resumeJob(jobId, source = geonamesSource) {
  const job = await LocationImportJob.findByPk(jobId);
  if (!job) throw Object.assign(new Error('Import job not found'), { statusCode: 404 });
  if (job.status === 'completed') throw Object.assign(new Error('Job already completed — start a new sync instead'), { statusCode: 400 });
  if (running.has(job.id)) throw Object.assign(new Error('Job is already running'), { statusCode: 409 });
  await job.update({ status: 'queued', finished_at: null });
  return { job, done: runJob(job.id, source) };
}

/** On boot: pick up jobs that were running when the process stopped. */
async function resumeStaleJobs() {
  const stale = await LocationImportJob.findAll({
    where: { status: { [Op.in]: ['queued', 'running'] }, attempts: { [Op.lt]: MAX_ATTEMPTS }, [Op.or]: [{ heartbeat_at: null }, { heartbeat_at: { [Op.lt]: new Date(Date.now() - STALE_MS) } }] },
  });
  for (const job of stale) {
    if (!running.has(job.id)) runJob(job.id).catch(() => {});
  }
  return stale.length;
}

module.exports = { listCountries, startImport, resumeJob, resumeStaleJobs, runJob, normalize, geonamesSource, haversineKm, _running: running };
