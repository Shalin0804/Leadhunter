/**
 * Schema migration runner.
 *
 * Phase 1 uses Sequelize model synchronization as the migration mechanism:
 *   - creates the database if it does not exist
 *   - creates/updates every table from the models (non-destructive: `alter: true`)
 *
 * `npm run migrate` is safe to re-run and never drops data. Pass `--fresh` to
 * drop and recreate every table (development only).
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../config/config');
const { sequelize } = require('../models');

const FRESH = process.argv.includes('--fresh');

async function ensureDatabase() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await conn.end();
  // eslint-disable-next-line no-console
  console.log(`[migrate] database ready: ${config.db.name}`);
}

async function run() {
  await ensureDatabase();
  await sequelize.authenticate();

  const [tables] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = :schema`,
    { replacements: { schema: config.db.name } }
  );
  const isEmpty = Number(tables[0].n) === 0;

  if (FRESH) {
    console.log('[migrate] --fresh: dropping and recreating all tables');
    await sequelize.sync({ force: true });
  } else if (isEmpty) {
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
  // eslint-disable-next-line no-console
  console.error('[migrate] failed:', err);
  process.exit(1);
});
