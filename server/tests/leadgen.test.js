/**
 * Round-3 tests: radius enforcement, structured SearchRuns, uncertain-duplicate review,
 * enrichment never downgrading verified data, business categories, scheduled location
 * jobs, OSM localities, Contacts page scoping, evidence filters, dashboard metrics and
 * server-side logout. In-memory SQLite; provider HTTP is stubbed (no network).
 *   npm --prefix server run test:leadgen
 */
process.env.DATABASE_URL = '';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_HOST = ':memory:';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.YELP_API_KEY = 'test-yelp';
process.env.SERPER_API_KEY = 'test-serper';
process.env.AUTOMATION_TRIGGER_SECRET = 'cron-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const { signToken } = require('../middleware/auth');
const geo = require('../services/geoSearch');
const { runForTarget } = require('../services/discoveryOrchestrator');
const dedupe = require('../services/dedupeService');
const jobs = require('../services/discoveryJobService');
const { discoverLocalities } = require('../services/osmLocalityService');
const { withRunLock } = require('../jobs/automationScheduler');
const app = require('../app');

const { sequelize, User, Company, CompanyContact, CompanyWebsite, DetectedSignal, Lead, SearchRun, Location, BusinessCategory, DiscoveryJob, DuplicateReview, Setting, AuditLog } = db;

let server;
let base;
const u = {};
const tok = {};
const L = {};

const realFetch = global.fetch;
const providerCalls = [];
// Ahmedabad centre 23.0258, 72.5873. ~1.1 km and ~33 km away points.
const NEAR = { latitude: 23.035, longitude: 72.59 };
const FAR = { latitude: 23.3, longitude: 72.75 };
function stubProviders() {
  global.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    providerCalls.push({ href, body: opts?.body });
    if (href.includes('api.yelp.com')) {
      return {
        ok: true,
        json: async () => ({
          businesses: [
            { id: 'y-near', name: 'Near Hotel', phone: '+91 79 1111 1111', coordinates: NEAR, location: { city: 'Ahmedabad' } },
            { id: 'y-far', name: 'Far Hotel', phone: '+91 79 2222 2222', coordinates: FAR, location: { city: 'Gandhinagar' } },
            { id: 'y-nocoords', name: 'Unknown Spot Hotel', phone: '+91 79 3333 3333', location: { city: 'Ahmedabad' } },
          ],
        }),
      };
    }
    if (href.includes('serper.dev')) {
      return {
        ok: true,
        json: async () => ({
          places: [
            { title: 'Serper Near Cafe', cid: 's1', ...NEAR, phoneNumber: '+91 79 4444 4444' },
            { title: 'Serper Far Cafe', cid: 's2', ...FAR, phoneNumber: '+91 79 5555 5555' },
          ],
        }),
      };
    }
    throw new Error(`unexpected network call in test: ${href}`);
  };
}

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: res.status, body: json, text };
}

const settingsFor = (providers) => Setting.upsert({ key: 'automation_config', value: { discoveryProviders: providers, provider: providers[0], locations: ['Ahmedabad, Gujarat', 'Atlantis'], industries: ['hotels'], minLeadScore: 0, dailyLeadLimit: 500, autoSaveQualifiedLeads: true, autoAnalyzeWebsites: false, autoEnrichContacts: false, autoAIQualification: false } });

test.before(async () => {
  await sequelize.sync({ force: true });
  stubProviders();
  u.admin = await User.create({ name: 'Main Admin', email: 'a@t.local', password_hash: await User.hashPassword('Password123'), role: 'admin' });
  u.manager = await User.create({ name: 'Maya Manager', email: 'm@t.local', password_hash: 'x', role: 'manager' });
  u.bde = await User.create({ name: 'Rahul BDE', email: 'b@t.local', password_hash: 'x', role: 'agent' });
  u.bde2 = await User.create({ name: 'Priya BDE', email: 'p@t.local', password_hash: 'x', role: 'agent' });
  for (const k of Object.keys(u)) tok[k] = signToken(u[k]);

  L.india = await Location.create({ name: 'India', normalized_name: 'india', country_code: 'IN', location_type: 'country', source: 'geonames', source_external_id: '1269750' });
  L.gujarat = await Location.create({ name: 'Gujarat', normalized_name: 'gujarat', country_code: 'IN', location_type: 'state', parent_id: L.india.id, source: 'geonames', source_external_id: '1270770' });
  L.ahmedabad = await Location.create({ name: 'Ahmedabad', normalized_name: 'ahmedabad', country_code: 'IN', location_type: 'city', parent_id: L.gujarat.id, latitude: 23.02579, longitude: 72.58727, source: 'geonames', source_external_id: '1279233' });
  L.nocoords = await Location.create({ name: 'Nowhere', normalized_name: 'nowhere', country_code: 'IN', location_type: 'city', parent_id: L.gujarat.id, source: 'manual' });

  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  global.fetch = realFetch;
  server?.close();
  await sequelize.close();
});

/* ---------------- radius ---------------- */

test('geo validation rejects bad coordinates and radii', () => {
  assert.equal(geo.normalizeGeo({ latitude: 23, longitude: 72 }), null, 'no radius -> no geo filter');
  assert.throws(() => geo.normalizeGeo({ latitude: 23, longitude: 72, radiusKm: 0 }), /radius_km/);
  assert.throws(() => geo.normalizeGeo({ latitude: 23, longitude: 72, radiusKm: 101 }), /radius_km/);
  assert.throws(() => geo.normalizeGeo({ latitude: 91, longitude: 72, radiusKm: 5 }), /latitude/);
  assert.throws(() => geo.normalizeGeo({ latitude: 23, longitude: 181, radiusKm: 5 }), /longitude/);
  assert.throws(() => geo.normalizeGeo({ latitude: null, longitude: null, radiusKm: 5 }), /coordinates/);
  assert.deepEqual(geo.providerGeo('yelp', { latitude: 1, longitude: 2, radiusKm: 80 }).radiusKm, 40, 'clamped to Yelp max');
  assert.equal(geo.providerGeo('serper', { latitude: 1, longitude: 2, radiusKm: 5 }), null, 'post-filter providers get no radius param');
});

test('radius boundary: points exactly inside/outside are classified correctly', () => {
  const centre = { latitude: 23.02579, longitude: 72.58727, radiusKm: 10 };
  // 0.0898 deg latitude ~ 9.99 km; 0.0901 ~ 10.02 km
  const { kept, excluded, unverified } = geo.applyRadius(
    [{ lat: 23.02579 + 0.0898, lon: 72.58727 }, { lat: 23.02579 + 0.0902, lon: 72.58727 }, { lat: null, lon: null }],
    centre
  );
  assert.equal(kept.length, 2);
  assert.equal(excluded, 1);
  assert.equal(unverified, 1);
  assert.ok(Math.abs(geo.haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111.195) < 0.01);
});

test('Yelp gets a native radius; Serper is post-filtered; SearchRun stores structured location + report', async () => {
  await settingsFor(['yelp', 'serper']);
  const cat = await BusinessCategory.create({ key: 'hotels', name: 'Hotels', keyword: 'hotels' });
  providerCalls.length = 0;
  const run = await runForTarget({
    location: 'Ahmedabad, Gujarat, India',
    industry: 'hotels',
    discoveryProviders: ['yelp', 'serper'],
    minLeadScore: 0,
    dailyLimit: 500,
    triggeredBy: 'manual',
    triggeredByUserId: u.admin.id,
    settings: { autoSaveQualifiedLeads: true, autoAnalyzeWebsites: false, autoEnrichContacts: false, autoAIQualification: false, autoDetectBuyingSignals: false, minLeadScore: 0 },
    target: { locationId: L.ahmedabad.id, countryCode: 'IN', latitude: 23.02579, longitude: 72.58727, geo: geo.normalizeGeo({ latitude: 23.02579, longitude: 72.58727, radiusKm: 5 }), categoryId: cat.id, maxResults: 20 },
  });
  const yelpUrl = new URL(providerCalls.find((c) => c.href.includes('yelp')).href);
  assert.equal(yelpUrl.searchParams.get('radius'), '5000');
  assert.equal(yelpUrl.searchParams.get('latitude'), '23.02579');
  assert.equal(yelpUrl.searchParams.get('location'), null);
  await run.reload();
  assert.equal(run.status, 'completed', JSON.stringify(run.errors));
  assert.equal(run.location_id, L.ahmedabad.id);
  assert.equal(run.country_code, 'IN');
  assert.equal(Number(run.radius_km), 5);
  assert.equal(run.business_category_id, cat.id);
  const r = run.search_params.radius;
  assert.equal(r.yelp.mode, 'native');
  assert.equal(r.yelp.excluded_outside_radius, 1);
  assert.equal(r.yelp.without_coordinates, 1);
  assert.equal(r.yelp.enforced, false, 'not claimed enforced when a result had no coordinates');
  assert.equal(r.serper.mode, 'post_filter');
  assert.equal(r.serper.excluded_outside_radius, 1);
  assert.equal(r.serper.enforced, true);
  const names = (await Company.findAll()).map((c) => c.company_name).sort();
  assert.deepEqual(names, ['Near Hotel', 'Serper Near Cafe', 'Unknown Spot Hotel']);
});

test('historical / free-text runs keep null location fields', async () => {
  const run = await SearchRun.create({ triggered_by: 'manual', locations: ['Pune'], industries: ['hotels'], status: 'completed' });
  await run.reload();
  assert.equal(run.location_id, null);
  assert.equal(run.radius_km, null);
});

test('a radius run through the API needs coordinates; invalid radius is rejected', async () => {
  const cat = await BusinessCategory.findOne({ where: { key: 'hotels' } });
  assert.equal((await call('POST', '/lead-discovery/run', tok.admin, { location_id: L.nocoords.id, category_ids: [cat.id], radius_km: 5 })).status, 400);
  assert.equal((await call('POST', '/lead-discovery/run', tok.admin, { location_id: L.ahmedabad.id, category_ids: [cat.id], radius_km: 500 })).status, 400);
  assert.equal((await call('POST', '/lead-discovery/run', tok.admin, { location_id: L.ahmedabad.id, category_ids: [cat.id], max_results: 99 })).status, 400);
});

/* ---------------- dedup ---------------- */

test('same name in another city is NOT merged; it is flagged for review', async () => {
  const a = await Company.create({ company_name: 'Hotel Krishna', city: 'Pune', normalized_name: dedupe.normalizeName('Hotel Krishna'), source: 'csv' });
  const m = await dedupe.matchCompany({ companyName: 'Hotel Krishna', city: 'Surat' });
  assert.equal(m.certain, false);
  assert.equal(m.reason, 'name_only');
  assert.equal(await dedupe.findMatchingCompany({ companyName: 'Hotel Krishna', city: 'Surat' }), null);
  const { upsertBasicCompany } = require('../services/discoveryOrchestrator');
  const { company, created } = await upsertBasicCompany({ company_name: 'Hotel Krishna', city: 'Surat' }, { industry: 'hotels', providerKey: 'osm' });
  assert.equal(created, true);
  assert.notEqual(company.id, a.id);
  const review = await DuplicateReview.findOne({ where: { company_id: company.id } });
  assert.equal(review.candidate_company_id, a.id);
  // Same name + same city with a conflicting phone is also only flagged.
  await a.update({ normalized_phone: dedupe.normalizePhone('+91 20 1234 5678') });
  assert.equal((await dedupe.matchCompany({ companyName: 'Hotel Krishna', city: 'Pune', phone: '+91 20 9999 0000' })).reason, 'name_city_conflict');
  // ...while a clean name + city or a matching phone still merges.
  assert.equal((await dedupe.matchCompany({ companyName: 'Hotel Krishna', city: 'Pune' })).certain, true);
  assert.equal((await dedupe.matchCompany({ companyName: 'Other name', phone: '+91 20 1234 5678' })).company.id, a.id);
});

test('rediscovery never overwrites an employee status, owner or notes', async () => {
  const c = await Company.findOne({ where: { company_name: 'Near Hotel' } });
  const lead = await Lead.findOne({ where: { company_id: c.id } });
  await lead.update({ assigned_user_id: u.bde.id, contact_status: 'INTERESTED', status: 'INTERESTED', ever_contacted: true });
  const { upsertBasicCompany } = require('../services/discoveryOrchestrator');
  const again = await upsertBasicCompany({ company_name: 'Near Hotel', phone: '+91 79 1111 1111', city: 'Ahmedabad' }, { industry: 'hotels', providerKey: 'yelp' });
  assert.equal(again.created, false);
  await lead.reload();
  assert.equal(lead.assigned_user_id, u.bde.id);
  assert.equal(lead.contact_status, 'INTERESTED');
});

/* ---------------- enrichment ---------------- */

test('enrichment keeps a verifier verdict and known fields when a weaker pass runs', async () => {
  // (A VERIFIED/VALID email already makes enrichment skip the company — see shouldSkipEnrichment.)
  const enrichment = require('../services/enrichmentService');
  const { HunterProvider } = require('../providers');
  const c = await Company.create({ company_name: 'Verified Co', website: 'https://verified.example', normalized_domain: 'verified.example', has_website: true, source: 'csv', lead_score: 90 });
  await CompanyContact.create({ company_id: c.id, type: 'email', value: 'ceo@verified.example', verification_status: 'INVALID', confidence: 98, contact_name: 'Asha Mehta', job_title: 'CEO', source: 'hunter' });
  const proto = HunterProvider.prototype;
  const saved = { isConfigured: proto.isConfigured, domainSearch: proto.domainSearch, verifyEmail: proto.verifyEmail };
  proto.isConfigured = () => true;
  proto.domainSearch = async () => ({ emails: [{ email: 'ceo@verified.example', confidence: 60, domainVerificationStatus: 'accept_all', type: 'personal' }] });
  proto.verifyEmail = async () => {
    throw new Error('verifier down');
  };
  try {
    const result = await enrichment.enrichCompany(c.id, { providerKey: 'hunter', verify: true });
    assert.equal(result.status, 'success', `enrichment actually ran (got ${result.status}: ${result.reason})`);
  } finally {
    Object.assign(proto, saved);
  }
  const contact = await CompanyContact.findOne({ where: { company_id: c.id, type: 'email' } });
  assert.equal(contact.verification_status, 'INVALID', 'verifier verdict not replaced by a domain-search guess');
  assert.equal(contact.confidence, 98);
  assert.equal(contact.contact_name, 'Asha Mehta');
  assert.equal(contact.job_title, 'CEO');
});

/* ---------------- categories ---------------- */

test('Main Admin manages business categories; employees cannot', async () => {
  const list = await call('GET', '/lead-discovery/categories', tok.admin);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.categories.length >= 1);
  const created = await call('POST', '/lead-discovery/categories', tok.admin, { name: 'Coaching Institutes', keyword: 'education', description: 'Tuition and coaching', opportunity_types: ['WEBSITE', 'ADMIN_DASHBOARD'], priority: 5 });
  assert.equal(created.status, 201, created.text);
  const id = created.body.data.category.id;
  assert.equal((await call('POST', '/lead-discovery/categories', tok.admin, { name: 'Bad', opportunity_types: ['TELEPORT'] })).status, 400);
  assert.equal((await call('PATCH', `/lead-discovery/categories/${id}`, tok.admin, { is_enabled: false })).status, 200);
  for (const t of [tok.manager, tok.bde]) {
    assert.equal((await call('POST', '/lead-discovery/categories', t, { name: 'Sneaky' })).status, 403);
    assert.equal((await call('PATCH', `/lead-discovery/categories/${id}`, t, { is_enabled: true })).status, 403);
    assert.equal((await call('GET', '/lead-discovery/categories', t)).status, 403);
  }
  const opts = await call('GET', '/lead-discovery/options', tok.manager);
  assert.ok(!opts.body.data.categories.some((c) => c.id === id), 'disabled category hidden from discovery');
  assert.ok(await AuditLog.findOne({ where: { action: 'category.created' } }));
  assert.ok(await AuditLog.findOne({ where: { action: 'category.disabled' } }));
});

/* ---------------- scheduled location jobs ---------------- */

test('location jobs: create, prevent duplicates, run when due, record status', async () => {
  const cat = await BusinessCategory.findOne({ where: { key: 'hotels' } });
  const r = await call('POST', '/automation/location-jobs', tok.admin, { location_id: L.ahmedabad.id, business_category_id: cat.id, frequency: 'daily', max_results: 10, radius_km: 5 });
  assert.equal(r.status, 201, r.text);
  assert.equal((await call('POST', '/automation/location-jobs', tok.admin, { location_id: L.ahmedabad.id, business_category_id: cat.id })).status, 409);
  assert.equal((await call('POST', '/automation/location-jobs', tok.manager, { location_id: L.ahmedabad.id, business_category_id: cat.id })).status, 403);
  const before = await Company.count();
  const out = await withRunLock('scheduled', () => jobs.runDueJobs({ triggeredBy: 'scheduled' }));
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, 'completed');
  const job = await DiscoveryJob.findByPk(r.body.data.job.id);
  assert.equal(job.last_status, 'completed');
  assert.ok(job.next_run_at > new Date(Date.now() + 23 * 3600e3));
  const run = await SearchRun.findByPk(job.last_search_run_id);
  assert.equal(run.discovery_job_id, job.id);
  assert.equal(run.location_id, L.ahmedabad.id);
  assert.equal(await Company.count(), before, 'a repeat of the same target adds no duplicate companies');
  // Not due again -> nothing runs.
  assert.equal((await jobs.runDueJobs()).results.length, 0);
});

test('an interrupted job is re-queued; a failing job backs off', async () => {
  const job = await DiscoveryJob.findOne();
  await job.update({ running_since: new Date(Date.now() - 3 * 3600e3), next_run_at: new Date(Date.now() + 86400e3) });
  assert.equal(await jobs.requeueInterrupted(), 1);
  await job.reload();
  assert.equal(job.last_status, 'interrupted');
  assert.equal(job.running_since, null);
  // Deactivate the location -> next run fails cleanly and backs off instead of hammering.
  await L.ahmedabad.update({ is_active: false });
  const res = await jobs.runJob(job);
  assert.equal(res.status, 'failed');
  await job.reload();
  assert.equal(job.consecutive_failures, 1);
  assert.match(job.last_error, /not approved/);
  assert.ok(job.next_run_at > new Date(Date.now() + 10 * 60e3));
  await L.ahmedabad.update({ is_active: true });
  // A job already claimed is never run twice concurrently.
  await job.update({ running_since: new Date() });
  assert.equal((await jobs.runJob(job)).status, 'skipped');
  await job.update({ running_since: null });
});

test('external cron runs due location jobs; legacy free-text locations are mapped, not discarded', async () => {
  const legacy = await call('GET', '/automation/location-jobs/legacy', tok.admin);
  const byText = Object.fromEntries(legacy.body.data.locations.map((l) => [l.text, l]));
  assert.equal(byText['Ahmedabad, Gujarat'].status, 'resolved');
  assert.equal(byText['Ahmedabad, Gujarat'].match.id, L.ahmedabad.id);
  assert.equal(byText.Atlantis.status, 'unresolved');
  const settings = await Setting.findOne({ where: { key: 'automation_config' } });
  assert.deepEqual(settings.value.locations, ['Ahmedabad, Gujarat', 'Atlantis'], 'free-text config untouched');
  assert.equal((await call('POST', '/automation/run-scheduled', null)).status, 401);
});

/* ---------------- OSM localities ---------------- */

test('OSM localities: imported with attribution, deduped against existing places, idempotent', async () => {
  await Location.create({ name: 'Navrangpura', normalized_name: 'navrangpura', country_code: 'IN', location_type: 'area', parent_id: L.ahmedabad.id, latitude: 23.0365, longitude: 72.5611, source: 'geonames', source_external_id: '9999001' });
  const overpassFn = async (q) => {
    assert.match(q, /around:8000,23.02579,72.58727/);
    return {
      elements: [
        { type: 'node', id: 11, lat: 23.0366, lon: 72.5612, tags: { place: 'suburb', name: 'Navrangpura' } }, // same place as GeoNames row
        { type: 'node', id: 12, lat: 23.05, lon: 72.6, tags: { place: 'village', name: 'Kotarpur' } },
        { type: 'node', id: 13, lat: 23.0, lon: 72.55, tags: { place: 'neighbourhood', name: 'Paldi', 'name:en': 'Paldi' } },
        { type: 'node', id: 14, lat: 23.0, lon: 72.55, tags: { place: 'hamlet' } }, // unnamed -> ignored
      ],
    };
  };
  const first = await discoverLocalities(L.ahmedabad, { radiusKm: 8, overpassFn });
  assert.deepEqual({ found: first.found, imported: first.imported, matched: first.matched_other_source }, { found: 3, imported: 2, matched: 1 });
  const village = await Location.findOne({ where: { source: 'osm', source_external_id: 'node/12' } });
  assert.equal(village.parent_id, L.ahmedabad.id);
  assert.match(village.metadata.attribution, /OpenStreetMap/);
  const second = await discoverLocalities(L.ahmedabad, { radiusKm: 8, overpassFn });
  assert.equal(second.imported, 0);
  assert.equal(second.already_imported, 2);
  assert.equal((await call('POST', `/locations/${L.ahmedabad.id}/discover-localities`, tok.manager, {})).status, 403);
  await assert.rejects(() => discoverLocalities(L.nocoords, { overpassFn }), /no coordinates/);
});

/* ---------------- contacts page ---------------- */

test('Contacts page: scoped to accessible leads, masked, no value search for masked roles', async () => {
  const near = await Company.findOne({ where: { company_name: 'Near Hotel' } }); // lead owned by Rahul
  const other = await Company.findOne({ where: { company_name: 'Serper Near Cafe' } });
  await Lead.update({ assigned_user_id: u.bde2.id }, { where: { company_id: other.id } });
  const mine = await call('GET', '/contacts', tok.bde);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.items.length > 0);
  assert.ok(mine.body.data.items.every((c) => c.company.id === near.id), 'only contacts of own leads');
  assert.ok(mine.body.data.items.every((c) => c.value === null && c.value_masked));
  assert.ok(!mine.text.includes('1111 1111'));
  assert.equal((await call('GET', '/contacts?search=1111', tok.bde)).body.data.pagination.total, 0, 'cannot probe values');
  const admin = await call('GET', '/contacts?search=1111', tok.admin);
  assert.equal(admin.body.data.items[0].value, '+91 79 1111 1111');
  await CompanyContact.update({ verification_status: 'VERIFIED' }, { where: { value: 'ceo@verified.example' } });
  const verified = await call('GET', '/contacts?verification=verified', tok.admin);
  assert.equal(verified.body.data.items.length, 1);
  assert.ok(verified.body.data.items.every((c) => c.state === 'verified'));
});

/* ---------------- lead filters ---------------- */

test('evidence filters: website review, booking opportunity, verified email, high quality', async () => {
  const c = await Company.create({ company_name: 'Broken Site Resort', website: 'https://broken.example', has_website: true, source: 'csv' });
  await CompanyWebsite.create({ company_id: c.id, url: 'https://broken.example', status: 'broken', health: 'poor' });
  await DetectedSignal.create({ company_id: c.id, signal_type: 'ONLINE_BOOKING_GAP', signal_source: 'website_audit', signal_strength: 'HIGH', signal_description: 'No booking form on homepage' });
  const l = await Lead.create({ company_id: c.id, lead_score: 85 });
  const ids = async (qs) => (await call('GET', `/leads?limit=100&${qs}`, tok.admin)).body.data.items.map((x) => x.id);
  assert.deepEqual(await ids('website_review=true'), [l.id]);
  assert.deepEqual(await ids('opportunity=booking'), [l.id]);
  assert.ok((await ids('quality=high')).includes(l.id));
  const verifiedCo = await Company.findOne({ where: { company_name: 'Verified Co' } });
  const vl = await Lead.create({ company_id: verifiedCo.id });
  assert.deepEqual(await ids('verified_email=true'), [vl.id]);
  const detail = await call('GET', `/leads/${l.id}`, tok.admin);
  assert.ok('score_explanation' in detail.body.data);
});

/* ---------------- dashboard ---------------- */

test('lead-generation metrics match the stored records', async () => {
  const r = await call('GET', '/dashboard/lead-generation', tok.admin);
  assert.equal(r.status, 200, r.text);
  const t = r.body.data.totals;
  assert.equal(t.unique_businesses, await Company.count());
  assert.equal(t.leads, await Lead.count());
  assert.equal(t.contacted, await Lead.count({ where: { ever_contacted: true } }));
  assert.equal(t.assigned, await Lead.count({ where: { assigned_user_id: { [db.Sequelize.Op.ne]: null } } }));
  assert.equal(t.verified_email, 1);
  assert.equal(t.open_duplicate_reviews, await DuplicateReview.count({ where: { status: 'open' } }));
  assert.equal(r.body.data.discovery.runs, await SearchRun.count());
  assert.equal((await call('GET', '/dashboard/lead-generation', tok.manager)).status, 403);
  const dup = await DuplicateReview.findOne();
  assert.equal((await call('PATCH', `/dashboard/duplicates/${dup.id}`, tok.admin, { status: 'not_duplicate' })).status, 200);
  assert.equal((await call('PATCH', `/dashboard/duplicates/${dup.id}`, tok.bde, { status: 'confirmed' })).status, 403);
});

/* ---------------- sessions ---------------- */

test('logout revokes the token server-side; a fresh login works', async () => {
  const login = await call('POST', '/auth/login', null, { email: 'a@t.local', password: 'Password123' });
  const t = login.body.data.token;
  assert.equal((await call('GET', '/auth/me', t)).status, 200);
  assert.equal((await call('POST', '/auth/logout', t)).status, 200);
  assert.equal((await call('GET', '/auth/me', t)).status, 401, 'old token rejected after logout');
  const again = await call('POST', '/auth/login', null, { email: 'a@t.local', password: 'Password123' });
  assert.equal((await call('GET', '/auth/me', again.body.data.token)).status, 200);
});
