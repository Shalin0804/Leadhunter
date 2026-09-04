/**
 * Scratch helper for the production-readiness audit — not part of the app,
 * safe to delete. Logs in and runs whatever ad-hoc GET/POST/PUT the caller
 * passes via argv, so audit steps don't need messy inline shell auth.
 *   node seed/_audit-helper.js GET /automation/runs?limit=3
 *   node seed/_audit-helper.js POST /automation/settings '{"dailyLeadLimit":50}'  (PUT works too)
 */
const base = `http://localhost:${process.env.PORT || 5000}/api`;

async function main() {
  const [method, path, bodyStr] = process.argv.slice(2);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@leadhunter.local', password: 'Admin@123456' }),
  }).then((r) => r.json());
  const token = login.data.token;

  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: bodyStr,
  });
  const json = await res.json().catch(() => ({}));
  console.log(res.status, JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
