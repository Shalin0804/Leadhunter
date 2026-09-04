# LeadHunter CRM — Phase 1

**Discover New Businesses. Find Opportunities. Win Clients.**

A B2B lead-generation CRM focused on discovering recently registered / new companies
and converting them into qualified sales leads. Company discovery and new-company
intelligence are the core of the product — not a generic CRM.

- **Backend:** Node.js, Express, Sequelize, MySQL **or** Postgres, JWT auth
- **Frontend:** React + Vite, React Router, Axios, Recharts, Framer Motion
- **Data providers:** pluggable — Phase 1 ships a CSV provider; MCA / external-API
  providers are stubbed and future-ready.

> ⚠️ **Compliance:** This app does **not** scrape websites or social platforms,
> bypass CAPTCHAs, rate limits, robots rules or access controls. Company data comes
> from user-provided CSV imports (Phase 1) and, later, licensed / official datasets
> and APIs. **Buying signals** are captured only from channels you are permitted to
> use — inbound forms, referrals, event contacts, replies to your own posts, and
> official exports (LinkedIn Lead Gen Forms, Meta Lead Ads). It does not collect
> sensitive personal data and is designed for compliant B2B outreach.

## Automatic Lead Generation

Configure locations, industries, opportunities, a schedule and a daily lead
limit once (**Automatic Lead Gen** in the sidebar) and the backend keeps
discovering, scoring and qualifying new prospects on its own:

```
TARGET → SOURCE DISCOVERY (OpenStreetMap, free) → DEDUPLICATION
  → WEBSITE CHECK / ANALYSIS → OPPORTUNITY DETECTION → AI QUALIFICATION (rule-based)
  → SCORE → CONTACT-HISTORY CHECK → SAVE
```

- **Contact tracking is permanent and separate from lead qualification.**
  `lead_status` (NEW/QUALIFIED/UNQUALIFIED/ARCHIVED) and `contact_status`
  (NOT_CONTACTED → CONTACTED → … → WON/LOST/DO_NOT_CONTACT) are independent
  fields. Once a lead leaves `NOT_CONTACTED`, automation never re-surfaces it
  as new and never re-spends enrichment on it.
- **One company, one lead, many sources.** Rediscovering the same business —
  even from a different provider — updates `times_discovered` and adds a
  `lead_sources` row; it never creates a duplicate company or lead.
- **Nothing is contacted automatically.** `[Contact]`, `[Re-contact]`, and
  `[Generate outreach]` are all manual actions.
- **Cost control:** business discovery (OpenStreetMap) is free; a duplicate
  business without a lead yet only gets re-audited/re-scored once its last
  website check is more than 3 days old; the daily lead limit is enforced via
  `api_usage` before any new lead is saved.
- Search History (every run's location/industry/provider/counts) and API
  usage are both visible on the Automatic Lead Gen page.

See **[DEPLOY.md](DEPLOY.md)** for wiring up reliable scheduling (a free
Render instance sleeps when idle, so a scheduled run needs an external cron
ping — instructions included) and for the optional Google Places upgrade.

## Contact enrichment (Hunter.io)

**Rule-based lead scoring, not AI** — every score is a plain, auditable sum of
6 weighted categories (see below). No LLM is called anywhere in this pipeline.

Set `HUNTER_API_KEY` (free at [hunter.io](https://hunter.io) — 25 domain
searches + 50 verifications/month) to enable automatic email discovery for
**qualified leads only**:

```
Discover → Dedupe → Website check → Score
  → IF score >= enrichmentThreshold (default 60) → Hunter domain search
  → best candidate → Hunter email verifier → save
```

- Every enriched email carries `email_status` (`VERIFIED` only if Hunter's
  verifier endpoint actually ran and said so — never just assumed),
  `confidence`, and `source: 'hunter'`.
- Cost control: skipped entirely if the company already has a `VERIFIED`/`VALID`
  email, was enriched in the last 30 days, or has no website (no domain to
  search); capped at `maxEnrichmentsPerRun` per run.
- A failed enrichment never fails the whole run — it's recorded on the company
  (`enrichment_status`, `enrichment_error`) and the run continues.
- Without a key, the pipeline runs exactly the same but skips this step —
  `POST /api/companies/:id/enrich` returns a clear "Hunter.io is not
  configured" error rather than pretending to succeed.

### Lead scoring breakdown (max 100)

| Category | Max | Source |
|---|---|---|
| Website Opportunity | 20 | Live website audit (no website / outdated / poor / good / excellent) |
| Software Opportunity | 20 | Detected CRM/booking/appointment/e-commerce/custom-software opportunities |
| Business Growth | 15 | Real incorporation date or first-discovered recency |
| Buying Signal | 20 | An explicit ask (highest) or an auto-detected signal (below) |
| Contactability | 10 | Verified email + phone + website (10) down to nothing (0) |
| Codefloor Fit | 15 | Target industry + target location match |

Every company profile shows the full breakdown with the reason for each
category's points — nothing is a black box.

### Automatic signal detection

Distinct from the manually-logged "buying signals" (someone asked for work).
These are inferred only from data this app has actually collected — no
website, an outdated site, recent registration, an online-booking gap for a
hotel/restaurant/clinic, an e-commerce gap for a retailer, active social
presence. **Not implemented** (no reliable public data source available):
hiring signals, expansion/new-branch signals, new-product signals — these are
not fabricated.

## Apollo.io (live company search + enrichment)

Optional. Set `APOLLO_API_KEY` (Apollo → Settings → Integrations → API) in
`server/.env` to enable:

- **Search Apollo** on the Company Discovery page — live search of Apollo's
  company database by name / location / employee count; select results and
  import them as scored companies (1 Apollo credit per search).
- **Enrich from Apollo** on a company profile — looks up the company's website
  domain and fills in phone, industry, employee count, revenue, LinkedIn
  (1 credit if found, 0 if not).

Without a key, both features stay hidden — nothing else changes.
`server/providers/ApolloCompanyProvider.js` implements the same
`CompanyDataProvider` interface as the CSV provider, so swapping in another
enrichment vendor later is a new provider file, not a rewrite.

## Buying Signals

Track prospects who have **actively asked** for website / software / CRM work.
Each signal records the service wanted, the source (LinkedIn, Instagram, referral,
inbound form, event…), a link, and the request text. An active signal adds a large
boost to the company's lead score and sets the recommended service to what they
asked for. Signals can be logged one at a time or **imported from a CSV**
(`Buying Signals` tab on the CSV Import page — accepts lead-form exports).
Sample: `server/seed/sample-signals.csv`.

---

## 1. Prerequisites

| Tool  | Version |
|-------|---------|
| Node  | ≥ 18 (tested on 22) |
| MySQL | ≥ 8.0 |
| npm   | ≥ 9 |

## 2. Project layout

```
LeadHunter CRM/
├── client/   # React + Vite SPA
└── server/   # Express API, Sequelize models, providers, jobs, seed
```

## 3. Installation

```bash
# from the project root
cd server && npm install
cd ../client && npm install
```

## 4. Database creation

You do **not** need to create the schema by hand — `npm run migrate` creates the
database and all tables. You only need a MySQL user that can create a database
(or pre-create an empty `leadhunter` database and grant access to it).

```sql
-- optional: pre-create
CREATE DATABASE leadhunter CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## 5. Environment configuration

### Server — `server/.env` (copy from `server/.env.example`)

```
PORT=5000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=3306
DB_NAME=leadhunter
DB_USER=root
DB_PASSWORD=your_mysql_password
JWT_SECRET=replace-with-a-long-random-string
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=admin@leadhunter.local
ADMIN_PASSWORD=Admin@123456
ADMIN_NAME=LeadHunter Admin
CLIENT_ORIGIN=http://localhost:5173
```

### Client — `client/.env` (copy from `client/.env.example`)

```
VITE_API_URL=http://localhost:5000/api
```

In dev, Vite also proxies `/api` to `http://localhost:5000`, so the default works
out of the box.

## 6. Migration

```bash
cd server
npm run migrate          # creates the DB + all tables (safe to re-run, never drops data)
npm run migrate -- --fresh   # DROP + recreate every table (dev only)
```

Phase 1 uses Sequelize model synchronization as the migration mechanism. Because
`migrate` never drops tables (unless `--fresh`), **restarting the app keeps all
your data** (acceptance criterion #19).

## 7. Seed demo data

```bash
cd server
npm run seed             # admin user + 34 demo companies + ~18 leads + 8 buying signals + tasks/notes
npm run seed -- --wipe   # remove existing demo data first, then reseed
```

All seeded companies are flagged `is_demo = true` and show a **DEMO** badge in the UI.

## 8. Run

```bash
# terminal 1 — backend (nodemon)
cd server && npm run dev      # http://localhost:5000

# terminal 2 — frontend
cd client && npm run dev      # http://localhost:5173
```

## 9. Login credentials (development)

```
Email:    admin@leadhunter.local
Password: Admin@123456
```

Seeded team members (password `Agent@123456`): `riya@leadhunter.local`,
`arjun@leadhunter.local`, `neha@leadhunter.local`.

## 10. CSV import format

Upload via **CSV Import** in the app. Only `company_name` is required; unknown
columns are ignored and common header aliases are auto-detected
(`registration_date` → `date_of_incorporation`, `sector` → `industry`, etc.).

| Column | Notes |
|---|---|
| `company_name` | **required** |
| `cin` | unique when present; used for duplicate detection |
| `registration_number` | |
| `date_of_incorporation` | any parseable date (`YYYY-MM-DD` preferred) |
| `company_status` | e.g. `Active` |
| `company_type`, `company_category` | |
| `industry` | drives scoring + recommended service |
| `roc` | |
| `state`, `city` | drives location scoring + filters |
| `registered_address` | |
| `authorized_capital`, `paid_up_capital` | numbers (commas allowed) |
| `website` | absence adds +25 to the lead score |
| `email` | public business email |
| `phone` | business phone |

A ready-to-use sample is at **`server/seed/sample-companies.csv`**.

Import workflow: upload → validate columns → preview rows → detect duplicates →
show validation errors → confirm → insert/update + score → summary
(total / imported / updated / duplicates / invalid) with a downloadable error CSV.

## 11. Lead scoring

Rules live in **`server/services/scoringConfig.js`** (weights, target industries /
locations, temperature bands) — change them there, not in code.

| Signal | Points |
|---|---|
| Active buying signal (asked for a service) | +35 |
| Recently registered (≤ 180 days) | +20 |
| Target industry | +15 |
| Target location | +10 |
| No website | +25 |
| Poor / outdated website | +15 |
| Public business email | +5 |
| Business phone | +5 |
| Social presence | +5 |

Score is capped at 100. Temperature: `90–100 HOT`, `75–89 HIGH`, `50–74 WARM`,
`30–49 LOW`, `0–29 NOT_QUALIFIED`.

## 12. Recommended service

`server/services/recommendedService.js` maps company characteristics to a service
(No website → Website Development, Restaurant → Restaurant Website / Booking
System, IT → Corporate Website / Web Application, …). The result is stored with
each `lead_scores` row and shown on the company profile.

## 13. API overview

All responses use `{ "success": true, "data": {...} }` or
`{ "success": false, "message": "..." }`.

```
POST   /api/auth/login            GET /api/auth/me            POST /api/auth/logout
GET    /api/companies             GET/POST/PUT/DELETE /api/companies/:id
GET    /api/companies/export      POST /api/companies/:id/rescore
GET    /api/discovery/companies   GET /api/discovery/stats
GET    /api/leads                 GET/POST/PUT/DELETE /api/leads/:id
PATCH  /api/leads/:id/status      GET /api/leads/export
GET    /api/pipeline
GET/POST/PUT/DELETE /api/tasks
GET/POST/DELETE /api/notes
PATCH  /api/leads/:id/contact          PATCH /api/leads/:id/contact-status
PATCH  /api/leads/:id/lead-status      POST  /api/leads/:id/recontact
GET/PUT /api/automation/settings       POST  /api/automation/run-now
GET    /api/automation/runs            GET   /api/automation/runs/:id
GET    /api/automation/api-usage       POST  /api/automation/run-scheduled (external cron, secret-protected)
GET    /api/outreach                   POST  /api/outreach/generate
GET    /api/signals            GET/PATCH/DELETE /api/signals/:id
POST   /api/signals            POST /api/signals/:id/convert
GET    /api/signals/stats      GET /api/signals/export
POST   /api/imports/companies/preview   POST /api/imports/companies
POST   /api/imports/signals/preview     POST /api/imports/signals
GET    /api/imports              GET /api/imports/:id   GET /api/imports/:id/errors.csv
GET    /api/dashboard/stats      GET /api/dashboard/opportunities
GET    /api/users
```

## 14. Smoke test

With the API running and seeded:

```bash
cd server && npm test
```

Exercises login, dashboard stats, discovery + filters, company create/score,
lead conversion, status/contact-status/lead-status changes + history,
contact tracking (contact, new_only exclusion, recontact), outreach
generation, notes, overdue tasks, 12-stage pipeline, automation settings +
search history + API usage + the secured external-cron endpoint, buying
signals (create, score boost, filter, convert, CSV import), CSV import
(valid + invalid rows) and CSV export. 41 assertions.

## Deployment (Supabase + Render + Vercel)

See **[DEPLOY.md](DEPLOY.md)**. The app auto-detects Postgres when `DATABASE_URL`
starts with `postgres`, so no code changes are needed to move from local MySQL to
hosted Postgres. `render.yaml` and `client/vercel.json` are included.

## 15. Production build

```bash
cd client && npm run build      # outputs client/dist
cd client && npm run preview    # serve the build locally
```

Serve `client/dist` behind any static host and point `VITE_API_URL` at the
deployed API.

## 16. Data provider architecture

`server/providers/` defines `CompanyDataProvider` (interface: `searchCompanies`,
`getCompanyById`, `importCompanies`, `normalizeCompany`, `validateCompany`).
Implementations: `CsvCompanyProvider` (active), `MCAProvider` + `ApiCompanyProvider`
(stubbed, `isConfigured() === false`). Register new sources in
`server/providers/index.js`.

## 17. Future-ready (Phase 2/3)

Structured for — but not implementing — automated data sync, website scanning /
tech detection, email verification, contact enrichment, AI qualification /
summaries / outreach, email + WhatsApp + LinkedIn workflows, advanced analytics,
multi-org, subscriptions, billing, team permissions, white-label.
