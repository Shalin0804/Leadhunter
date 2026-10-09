/**
 * Self-check for the Explorium integration — no database, no real Explorium call.
 *   node seed/explorium-check.js
 *
 * Runs ExploriumProvider against a local stub that replays the request/response
 * shapes from Explorium's public docs. This proves OUR request building, error
 * classification and field mapping; it does NOT prove the live API behaves as
 * documented — that needs a real EXPLORIUM_API_KEY.
 */
const http = require('http');
const assert = require('assert');

const BUSINESS = {
  business_id: 'a'.repeat(32),
  name: 'Stub Hotels Pvt Ltd',
  domain: 'stub-hotels.example',
  website: 'https://stub-hotels.example',
  business_description: 'Stub record for the self-check.',
  country_name: 'india',
  region: 'gujarat',
  city_name: 'ahmedabad',
  number_of_employees_range: '11-50',
  yearly_revenue_range: '1M-5M',
  naics_description: 'Hotels (except Casino Hotels) and Motels',
  linkedin_profile: 'https://linkedin.com/company/stub-hotels',
};

const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = req.headers.api_key;
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? JSON.parse(body) : null });
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    if (key === 'slow') return undefined; // never answers -> client timeout
    if (key === 'bad') return send(401, { details: 'Partner ID is invalid.', correlation_id: 'c1' });
    if (key === 'nocredits') return send(403, { details: 'You have insufficient credits to perform this operation', correlation_id: 'c2' });
    if (key === 'limited') return send(429, { details: 'Rate limit exceeded' }, { 'retry-after': '7' });
    if (key === 'down') return send(503, { details: 'unavailable' });
    if (url.pathname === '/v1/credits') return send(200, { allocated_credits: 1000, remaining_credits: 964, account_type: 'paid' });
    if (url.pathname === '/v1/businesses/autocomplete') {
      const q = url.searchParams.get('query');
      if (q === 'zzz') return send(200, []);
      return send(200, [{ query: q, label: `Label ${q}`, value: `value-${q}` }]);
    }
    if (url.pathname === '/v1/businesses' && req.method === 'POST') {
      return send(200, { data: [BUSINESS, { business_id: 'b'.repeat(32), name: 'Bare Co' }], total_results: 120, total_pages: 5, page: 2, credit_usage: { total_results: 2, total_credits: 2 } });
    }
    return send(404, { details: 'not found' });
  });
});

const rejectsWith = async (promise, code) => {
  try {
    await promise;
  } catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`expected rejection with ${code}`);
};

stub.listen(0, '127.0.0.1', async () => {
  process.env.EXPLORIUM_API_KEY = 'good';
  process.env.EXPLORIUM_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
  process.env.EXPLORIUM_TIMEOUT_MS = '400';
  const config = require('../config/config');
  const ExploriumProvider = require('../providers/ExploriumProvider');
  const { sanitizeItem, duplicateReason } = require('../services/exploriumImportService');
  const p = new ExploriumProvider();
  let failed = false;

  try {
    // Connection / credits
    assert.deepStrictEqual(await p.getCredits(), { allocated: 1000, remaining: 964, accountType: 'paid' });
    assert.strictEqual(seen.at(-1).headers.api_key, 'good');

    // Search: filters, pagination, mapping
    const r = await p.searchBusinesses({ industry: 'Hospitality', city: 'Ahmedabad', state: 'Gujarat', country: 'India', companySize: '11-50', hasWebsite: true }, { page: 2, pageSize: 25 });
    const sent = seen.at(-1);
    assert.strictEqual(sent.path, '/v1/businesses');
    assert.strictEqual(sent.headers['credit-usage'], 'true');
    assert.deepStrictEqual(sent.body.filters, {
      linkedin_category: { values: ['value-Hospitality'] },
      city_region_country: { values: ['value-Ahmedabad'] }, // most specific location only
      company_size: { values: ['11-50'] },
      has_website: { value: true },
    });
    assert.strictEqual(sent.body.page, 2);
    assert.strictEqual(sent.body.page_size, 25);
    assert.strictEqual(sent.body.mode, 'full');
    assert.strictEqual(r.total, 120);
    assert.strictEqual(r.totalPages, 5);
    assert.strictEqual(r.creditsUsed, 2);
    assert.deepStrictEqual(r.resolved, { industry: ['Label Hospitality'], location: 'Label Ahmedabad' });
    assert.strictEqual(r.items[0].company_name, 'Stub Hotels Pvt Ltd');
    assert.strictEqual(r.items[0].external_id, 'a'.repeat(32));
    assert.strictEqual(r.items[0].email, null); // never invented
    assert.strictEqual(r.items[0].phone, null);
    assert.strictEqual(r.items[1].website, null); // missing fields stay null
    assert.strictEqual(r.items[1].industry, null);

    // Page size is clamped to the documented max
    await p.searchBusinesses({ name: 'x' }, { pageSize: 9999 });
    assert.strictEqual(seen.at(-1).body.page_size, 100);

    // Validation: no filters, unknown industry (must not silently broaden the search)
    await rejectsWith(p.searchBusinesses({}), 'BAD_REQUEST');
    const before = seen.length;
    await rejectsWith(p.searchBusinesses({ industry: 'zzz' }), 'BAD_REQUEST');
    assert.ok(!seen.slice(before).some((s) => s.path === '/v1/businesses'), 'no search sent for an unresolved filter');

    // Failure classification
    config.explorium.apiKey = 'bad';
    await rejectsWith(p.getCredits(), 'AUTH_FAILED');
    config.explorium.apiKey = 'nocredits';
    await rejectsWith(p.searchBusinesses({ name: 'x' }), 'USAGE_LIMIT');
    config.explorium.apiKey = 'limited';
    assert.strictEqual((await rejectsWith(p.getCredits(), 'RATE_LIMITED')).retryAfter, 7);
    config.explorium.apiKey = 'down';
    await rejectsWith(p.getCredits(), 'SERVICE_UNAVAILABLE');
    config.explorium.apiKey = 'slow';
    await rejectsWith(p.getCredits(), 'SERVICE_UNAVAILABLE'); // timeout
    config.explorium.apiKey = '';
    await rejectsWith(p.getCredits(), 'NOT_CONFIGURED');

    // Import input sanitizing + duplicate explanations (pure functions)
    const clean = sanitizeItem({ company_name: '  Acme  ', website: 'javascript:alert(1)', external_id: 'not-an-id', evil: 'x', city: 'x'.repeat(500) });
    assert.strictEqual(clean.company_name, 'Acme');
    assert.strictEqual(clean.website, null);
    assert.strictEqual(clean.external_id, null);
    assert.strictEqual(clean.evil, undefined);
    assert.strictEqual(clean.city.length, 80);
    assert.strictEqual(sanitizeItem({}).company_name, null);
    assert.match(duplicateReason({ normalized_domain: 'acme.in' }, { website: 'https://www.acme.in/x', company_name: 'Acme' }), /domain/);
    assert.match(duplicateReason({ normalized_name: 'acme', city: 'Surat' }, { company_name: 'Acme Pvt Ltd', city: 'surat' }), /name and city/);

    console.log('explorium-check: all assertions passed (stubbed API — not a live Explorium test)');
  } catch (err) {
    failed = true;
    console.error('explorium-check FAILED:', err.message);
  }
  stub.closeAllConnections();
  stub.close(() => process.exit(failed ? 1 : 0));
});
