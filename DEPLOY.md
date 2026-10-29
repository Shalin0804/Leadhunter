# Deploying LeadHunter CRM

Target stack: **Supabase** (Postgres) · **Render** (API) · **Vercel** (React SPA).

The app auto-detects Postgres when `DATABASE_URL` starts with `postgres` — no code
changes needed between local MySQL and hosted Postgres.

---

## 1. Supabase — database

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → Database → Connection string → URI.**
   Use the **Session pooler** (or **Direct connection**) string — port **5432**.
   Do **not** use the Transaction pooler (port 6543); Sequelize needs session-level
   connections.
3. Copy it — looks like:
   ```
   postgresql://postgres.abcdxyz:YOUR-PASSWORD@aws-0-xx.pooler.supabase.com:5432/postgres
   ```
4. That's it — the tables are created by `npm run migrate` on the Render deploy.

## 2. Render — API

### Option A: Blueprint (uses `render.yaml`)

1. Render dashboard → **New → Blueprint** → select this repo.
2. Render reads `render.yaml` and creates the `leadhunter-api` web service.
3. Fill the prompted secrets:
   | Env var | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase URI from step 1 |
   | `ADMIN_PASSWORD` | a strong admin password |
   | `CLIENT_ORIGIN` | your Vercel URL (set after step 3), e.g. `https://leadhunter.vercel.app` |
4. Deploy. Build runs `npm install && npm run migrate` (creates all tables on the
   empty Supabase DB), then `npm start`.

### Option B: manual web service

- **Root directory:** `server`
- **Build command:** `npm install && npm run migrate`
- **Start command:** `npm start`
- **Health check path:** `/api/health`
- **Environment:**
  ```
  NODE_ENV=production
  DATABASE_URL=<supabase session-pooler URI>
  DB_SSL=true
  JWT_SECRET=<random 64+ char string>
  ADMIN_EMAIL=admin@leadhunter.local
  ADMIN_PASSWORD=<strong password>
  CLIENT_ORIGIN=https://<your-vercel-app>.vercel.app
  ALLOW_VERCEL_PREVIEWS=true
  ```

### Seed demo data (optional, once)

Render → your service → **Shell**:
```
npm run seed
```
Or temporarily set the build command to `npm install && npm run migrate && npm run seed`
for one deploy, then revert.

Note your API URL: `https://leadhunter-api.onrender.com` (free instances sleep when
idle and take ~30s to wake on the first request).

## 3. Vercel — frontend

1. Vercel → **Add New → Project** → import this repo.
2. **Root Directory: `client`** (important — it's a monorepo). Vercel picks up
   `client/vercel.json` (framework = Vite, SPA rewrite included).
3. **Environment Variables:**
   | Name | Value |
   |---|---|
   | `VITE_API_URL` | `https://leadhunter-api.onrender.com/api` |
4. Deploy. Copy the resulting URL.
5. Back in **Render**, set `CLIENT_ORIGIN` to that Vercel URL and redeploy the API
   (so CORS allows the browser). Multiple origins: comma-separate them.

## 4. Verify

```
curl https://leadhunter-api.onrender.com/api/health
# {"success":true,"data":{"status":"ok", ...}}
```

Open the Vercel URL → log in with `admin@leadhunter.local` / your `ADMIN_PASSWORD`.

Run the smoke test against the live API from your machine:
```
cd server
node seed/smoke-test.js https://leadhunter-api.onrender.com/api
```

---

## 5. Automatic lead generation — scheduling on a free instance

Render's free tier sleeps after ~15 minutes idle. The in-process scheduler
(`node-cron`) only fires while the process is awake, so on a free instance a
saved "daily at 9am" schedule won't reliably run by itself. Fix: point an
external, free cron service at a secured endpoint that wakes the app and
kicks off the run.

1. In Render, set **`AUTOMATION_TRIGGER_SECRET`** to a long random string
   (the blueprint auto-generates one — check Environment tab for the value).
2. Pick one:
   - **cron-job.org** (simplest) — create a free account, add a job:
     - URL: `https://<your-render-app>.onrender.com/api/automation/run-scheduled`
     - Method: `POST`
     - Header: `X-Automation-Secret: <the secret from step 1>`
     - Schedule: however often you want it checked (e.g. every hour — the
       endpoint itself no-ops if a run is already in progress, so calling it
       more often than your configured frequency is harmless)
   - **GitHub Actions** (if you already have a repo) — a scheduled workflow:
     ```yaml
     name: trigger-leadhunter-automation
     on:
       schedule:
         - cron: '0 3 * * *' # 9:00 AM IST
       workflow_dispatch: {}
     jobs:
       trigger:
         runs-on: ubuntu-latest
         steps:
           - run: |
               curl -f -X POST "https://<your-render-app>.onrender.com/api/automation/run-scheduled" \
                 -H "X-Automation-Secret: ${{ secrets.AUTOMATION_TRIGGER_SECRET }}"
     ```
     (add `AUTOMATION_TRIGGER_SECRET` as a repo secret with the same value as Render's)
3. In the app, go to **Automatic Lead Gen → Automation Settings**, turn on
   **Enable Automatic Lead Generation**, set your locations/industries, and
   save. The external cron ping now drives the run regardless of whether
   Render's instance happened to be asleep.

If you upgrade to an always-on paid Render instance, the in-process scheduler
alone becomes reliable and the external ping is just a harmless backup.

## 6. Downtime and automation email alerts

Three independent pieces — set up all three:

| What you get emailed about | Who sends it | Works while backend is down/asleep? |
|---|---|---|
| Backend unreachable / back up | **UptimeRobot** (external) | yes |
| Backend started, or recovered after an unclean stop | backend (SMTP) | n/a — sent after boot |
| Automation run failed / recovered | backend (SMTP) | no — sent when the run ends |
| Automation overdue | backend, driven by **cron-job.org** heartbeat | yes — the cron call wakes it |

**a) SMTP (backend emails).** In Render → Environment set `ALERT_EMAIL_ENABLED=true`,
`ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS`. For Gmail use `smtp.gmail.com`, `465`, `true`, and a
Google **App Password** (needs 2-Step Verification). Redeploy, then check the log
line `[alerts] email alerts enabled`. Send a test as an admin:
`POST /api/automation/alerts/test` (logged-in JWT). `GET /api/automation/monitor`
shows the current automation status and whether alerts are configured.

**b) UptimeRobot (backend down).** uptimerobot.com → free account → New monitor:
- Type: HTTP(s); URL: `https://<your-render-app>.onrender.com/health`
- Interval: 5 minutes; Alert contact: your email (verify it).
UptimeRobot emails "Down" and "Up" itself.

Note: a 5-minute probe also keeps a free instance from idling to sleep. One
always-awake free service uses ~744 of Render's 750 free instance-hours/month —
fine for this one service, but a second free service would exhaust the quota.
Choose a longer interval (e.g. 30 min) if you'd rather let it sleep; the first
probe after sleep may then time out during cold start (~30-60s) and report a
short false "Down".

**c) cron-job.org heartbeat (automation overdue).** Add a second job next to the
run-scheduled one from section 5:
- URL: `https://<your-render-app>.onrender.com/api/automation/heartbeat`
- Method: `GET`; Header: `X-Automation-Secret: <AUTOMATION_TRIGGER_SECRET>`
- Schedule: every hour; enable "Notify me when execution fails".
It returns 200 for `ok` / `running` / `disabled` and **503 for `overdue`**, so
cron-job.org also emails you even if SMTP is broken. Overdue = automation enabled
and no successful run for `AUTOMATION_STALE_THRESHOLD_MINUTES` (default 25h).
Turning automation off in settings stops overdue alerts.

## 7. Employees, roles and the audit trail

There is **no public sign-up**. After the first deploy with this release:

1. Existing users keep their role (`admin` = Main Admin, `agent` = BDE). Nobody is promoted.
2. If you need a (new) Main Admin, run once from Render → Shell:
   `npm run create-admin -- --email you@company.com --name "Your Name"` — it prints a one-time set-password link (24h).
3. Invite employees from **Team → Team Management**. The invite link is emailed when SMTP (section 6) is configured; otherwise copy it from the dialog. Links are single-use; only their hash is stored.
4. Assign leads in **Team → Lead Assignment**. BDEs and Viewers see only leads assigned to them; managers see their own and their team's (set an employee's *Manager* in Team Management). Leads the automation creates stay unassigned until you assign them.
5. Contact values are masked for every role except Main Admin; employees click **Reveal**, and each reveal is logged (field names only, never the value).

Tracking starts at the first event after deploy — the Activity Log states that date and never back-fills history.

### Sessions
Login tokens are bearer JWTs kept in the browser's localStorage (never passwords). Every request re-reads the user, so
deactivation or a role change applies on the next request. **Sign out revokes the token on the server** (all of that
user's sessions end), as does a password reset. No cookies are used, so cross-site request forgery can't ride on an
ambient credential; the remaining risk is XSS, mitigated by React's escaping (no raw-HTML rendering anywhere) and the
Content-Security-Policy / X-Frame-Options / nosniff headers set in `client/vercel.json`. If the API is ever served from a
domain other than `*.onrender.com`, add it to `connect-src` in that CSP.

### Database access and Row Level Security
The browser never connects to the database — only the API does, with `DATABASE_URL`, and every API route checks the
user's permissions and record scope first.

* **Postgres / Supabase:** `npm run migrate` enables RLS (with no policies) on every `public` table, but only after it
  verifies that the connected role owns every table or has BYPASSRLS — those roles are exempt from RLS, so the API keeps
  working, while Supabase's `anon` / `authenticated` REST roles are denied everything. Supabase's `postgres` role (the
  normal `DATABASE_URL` user) owns the tables and has BYPASSRLS. If the check fails, nothing changes and the log says why.
  Disable with `npm run migrate -- --no-rls`. The migration also installs a trigger that makes `audit_logs` append-only
  (only the retention purge may delete).
* **MySQL / TiDB:** there is no RLS and no trigger; access control is entirely in the API, and `audit_logs` is
  append-only at the application level. Keep the database user's credentials private to the API.

**Unused Supabase project:** if production moved to TiDB but the old Supabase project still holds data, either delete
that project or run `npm run migrate` against it once (with its `DATABASE_URL`) to switch RLS on, so its REST API can't
read the old copies of leads and contacts.

### Before migrating production
Take a backup first: on Supabase, Database → Backups (or `pg_dump`); on TiDB Cloud, check that automatic backups are
on, or export with `mysqldump`/Dumpling. The migration is additive (new tables and nullable columns, one VARCHAR
widened) and re-runnable; it never drops or rewrites data.

## 8. Geographic locations and location-based discovery

**Location Management** (Main Admin) → pick a country and a coverage level → **Discover locations**. The server
downloads GeoNames (`countryInfo.txt`, `admin1CodesASCII.txt`, `citiesN.zip`; CC BY 4.0 — attribution required) and
imports country → states → towns above the chosen population → neighbourhoods where GeoNames has them. Runs in the
background, checkpoints every batch, resumes after a restart (or **Resume**), and never duplicates rows.

**Smaller places** (villages, suburbs, neighbourhoods): on a city row click **+ OSM**. One bounded OpenStreetMap
Overpass query (≤ 25 km around the city, same throttled mirrors as business discovery) adds named localities
(© OpenStreetMap contributors, ODbL — stored on each row). A place already present from GeoNames within 2 km under the
same name is skipped, never merged by name alone. Coverage depends on what OSM volunteers have mapped.

**Lead Discovery** (Main Admin and Managers) → approved location → up to 5 business categories → optional radius,
max leads, minimum score. A manager's run assigns the new leads to them. Each SearchRun stores the location id,
coordinates, radius, category and the exact parameters used.

Radius handling per provider (reported on every run): OpenStreetMap and Yelp filter natively (Yelp max 40 km); Serper
results are filtered afterwards by their coordinates; providers that return no coordinates (LeadIQ) can't honour a
radius and the run says so. Google Places is not used unless you configure it.

**Business Categories** (Main Admin): Lead Discovery → Business Categories. Name, search keyword, description,
industry group, priority, opportunity types, enabled/disabled.

**Scheduled Discovery** (Main Admin): location × category jobs with a frequency and max results. Jobs live in the
database. They run when the API checks every 15 minutes while awake, and on each external-cron call to
`/api/automation/run-scheduled` (section 5) — on a sleeping free instance they run late, not on the exact minute.
Runs never overlap; a job interrupted by a restart is re-queued after 2 h; failures back off. Free-text locations in
Automation Settings keep running unchanged; the page shows which of them map to location records.

**Duplicates:** a business is merged only on a strong match (website domain, phone, provider id, CIN, or same name in
the same city with no conflicting phone/website). Look-alikes are kept separate and listed on the Dashboard for review.

## Environment variable reference

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Render | Supabase session-pooler/direct URI (port 5432) |
| `DB_SSL` | Render | `true` for Supabase |
| `JWT_SECRET` | Render | long random string |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Render | seeded/reset by `npm run seed` |
| `CLIENT_ORIGIN` | Render | comma-separated allowed browser origins |
| `ALLOW_VERCEL_PREVIEWS` | Render | `true` to allow `*.vercel.app` preview URLs |
| `APOLLO_API_KEY` | Render | optional — live Apollo search/enrichment (needs a paid Apollo plan for search) |
| `GOOGLE_PLACES_API_KEY` | Render | optional — drop-in upgrade for automatic business discovery (default is free OpenStreetMap) |
| `AUTOMATION_TRIGGER_SECRET` | Render | required for the external cron trigger above |
| `HUNTER_API_KEY` | Render | optional — real email enrichment for qualified leads (free at hunter.io, 25 searches + 50 verifications/month) |
| `YELP_API_KEY` | Render | optional — additional business-discovery source (Yelp Fusion API); OSM keeps running if unset |
| `ENRICHMENT_MIN_SCORE` | Render | default `50` — lead score threshold for enrichment eligibility (see enrichmentService.isEligibleForEnrichment) |
| `ENRICHMENT_REFRESH_DAYS` | Render | default `30` — days before a company already enriched can be re-enriched |
| `SERPER_API_KEY` | Render | optional — Serper.dev Google Places discovery source |
| `ALERT_EMAIL_ENABLED` | Render | `true` to send alert emails (section 6); default off |
| `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` | Render | recipient / sender address |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Render | SMTP credentials (Gmail: App Password) |
| `ALERT_COOLDOWN_MINUTES` | Render | default `60` — min gap between two emails of the same type |
| `AUTOMATION_STALE_THRESHOLD_MINUTES` | Render | default `1500` — heartbeat reports overdue after this long without a successful run |
| `APP_URL` | Render | optional — frontend URL used in invite/reset links (defaults to the first `CLIENT_ORIGIN`) |
| `AUDIT_RETENTION_DAYS` | Render | optional — delete audit rows older than this (unset = keep forever) |
| `CONTACT_REVEAL_LIMIT_PER_HOUR` | Render | default `120` — per-employee contact reveals per hour |
| `DISPLAY_TIMEZONE` | Render | default `Asia/Kolkata` — timezone for activity-log dates |
| `GEONAMES_DATASET` | Render | default `cities1000` — default coverage when an import doesn't choose one |
| `LOCATION_IMPORT_BATCH` | Render | default `500` — rows per checkpointed batch |
| `DISCOVERY_JOBS_PER_TICK` | Render | default `3` — scheduled location jobs run per scheduler tick / cron call |
| `VITE_API_URL` | Vercel | `https://<render-api>/api` |

## Redeploys & data

`npm run migrate` runs on every Render deploy and is **non-destructive** — it only
adds new tables/columns. Your Supabase data persists across API redeploys
(acceptance criterion #19). To wipe demo data later: `npm run seed -- --wipe`.
