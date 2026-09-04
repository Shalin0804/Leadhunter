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
  const [rows] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = :schema',
    { replacements: { schema: config.db.name } }
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

async function run() {
  await ensureMysqlDatabase();
  await sequelize.authenticate();
  console.log(`[migrate] connected (${config.db.dialect})`);

  const tableCount = await countTables();

  if (tableCount > 0 && !FRESH) {
    await remapLegacyTemperatureValues();
    console.log('[migrate] legacy lead_temperature values remapped (HIGH->WARM, NOT_QUALIFIED->LOW)');
  }

  if (FRESH) {
    console.log('[migrate] --fresh: dropping and recreating all tables');
    await sequelize.sync({ force: true });
  } else if (tableCount === 0) {
    console.log('[migrate] empty database — creating all tables');
    await sequelize.sync();
  } else {
    console.log('[migrate] existing database — applying non-destructive changes');
    await sequelize.sync({ alter: true });
  }

  console.log('[migrate] all tables synchronized');
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] failed:', err.message || err);
  process.exit(1);
});
