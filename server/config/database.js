const { Sequelize } = require('sequelize');
const config = require('./config');

const common = {
  dialect: config.db.dialect,
  logging: false,
  define: {
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
    // TiDB defaults to utf8mb4_bin (case-sensitive); search relies on case-insensitive LIKE.
    collate: 'utf8mb4_general_ci',
    // Keep timestamp attributes snake_case too, so the whole API is consistent
    // (`created_at` / `updated_at`, not `createdAt`).
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
};

// Hosted Postgres (Supabase, Render, etc.) and TiDB Cloud require SSL.
// TiDB Cloud serves public-CA certificates, so the MySQL path verifies them.
let dialectOptions = {};
if (config.db.ssl) {
  dialectOptions =
    config.db.dialect === 'postgres'
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } };
}

let sequelize;
if (config.db.url) {
  sequelize = new Sequelize(config.db.url, { ...common, dialectOptions });
} else {
  sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
    ...common,
    host: config.db.host,
    port: config.db.port,
    dialectOptions,
  });
}

module.exports = sequelize;
