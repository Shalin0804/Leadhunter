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
- `npm --prefix server test` — smoke test against a running API + seeded DB
- `npm --prefix client run build`

## Rules
- Reuse existing models/services; never invent DB fields. Leads are companies (`Lead.belongsTo(Company)`); contacts, websites, signals, sources, notes are one-to-many off the company/lead.
- Don't change discovery, enrichment, scoring, dedup or automation behaviour from unrelated features.
- Responses use the `{ success, data | message }` envelope (`utils/http.js`, `utils/ApiError.js`).
- Don't run write tests against the `.env` database — it is the live one.
