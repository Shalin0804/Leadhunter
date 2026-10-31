# LeadHunter CRM — agent guide

Project root (absolute): `D:\CF\Leads\LeadHunter CRM`

When calling the claude-code MCP tool, always pass absolute paths under this project root — the tool's working directory is Antigravity's install folder, not this project.

## Stack
- `server/` — Node + Express + Sequelize 6. Dialect from env: Postgres (`DATABASE_URL=postgres…`), MySQL/TiDB, or SQLite (tests only). JWT auth (`middleware/auth.js`); every `/api` route after `/auth` requires a token.
- `client/` — React 18 + Vite + axios. API calls live in `src/services/endpoints.js`.

## Commands
- `npm run install:all` — install server + client deps (root)
- `npm --prefix server run migrate` — create/sync tables (`--alter` to change existing ones on MySQL/TiDB)
- `npm --prefix server run dev` / `npm --prefix client run dev`
- `npm --prefix server run test:export` — Excel export tests (in-memory SQLite, never touches `.env`'s DB)
- `npm --prefix server run test:rbac` — roles, lead scoping, contact reveal, audit log, team performance (in-memory SQLite)
- `npm --prefix server run test:locations` — location management, GeoNames import (fixture, no network), location discovery
- `npm --prefix server run test:leadgen` — radius, structured search runs, dedup review, enrichment, categories, scheduled jobs, OSM localities, contacts, dashboard metrics, logout
- `npm --prefix server run test:agent` — Claude Code agent: admin-only access, agent token scope, heartbeat/connection status, task queue (claim race, retry, timeout), MCP stdio round-trip. `TEST_DB_URL=mysql://root@127.0.0.1:4000/lhtest` runs it on a throwaway TiDB (`docker run --rm -p 4000:4000 pingcap/tidb`)
- `npm --prefix server run test:all` — every suite
- `npm --prefix server run create-admin -- --email you@x.com --name "Name"` — create/promote a Main Admin; prints a one-time set-password link
- `npm --prefix server test` — smoke test against a running API + seeded DB
- `npm --prefix client run build`

## Rules
- Reuse existing models/services; never invent DB fields. Leads are companies (`Lead.belongsTo(Company)`); contacts, websites, signals, sources, notes are one-to-many off the company/lead.
- Don't change discovery, enrichment, scoring, dedup or automation behaviour from unrelated features.
- Responses use the `{ success, data | message }` envelope (`utils/http.js`, `utils/ApiError.js`).
- Don't run write tests against the `.env` database. Note: production (Render) may use a different database (TiDB) than `server/.env` (Supabase) — check before assuming either is "live".
- SQLite (tests) ignores VARCHAR lengths and some Postgres rules; before deploying schema/query changes, also run the suites against Postgres (see DEPLOY.md / embedded-postgres).
- RBAC: permissions live in `server/config/permissions.js` (roles admin = Main Admin, manager, agent = BDE, viewer). Every new route needs a `requirePermission(...)` guard, and any lead/company/task/note data must go through `services/accessService.js` (`leadScope`, `loadAccessibleLead`, `maskLead`) so employees only see their own/team's leads and contact values stay masked.
- Audit: record meaningful actions with `services/auditService.record(req, {...})` (append-only `audit_logs`; actor always from `req.user`). Never put contact values, passwords or tokens in metadata.
- Production (Render, branch `main`) runs on MySQL/TiDB (verified from the deploy log 2026-10-31), not Supabase. Render runs `npm run migrate` on every deploy, so merging to `main` applies schema changes.
- Claude Code agent: `.mcp.json` → `server/mcp/leadhunter-mcp.js` (stdio, uses the user's Claude Code login, never an Anthropic API key). It calls the REST API with an agent token (`lh_agent_…`, hash stored in `settings.agent.token`). That token acts as the issuing admin minus `permissions.AGENT_DENIED`, and only on `agentService.AGENT_ROUTES`; add a route there before an MCP tool can use it. Queue and state: `services/agentService.js` (`agent_tasks`, `agent_activity`, settings `agent.control` / `agent.heartbeat`). "Connected" is only ever derived from a real heartbeat.
- Locations (`locations`, `location_import_jobs`) are a separate geographic database from companies; discovery receives a validated location label via `controllers/leadDiscoveryController.js` → `discoveryOrchestrator.runForTarget`.
