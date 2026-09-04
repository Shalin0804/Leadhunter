/**
 * Real end-to-end target-mode test against the running local server + live
 * Supabase DB — Ahmedabad+Hotels then Ahmedabad+Restaurants, as required by
 * the Prospecting Engine 2.0 spec. No mock data: this hits the real OSM
 * discovery provider, real website audits, and (if HUNTER_API_KEY is set)
 * real Hunter.io enrichment.
 *
 *   node seed/real-target-test.js [location] [industry] [location2] [industry2]
 */
const base = process.argv[6] || `http://localhost:${process.env.PORT || 5000}/api`;
const targets = [
  { location: process.argv[2] || 'Ahmedabad', industry: process.argv[3] || 'Hotels' },
  { location: process.argv[4] || 'Ahmedabad', industry: process.argv[5] || 'Restaurants' },
];

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitForCompletion(token, sinceRunId, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const { json } = await call('GET', '/automation/runs?limit=5', null, token);
    const run = json.data.items.find((r) => r.id > sinceRunId);
    if (run && run.status !== 'running') return run;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for run to complete');
}

async function latestRunId(token) {
  const { json } = await call('GET', '/automation/runs?limit=1', null, token);
  return json.data.items[0]?.id || 0;
}

async function run() {
  const login = await call('POST', '/auth/login', {
    email: process.env.ADMIN_EMAIL || 'admin@leadhunter.local',
    password: process.env.ADMIN_PASSWORD || 'Admin@123456',
  });
  const token = login.json.data.token;
  console.log(`Logged in. Base: ${base}\n`);

  for (const [i, target] of targets.entries()) {
    console.log(`=== TEST ${String.fromCharCode(65 + i)}: ${target.location} + ${target.industry} ===`);
    const before = await latestRunId(token);
    const started = await call('POST', '/automation/run-now', target, token);
    console.log('Trigger response:', started.status, JSON.stringify(started.json.data || started.json));

    // eslint-disable-next-line no-await-in-loop
    const finalRun = await waitForCompletion(token, before);
    console.log('Run result:', JSON.stringify(finalRun, null, 2));
    console.log('');
  }

  console.log('Done.');
}

run().catch((e) => {
  console.error('real-target-test failed:', e);
  process.exit(1);
});
