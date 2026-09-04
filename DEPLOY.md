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

## Environment variable reference

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Render | Supabase session-pooler/direct URI (port 5432) |
| `DB_SSL` | Render | `true` for Supabase |
| `JWT_SECRET` | Render | long random string |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Render | seeded/reset by `npm run seed` |
| `CLIENT_ORIGIN` | Render | comma-separated allowed browser origins |
| `ALLOW_VERCEL_PREVIEWS` | Render | `true` to allow `*.vercel.app` preview URLs |
| `VITE_API_URL` | Vercel | `https://<render-api>/api` |

## Redeploys & data

`npm run migrate` runs on every Render deploy and is **non-destructive** — it only
adds new tables/columns. Your Supabase data persists across API redeploys
(acceptance criterion #19). To wipe demo data later: `npm run seed -- --wipe`.
