/**
 * Schema migration runner.
 *
 * Phase 1 uses Sequelize model synchronization as the migration mechanism:
 *   - (MySQL, local) creates the database if it does not exist
 *   - (Postgres / hosted, e.g. Supabase) the database already exists — just sync
 *   - creates every table on an empty DB; applies non-destructive changes otherwise
 *
 * `npm run migrate` is safe to re-run and never drops data. Pass `--fresh` to
 * drop and recreate every table (development only).
 */
require('dotenv').config();
const config = require('../config/config');
const { sequelize } = require('../models');

const FRESH = process.argv.includes('--fresh');
const ALTER = process.argv.includes('--alter');
const NO_RLS = process.argv.includes('--no-rls');
const isPostgres = config.db.dialect === 'postgres';

// Only self-provision the database for a local MySQL server. Hosted providers
// give you the database up front and usually don't allow CREATE DATABASE.
async function ensureMysqlDatabase() {
  if (isPostgres || config.db.url) return;
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await conn.end();
  console.log(`[migrate] database ready: ${config.db.name}`);
}

async function countTables() {
  if (isPostgres) {
    const [rows] = await sequelize.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
    );
    return Number(rows[0].n);
  }
  // DATABASE() rather than config.db.name — with DATABASE_URL the name lives in the URL.
  const [rows] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  return Number(rows[0].n);
}

/**
 * One-time data remap ahead of the lead_temperature enum shrinking from
 * 5 values (HOT/HIGH/WARM/LOW/NOT_QUALIFIED) to 4 (HOT/WARM/MEDIUM/LOW) —
 * Postgres can't cast a row's existing value to an enum that no longer
 * contains it, so any HIGH/NOT_QUALIFIED rows must be remapped first.
 * Safe to run every time: a no-op once no rows hold the old values.
 */
async function remapLegacyTemperatureValues() {
  const tables = [
    { table: 'companies', column: 'lead_temperature' },
    { table: 'leads', column: 'lead_temperature' },
    { table: 'lead_scores', column: 'temperature' },
  ];
  for (const { table, column } of tables) {
    try {
      await sequelize.query(`UPDATE "${table}" SET "${column}" = 'WARM' WHERE "${column}" = 'HIGH'`);
      await sequelize.query(`UPDATE "${table}" SET "${column}" = 'LOW' WHERE "${column}" = 'NOT_QUALIFIED'`);
    } catch (err) {
      // Table/column/enum value doesn't exist yet (fresh DB, or already migrated) — fine.
      if (!/does not exist|invalid input value/i.test(err.message)) throw err;
    }
  }
}

/**
 * Employee-management / RBAC columns on the existing `users` table. Additive only:
 * every step checks first, so it's a no-op once applied. Needed explicitly because
 * plain sync() (the MySQL/TiDB default) never alters an existing table.
 * Existing users keep their role — no one is promoted.
 */
async function migrateUsersTable() {
  const qi = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');
  if (isPostgres) {
    // ADD VALUE can't run inside a transaction block; sequelize.query runs it standalone.
    await sequelize.query(`ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'viewer'`).catch((err) => {
      if (!/does not exist/i.test(err.message)) throw err;
    });
  }
  let cols;
  try {
    cols = await qi.describeTable('users');
  } catch {
    return; // fresh DB — sync() creates the full table
  }
  if (!isPostgres && cols.role && !/viewer/.test(cols.role.type)) {
    await qi.changeColumn('users', 'role', { type: DataTypes.ENUM('admin', 'manager', 'agent', 'viewer'), allowNull: false, defaultValue: 'agent' });
  }
  await ensureColumns('users', {
    last_activity_at: { type: DataTypes.DATE, allowNull: true },
    manager_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    password_changed_at: { type: DataTypes.DATE, allowNull: true },
    sessions_revoked_at: { type: DataTypes.DATE, allowNull: true },
    set_password_token_hash: { type: DataTypes.STRING(64), allowNull: true },
    set_password_expires_at: { type: DataTypes.DATE, allowNull: true },
  });
  console.log('[migrate] users table has RBAC columns (role incl. viewer, manager_id, session revocation, set-password token)');

  // Structured location data on search runs (historical rows stay null).
  await ensureColumns('search_runs', {
    location_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    country_code: { type: DataTypes.STRING(2), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    radius_km: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    business_category_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    discovery_job_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    search_params: { type: DataTypes.JSON, allowNull: true },
  });

  // locations.feature_code 10 -> 30 chars ("osm:neighbourhood"). Postgres gets this from sync alter;
  // MySQL/TiDB doesn't alter by default, so widen it explicitly (widening never loses data).
  if (!isPostgres) {
    const loc = await qi.describeTable('locations').catch(() => null);
    if (loc?.feature_code && /\(10\)/.test(loc.feature_code.type)) {
      await qi.changeColumn('locations', 'feature_code', { type: DataTypes.STRING(30), allowNull: true });
    }
  }
}

/**
 * Claude Code agent: outreach approval workflow + PROPOSAL channel. Additive only and
 * idempotent: existing outreach rows get status DRAFT (their current meaning) and keep
 * every value; the channel enum only gains a value at the end.
 */
async function migrateOutreachTable() {
  const qi = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');
  const { Outreach } = require('../models');
  if (isPostgres) {
    await sequelize.query(`ALTER TYPE "enum_outreach_channel" ADD VALUE IF NOT EXISTS 'PROPOSAL'`).catch((err) => {
      if (!/does not exist/i.test(err.message)) throw err;
    });
  }
  const cols = await qi.describeTable('outreach').catch(() => null);
  if (!cols) return; // fresh DB — sync() creates the full table
  if (!isPostgres && cols.channel && !/PROPOSAL/.test(cols.channel.type)) {
    await qi.changeColumn('outreach', 'channel', { type: DataTypes.ENUM(...Outreach.CHANNELS), allowNull: false });
  }
  await ensureColumns('outreach', {
    status: { type: DataTypes.ENUM(...Outreach.STATUSES), allowNull: false, defaultValue: 'DRAFT' },
    reviewed_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    review_note: { type: DataTypes.STRING(500), allowNull: true },
    agent_task_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  });
  console.log('[migrate] outreach table has approval columns (status, reviewed_by_user_id, reviewed_at, review_note, agent_task_id) and PROPOSAL channel');
}

/** Add any missing columns to an existing table (no-op for a table that doesn't exist yet). */
async function ensureColumns(table, defs) {
  const qi = sequelize.getQueryInterface();
  let cols;
  try {
    cols = await qi.describeTable(table);
  } catch {
    return;
  }
  for (const [name, def] of Object.entries(defs)) {
    // eslint-disable-next-line no-await-in-loop
    if (!cols[name]) await qi.addColumn(table, name, def);
  }
}

/**
 * Postgres: make audit_logs append-only at the database level. UPDATE is always
 * rejected; DELETE only inside a session that sets app.audit_purge = 'on'
 * (the retention job in services/auditService.js does exactly that).
 */
async function protectAuditLog() {
  if (!isPostgres) return;
  await sequelize.query(`
    CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'audit_logs is append-only';
    END;
    $$ LANGUAGE plpgsql;`);
  await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs"');
  await sequelize.query(
    'CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()'
  );
  console.log('[migrate] audit_logs append-only trigger installed');
}

/**
 * Supabase exposes every table in `public` through its auto-generated REST API to
 * holders of the project's anon/authenticated keys. LeadHunter never uses that path:
 * the browser only talks to this API, and this API connects with DATABASE_URL as the
 * tables' owner. Postgres exempts a table's owner (and BYPASSRLS roles) from RLS unless
 * FORCE is set, so enabling RLS with *no policies* denies the anon/authenticated roles
 * everything while leaving the API untouched.
 *
 * It is only applied when that exemption is provable for every table: the connected
 * role must own each one or have BYPASSRLS. Otherwise nothing is changed and a warning
 * says why. Pass --no-rls to skip. Re-run on every deploy so new tables are covered.
 */
async function enableRls() {
  if (!isPostgres || NO_RLS) return;
  const [[me]] = await sequelize.query('SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass');
  const [tables] = await sequelize.query("SELECT tablename, tableowner, rowsecurity FROM pg_tables WHERE schemaname = 'public'");
  const notOwned = tables.filter((t) => t.tableowner !== me.role);
  if (notOwned.length && !me.bypass) {
    console.warn(`[migrate] RLS NOT enabled: ${me.role} doesn't own ${notOwned.map((t) => t.tablename).join(', ')} and has no BYPASSRLS — enabling it could block the API`);
    return;
  }
  const todo = tables.filter((t) => !t.rowsecurity);
  for (const { tablename } of todo) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`ALTER TABLE "${tablename.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);
  }
  console.log(`[migrate] row level security on for all ${tables.length} public tables (${todo.length} newly enabled; ${me.role} is ${me.bypass ? 'BYPASSRLS' : 'the owner'}, so the API is exempt; no policies, so anon/authenticated get no access)`);
}

async function run() {
  await ensureMysqlDatabase();
  await sequelize.authenticate();
  console.log(`[migrate] connected (${config.db.dialect})`);

  const tableCount = await countTables();

  // Postgres-only: the remap exists for Postgres enum casting and uses "quoted" identifiers.
  if (isPostgres && tableCount > 0 && !FRESH) {
    await remapLegacyTemperatureValues();
    console.log('[migrate] legacy lead_temperature values remapped (HIGH->WARM, NOT_QUALIFIED->LOW)');
  }

  if (tableCount > 0 && !FRESH) {
    await migrateUsersTable();
    await migrateOutreachTable();
  }

  if (FRESH) {
    console.log('[migrate] --fresh: dropping and recreating all tables');
    await sequelize.sync({ force: true });
  } else if (tableCount === 0) {
    console.log('[migrate] empty database — creating all tables');
    await sequelize.sync();
  } else if (isPostgres || ALTER) {
    console.log('[migrate] existing database — applying non-destructive changes');
    await sequelize.sync({ alter: true });
  } else {
    // On MySQL/TiDB, repeated `alter: true` re-adds every `unique: true` index
    // (cin, cin_2, ...) until the 64-key limit — so it is opt-in there.
    console.log('[migrate] existing database — creating any new tables (pass --alter to change existing ones)');
    await sequelize.sync();
  }

  console.log('[migrate] all tables synchronized');
  await protectAuditLog();
  await enableRls();
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] failed:', err.message || err);
  process.exit(1);
});
