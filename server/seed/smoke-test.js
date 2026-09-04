/**
 * End-to-end smoke test. Requires the API running (npm run dev) and a seeded DB.
 *   node seed/smoke-test.js  [baseUrl]
 * Exits non-zero on the first failed assertion.
 */
const base = process.argv[2] || `http://localhost:${process.env.PORT || 5000}/api`;
const admin = {
  email: process.env.ADMIN_EMAIL || 'admin@leadhunter.local',
  password: process.env.ADMIN_PASSWORD || 'Admin@123456',
};

let token;
let pass = 0;
let fail = 0;

const call = async (method, path, body, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  let payload = body;
  if (body && !(body instanceof URLSearchParams) && !opts.raw) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

const assert = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
};

async function run() {
  console.log(`Smoke test against ${base}\n`);

  let r = await call('GET', '/health');
  assert(r.status === 200 && r.json.data.status === 'ok', 'GET /health');

  r = await call('POST', '/auth/login', admin);
  assert(r.status === 200 && r.json.data.token, 'POST /auth/login returns token');
  token = r.json.data.token;

  r = await call('GET', '/auth/me');
  assert(r.status === 200 && r.json.data.user.email === admin.email.toLowerCase(), 'GET /auth/me');

  r = await call('GET', '/dashboard/stats');
  assert(r.status === 200 && typeof r.json.data.cards.totalCompanies === 'number', 'GET /dashboard/stats');
  const totalCompanies = r.json.data.cards.totalCompanies;

  r = await call('GET', '/dashboard/opportunities?limit=5');
  assert(r.status === 200 && Array.isArray(r.json.data.items), 'GET /dashboard/opportunities');

  // Create a fresh company (the DB may otherwise be empty on a clean install)
  const cin = `U72900MH2099PTC${Date.now().toString().slice(-6)}`;
  r = await call('POST', '/companies', {
    company_name: 'Smoke Test Ventures Pvt Ltd',
    cin,
    industry: 'Information Technology',
    state: 'Maharashtra',
    city: 'Pune',
    date_of_incorporation: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
  });
  assert(r.status === 201 && r.json.data.company.lead_score >= 0, 'POST /companies creates + scores');
  const newCompanyId = r.json.data.company.id;

  r = await call('GET', '/discovery/companies?limit=5&sort=lead_score&dir=desc');
  assert(r.status === 200 && r.json.data.items.length > 0, 'GET /discovery/companies (has data)');

  r = await call('GET', `/discovery/companies?date_preset=last_90_days&limit=5`);
  assert(r.status === 200, 'GET /discovery/companies with date filter');

  r = await call('GET', `/companies/${newCompanyId}`);
  assert(r.status === 200 && r.json.data.analysis && typeof r.json.data.analysis.score === 'number', 'GET /companies/:id includes analysis');

  r = await call('POST', '/leads', { company_id: newCompanyId, priority: 'HIGH' });
  assert(r.status === 201 && r.json.data.lead.status === 'NEW', 'POST /leads converts company');
  const leadId = r.json.data.lead.id;

  r = await call('PATCH', `/leads/${leadId}/status`, { status: 'QUALIFIED', note: 'smoke' });
  assert(r.status === 200 && r.json.data.lead.status === 'QUALIFIED', 'PATCH /leads/:id/status');

  r = await call('GET', `/leads/${leadId}`);
  assert(r.json.data.lead.statusHistory.length >= 2, 'lead status history recorded');

  // --- Contact tracking ---
  r = await call('PATCH', `/leads/${leadId}/contact`, { method: 'PHONE', note: 'Smoke: called owner' });
  assert(
    r.status === 200 && r.json.data.lead.contact_status === 'CONTACTED' && r.json.data.lead.contacted_at,
    'PATCH /leads/:id/contact sets CONTACTED + contacted_at'
  );

  r = await call('GET', `/leads?new_only=true&limit=100`);
  assert(r.status === 200 && !r.json.data.items.some((l) => l.id === leadId), 'contacted lead excluded from new_only=true');

  r = await call('PATCH', `/leads/${leadId}/contact-status`, { contact_status: 'REPLIED', note: 'Smoke: replied' });
  assert(r.status === 200 && r.json.data.lead.contact_status === 'REPLIED' && r.json.data.lead.status === 'REPLIED', 'PATCH contact-status syncs pipeline stage');

  r = await call('PATCH', `/leads/${leadId}/lead-status`, { lead_status: 'QUALIFIED' });
  assert(r.status === 200 && r.json.data.lead.lead_status === 'QUALIFIED', 'PATCH lead-status (independent of contact_status)');

  r = await call('POST', `/leads/${leadId}/recontact`, { contact_status: 'FOLLOW_UP' });
  assert(r.status === 200 && r.json.data.lead.contact_status === 'FOLLOW_UP', 'POST /leads/:id/recontact');

  r = await call('POST', '/outreach/generate', { company_id: newCompanyId, lead_id: leadId, channel: 'EMAIL' });
  assert(r.status === 201 && r.json.data.outreach.body?.length > 0, 'POST /outreach/generate produces a draft');

  r = await call('POST', '/notes', { lead_id: leadId, body: 'Smoke test note' });
  assert(r.status === 201, 'POST /notes');

  r = await call('POST', '/tasks', {
    lead_id: leadId,
    title: 'Smoke follow-up',
    due_date: new Date(Date.now() - 86400000).toISOString(),
    is_follow_up: true,
  });
  assert(r.status === 201, 'POST /tasks (overdue follow-up)');

  r = await call('GET', '/tasks?overdue=true&limit=100');
  assert(r.status === 200 && r.json.data.items.some((t) => t.title === 'Smoke follow-up'), 'GET /tasks?overdue=true');

  r = await call('GET', '/pipeline');
  assert(r.status === 200 && r.json.data.columns.length === 12, 'GET /pipeline has 12 stages');

  // --- Automation ---
  r = await call('GET', '/automation/settings');
  assert(r.status === 200 && Array.isArray(r.json.data.settings.locations), 'GET /automation/settings');

  r = await call('PUT', '/automation/settings', { locations: ['Smoke City'], industries: ['Smoke Industry'], dailyLeadLimit: 5 });
  assert(r.status === 200 && r.json.data.settings.dailyLeadLimit === 5, 'PUT /automation/settings persists');

  r = await call('GET', '/automation/runs?limit=5');
  assert(r.status === 200 && Array.isArray(r.json.data.items), 'GET /automation/runs (search history)');

  r = await call('GET', '/automation/api-usage');
  assert(r.status === 200 && Array.isArray(r.json.data.usage), 'GET /automation/api-usage');

  r = await call('POST', '/automation/run-scheduled', null, { headers: { 'x-automation-secret': 'wrong-secret' } });
  assert(r.status === 401 || r.status === 400, 'POST /automation/run-scheduled rejects a bad/missing secret');

  // --- Apollo (graceful when not configured) ---
  r = await call('GET', '/apollo/status');
  assert(r.status === 200 && typeof r.json.data.configured === 'boolean', 'GET /apollo/status');
  if (!r.json.data.configured) {
    r = await call('POST', '/apollo/search', { name: 'Acme' });
    assert(r.status === 400, 'POST /apollo/search fails gracefully when unconfigured');
  }

  // --- Buying signals ---
  r = await call('POST', '/signals', {
    company_name: 'Signal Test Co Pvt Ltd',
    service: 'CRM',
    source: 'linkedin',
    headline: 'Need a CRM',
    contact_email: 'owner@signaltestco.example',
  });
  assert(r.status === 201 && r.json.data.signal.company_id, 'POST /signals creates signal + company');
  const signalId = r.json.data.signal.id;
  const signalCompanyId = r.json.data.signal.company_id;

  r = await call('GET', `/companies/${signalCompanyId}`);
  assert(
    r.status === 200 && r.json.data.analysis.hasActiveSignal === true && r.json.data.analysis.score >= 35,
    'active signal boosts company score'
  );

  r = await call('GET', '/signals?service=CRM&status=NEW');
  assert(r.status === 200 && r.json.data.items.some((s) => s.id === signalId), 'GET /signals with filters');

  r = await call('GET', '/discovery/companies?has_signal=true&limit=50');
  assert(r.status === 200 && r.json.data.items.some((c) => c.id === signalCompanyId), 'discovery has_signal filter');

  r = await call('GET', '/signals/stats');
  assert(r.status === 200 && typeof r.json.data.active === 'number', 'GET /signals/stats');

  r = await call('POST', `/signals/${signalId}/convert`, { priority: 'HIGH' });
  assert(r.status === 200 && r.json.data.lead.company_id === signalCompanyId, 'POST /signals/:id/convert');
  const signalLeadId = r.json.data.lead.id;

  // signal CSV import
  const sigCsv = [
    'company_name,contact_email,service,source,headline',
    'CSV Signal Alpha Pvt Ltd,alpha-sig@example.com,Website Development,Instagram,Need a website',
    ',,,,',
  ].join('\n');
  const sfd = new FormData();
  sfd.append('file', new Blob([sigCsv], { type: 'text/csv' }), 'signals.csv');
  const sigRes = await fetch(base + '/imports/signals', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: sfd,
  });
  const sigJson = await sigRes.json();
  assert(sigRes.status === 201 && sigJson.data.import.imported_count >= 1, 'POST /imports/signals imports rows');

  await call('DELETE', `/leads/${signalLeadId}`);
  await call('DELETE', `/companies/${signalCompanyId}`);

  r = await call('GET', '/leads/export', null, { raw: true });
  assert(r.status === 200, 'GET /leads/export (CSV)');

  // CSV import
  const csv = [
    'company_name,cin,industry,state,city,date_of_incorporation,website,email,phone',
    `Imported Alpha Pvt Ltd,U72900KA2099PTC${Date.now().toString().slice(-6)},Software,Karnataka,Bengaluru,2025-08-01,,alpha@example.com,+91 80 1234 5678`,
    'Bad Row,,IT,,,not-a-date,,bad-email,',
  ].join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'smoke.csv');
  const importRes = await fetch(base + '/imports/companies', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const importJson = await importRes.json();
  assert(importRes.status === 201 && importJson.data.import.imported_count >= 1, 'POST /imports/companies imports rows');
  assert(importJson.data.import.invalid_count >= 1, 'import flags invalid rows');

  r = await call('DELETE', `/leads/${leadId}`);
  assert(r.status === 200, 'DELETE /leads/:id');
  r = await call('DELETE', `/companies/${newCompanyId}`);
  assert(r.status === 200, 'DELETE /companies/:id (cleanup)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
