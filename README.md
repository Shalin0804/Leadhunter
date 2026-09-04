# LeadHunter CRM — Phase 1

**Discover New Businesses. Find Opportunities. Win Clients.**

A B2B lead-generation CRM focused on discovering recently registered / new companies
and converting them into qualified sales leads. Company discovery and new-company
intelligence are the core of the product — not a generic CRM.

- **Backend:** Node.js, Express, Sequelize, MySQL, JWT auth
- **Frontend:** React + Vite, React Router, Axios, Recharts, Framer Motion
- **Data providers:** pluggable — Phase 1 ships a CSV provider; MCA / external-API
  providers are stubbed and future-ready.

> ⚠️ **Compliance:** This app does **not** scrape websites, bypass CAPTCHAs, rate
> limits, robots rules or access controls. Company data comes from user-provided
> CSV imports (Phase 1) and, later, licensed / official datasets and APIs. It does
> not collect sensitive personal data and is designed for compliant B2B outreach.

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
npm run seed             # admin user + 34 demo companies + ~18 leads + tasks/notes
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
POST   /api/imports/companies/preview   POST /api/imports/companies
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
lead conversion, status changes + history, notes, overdue tasks, pipeline,
CSV import (valid + invalid rows) and CSV export.

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
