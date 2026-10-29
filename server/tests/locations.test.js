/**
 * Location management, country import and location-based discovery tests.
 * In-memory SQLite; the GeoNames source is replaced by a small fixture in the real
 * GeoNames file formats, so no network is touched.
 *   npm --prefix server run test:locations
 */
process.env.DATABASE_URL = '';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.YELP_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const importer = require('../services/locationImportService');
const app = require('../app');

const { sequelize, User, Location, LocationImportJob, AuditLog, Setting, SearchRun, Company, Lead } = db;

// --- Fixture in GeoNames formats (countryInfo / admin1CodesASCII / citiesN) ---
const TAB = '\t';
const place = (id, name, lat, lon, code, cc, admin1, pop) =>
  [id, name, name, '', lat, lon, 'P', code, cc, '', admin1, '', '', '', pop, '', '', 'Asia/Kolkata', '2024-01-01'].join(TAB);
const COUNTRY = ['# ISO\tISO3', ['IN', 'IND', '356', 'IN', 'India', 'New Delhi', '3287590', '1352617328', 'AS', '.in', 'INR', 'Rupee', '91', '', '', 'en-IN,hi', '1269750', '', ''].join(TAB)];
const ADMIN1 = ['IN.09\tGujarat\tGujarat\t1270770', 'IN.16\tMaharashtra\tMaharashtra\t1264418', 'US.CA\tCalifornia\tCalifornia\t5332921'];
const PLACES = [
  place('1279233', 'Ahmedabad', '23.02579', '72.58727', 'PPLA2', 'IN', '09', '3719710'),
  place('1275841', 'Vadodara', '22.29941', '73.20812', 'PPL', 'IN', '09', '1409476'),
  place('9999001', 'Navrangpura', '23.03650', '72.56110', 'PPLX', 'IN', '09', '0'),
  place('1275339', 'Mumbai', '19.07283', '72.88261', 'PPLA', 'IN', '16', '12691836'),
  place('5368361', 'Los Angeles', '34.05223', '-118.24368', 'PPLA2', 'US', 'CA', '3971883'),
];

function fixtureSource({ failAfterPlaceLine } = {}) {
  let failed = false;
  async function* gen(arr, failAt) {
    let n = 0;
    for (const l of arr) {
      n += 1;
      if (failAt && n === failAt && !failed) {
        failed = true;
        throw new Error('simulated connection reset');
      }
      yield l;
    }
  }
  return {
    name: 'geonames',
    dataset: 'fixture',
    coverageNote: 'test fixture',
    countryLines: async () => gen(COUNTRY),
    admin1Lines: async () => gen(ADMIN1),
    placeLines: async () => gen(PLACES, failAfterPlaceLine),
  };
}

let server;
let base;
const u = {};
const tok = {};

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const byName = (name) => Location.findOne({ where: { name } });

test.before(async () => {
  await sequelize.sync({ force: true });
  u.admin = await User.create({ name: 'Main Admin', email: 'a@t.local', password_hash: 'x', role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'm@t.local', password_hash: 'x', role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'b@t.local', password_hash: 'x', role: 'agent' });
  u.viewer = await User.create({ name: 'Vik Viewer', email: 'v@t.local', password_hash: 'x', role: 'viewer' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);
  // Existing CRM data that must survive everything below.
  const c = await Company.create({ company_name: 'Existing Co', source: 'csv', city: 'Ahmedabad', state: 'Gujarat' });
  await Lead.create({ company_id: c.id, assigned_user_id: u.bde.id });
  // Discovery providers: Yelp without a key -> reported NOT_CONFIGURED, never a fake result, no network.
  await Setting.create({ key: 'automation_config', value: { discoveryProviders: ['yelp'], provider: 'yelp', locations: [], industries: [] } });
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  await sequelize.close();
});

test('1-3. country import builds country > state > city > area from the source', async () => {
  const { job, done } = await importer.startImport({ countryCode: 'IN', userId: u.admin.id }, fixtureSource());
  await done;
  await job.reload();
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  assert.equal(job.states_found, 2); // only IN.* admin1 rows
  assert.equal(job.cities_found, 3);
  assert.equal(job.areas_found, 1);
  assert.equal(job.imported, 1 + 2 + 4);

  const india = await byName('India');
  const gujarat = await byName('Gujarat');
  const ahmedabad = await byName('Ahmedabad');
  const area = await byName('Navrangpura');
  assert.equal(india.location_type, 'country');
  assert.equal(gujarat.parent_id, india.id);
  assert.equal(ahmedabad.parent_id, gujarat.id);
  assert.equal(area.location_type, 'area');
  assert.equal(area.parent_id, ahmedabad.id, 'area linked to its nearest city');
  assert.equal((await byName('Mumbai')).parent_id, (await byName('Maharashtra')).id);
  assert.equal(await byName('Los Angeles'), null, 'other countries are not imported');
  assert.equal(await byName('California'), null);
  assert.equal(Number(ahmedabad.latitude), 23.02579);
  assert.equal(ahmedabad.source_external_id, '1279233');
});

test('4. re-importing creates no duplicates and keeps admin deactivations', async () => {
  const before = await Location.count();
  await (await byName('Vadodara')).update({ is_active: false });
  const { job, done } = await importer.startImport({ countryCode: 'IN', userId: u.admin.id }, fixtureSource());
  await done;
  await job.reload();
  assert.equal(job.status, 'completed');
  assert.equal(await Location.count(), before);
  assert.equal(job.imported, 0);
  assert.equal(job.skipped_existing, 7);
  assert.equal(job.updated, 0, 'unchanged rows (incl. re-linked areas) are not counted as updates');
  assert.equal((await byName('Vadodara')).is_active, false);
  await (await byName('Vadodara')).update({ is_active: true });
});

test('5. an interrupted import fails with a checkpoint and resumes without duplicates', async () => {
  await Location.destroy({ where: {}, truncate: true });
  const src = fixtureSource({ failAfterPlaceLine: 3 });
  const { job, done } = await importer.startImport({ countryCode: 'IN', userId: u.admin.id }, src);
  await done;
  await job.reload();
  assert.equal(job.status, 'failed');
  assert.match(job.errors.at(-1).message, /connection reset/);
  assert.equal(job.stage, 'places');
  const resumed = await importer.resumeJob(job.id, src);
  await resumed.done;
  await job.reload();
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 2);
  assert.equal(await Location.count({ where: { country_code: 'IN' } }), 7);
  assert.equal(await Location.count({ where: { name: 'Ahmedabad' } }), 1);
  const failedAudit = await AuditLog.findOne({ where: { action: 'location.import_failed' } });
  assert.equal(failedAudit.actor_user_id, u.admin.id);
  assert.ok(await AuditLog.findOne({ where: { action: 'location.import_completed' } }));
});

test('6. GeoNames downloads are throttled and retried with backoff', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async () => {
    calls.push(Date.now());
    return { ok: false, status: 503 };
  };
  try {
    await assert.rejects(() => importer.listCountries({ ...importer.geonamesSource, countryLines: importer.geonamesSource.countryLines }), /503/);
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(calls.length >= 2, 'retried');
  for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i] - calls[i - 1] >= 1900, 'spaced >= 2s apart');
});

test('7. employees cannot create, edit, deactivate, delete or import locations (direct API)', async () => {
  const ahmedabad = await byName('Ahmedabad');
  for (const t of [tok.manager, tok.bde, tok.viewer]) {
    assert.equal((await call('POST', '/locations', t, { name: 'Fake', location_type: 'city', parent_id: ahmedabad.parent_id })).status, 403);
    assert.equal((await call('PATCH', `/locations/${ahmedabad.id}`, t, { latitude: 1, longitude: 1, search_radius_km: 50 })).status, 403);
    assert.equal((await call('PATCH', `/locations/${ahmedabad.id}`, t, { is_active: false })).status, 403);
    assert.equal((await call('DELETE', `/locations/${ahmedabad.id}`, t)).status, 403);
    assert.equal((await call('POST', '/locations/import', t, { country_code: 'IN' })).status, 403);
    assert.equal((await call('GET', '/locations/import-jobs', t)).status, 403);
  }
  const fresh = await byName('Ahmedabad');
  assert.equal(Number(fresh.latitude), 23.02579);
  assert.equal(fresh.is_active, true);
});

test('Main Admin manages locations; every change is audited', async () => {
  const gujarat = await byName('Gujarat');
  const created = await call('POST', '/locations', tok.admin, { name: 'GIFT City', location_type: 'area', parent_id: (await byName('Ahmedabad')).id, latitude: 23.16, longitude: 72.68, search_radius_km: 5 });
  assert.equal(created.status, 201);
  const id = created.body.data.location.id;
  assert.equal(created.body.data.location.country_code, 'IN');
  assert.equal((await call('POST', '/locations', tok.admin, { name: 'Bad', location_type: 'state', parent_id: (await byName('Ahmedabad')).id })).status, 400, 'hierarchy enforced');
  assert.equal((await call('PATCH', `/locations/${id}`, tok.admin, { latitude: 123 })).status, 400, 'coordinates validated');
  assert.equal((await call('PATCH', `/locations/${id}`, tok.admin, { search_radius_km: 8 })).status, 200);
  assert.equal((await call('DELETE', `/locations/${id}`, tok.admin)).body.data.deleted, true);
  const del = await call('DELETE', `/locations/${gujarat.id}`, tok.admin);
  assert.equal(del.body.data.deactivated, true, 'imported/parent locations are deactivated, not deleted');
  await (await byName('Gujarat')).update({ is_active: true });
  const actions = (await AuditLog.findAll({ where: { resource_type: 'location' } })).map((a) => a.action);
  for (const a of ['location.created', 'location.config_changed', 'location.deleted', 'location.deactivated']) assert.ok(actions.includes(a), a);
});

test('8. employees with discovery.run browse only active locations', async () => {
  await (await byName('Vadodara')).update({ is_active: false });
  const gujarat = await byName('Gujarat');
  const r = await call('GET', `/locations?parent_id=${gujarat.id}`, tok.manager);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.items.map((l) => l.name), ['Ahmedabad']);
  assert.equal((await call('GET', `/locations/${(await byName('Vadodara')).id}`, tok.manager)).status, 404);
  // BDEs and viewers have no discovery permission by default.
  assert.equal((await call('GET', '/locations', tok.bde)).status, 403);
  assert.equal((await call('GET', '/locations', tok.viewer)).status, 403);
  const s = await call('GET', '/locations?search=ahmed', tok.manager);
  assert.equal(s.body.data.items[0].name, 'Ahmedabad');
  assert.ok(await AuditLog.findOne({ where: { action: 'location.searched', actor_user_id: u.manager.id } }));
});

test('9. invalid, inactive or unauthorized locations are rejected for discovery', async () => {
  assert.equal((await call('POST', '/lead-discovery/run', tok.manager, { location_id: 999999, categories: ['hotels'] })).status, 400);
  assert.equal((await call('POST', '/lead-discovery/run', tok.manager, { location_id: (await byName('Vadodara')).id, categories: ['hotels'] })).status, 403);
  // Inactive ancestor blocks its children too.
  await (await byName('Gujarat')).update({ is_active: false });
  assert.equal((await call('POST', '/lead-discovery/run', tok.manager, { location_id: (await byName('Ahmedabad')).id, categories: ['hotels'] })).status, 403);
  await (await byName('Gujarat')).update({ is_active: true });
  assert.equal((await call('POST', '/lead-discovery/run', tok.bde, { location_id: (await byName('Ahmedabad')).id, categories: ['hotels'] })).status, 403);
  assert.equal((await call('POST', '/lead-discovery/run', tok.manager, { location_id: (await byName('Ahmedabad')).id, categories: ['not-a-category'] })).status, 400);
});

test('10. an authorized employee runs the existing discovery engine on an approved location', async () => {
  const opts = await call('GET', '/lead-discovery/options', tok.manager);
  assert.deepEqual(opts.body.data.providers.map((p) => p.status), ['NOT_CONFIGURED']);
  const area = await byName('Navrangpura');
  const r = await call('POST', '/lead-discovery/run', tok.manager, { location_id: area.id, categories: ['hotels'] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.location, 'Navrangpura, Ahmedabad, Gujarat, India');
  // Wait for the background run (no network: the only provider is unconfigured).
  for (let i = 0; i < 50 && !(await SearchRun.findOne({ where: { status: { [db.Sequelize.Op.ne]: 'running' } } })); i += 1) {
    await new Promise((res) => setTimeout(res, 100)); // eslint-disable-line no-await-in-loop
  }
  const run = await SearchRun.findOne({ order: [['id', 'DESC']] });
  assert.equal(run.triggered_by_user_id, u.manager.id);
  assert.deepEqual(run.locations, ['Navrangpura, Ahmedabad, Gujarat, India']);
  assert.equal(run.businesses_discovered, 0, 'nothing invented when no provider is configured');
  assert.match(JSON.stringify(run.errors), /not configured/);
  const runs = await call('GET', '/lead-discovery/runs', tok.manager);
  assert.equal(runs.body.data.runs[0].id, run.id);
  assert.equal((await call('GET', `/lead-discovery/runs/${run.id}/leads`, tok.bde)).status, 403);
  const actions = (await AuditLog.findAll({ where: { actor_user_id: u.manager.id } })).map((a) => a.action);
  assert.ok(actions.includes('discovery.location_selected'));
  assert.ok(actions.includes('discovery.started'));
});

test('11. existing CRM records are untouched by location work', async () => {
  assert.equal(await Company.count({ where: { company_name: 'Existing Co' } }), 1);
  const lead = await Lead.findOne();
  assert.equal(lead.assigned_user_id, u.bde.id);
});

test('only the Main Admin edits business categories', async () => {
  assert.equal((await call('POST', '/lead-discovery/categories', tok.manager, { name: 'Gyms' })).status, 403);
  const created = await call('POST', '/lead-discovery/categories', tok.admin, { name: 'Gyms', keyword: 'gym' });
  assert.equal(created.status, 201);
  await call('PATCH', `/lead-discovery/categories/${created.body.data.category.id}`, tok.admin, { is_enabled: false });
  const opts = await call('GET', '/lead-discovery/options', tok.manager);
  assert.ok(opts.body.data.categories.some((c) => c.key === 'hotels'));
  assert.ok(!opts.body.data.categories.some((c) => c.key === 'gyms'));
});
