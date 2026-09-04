const { DataTypes } = require('sequelize');

/** One row per (provider, day). Used to enforce daily lead limits / provider quotas. */
module.exports = (sequelize) => {
  return sequelize.define(
    'ApiUsage',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      usage_date: { type: DataTypes.DATEONLY, allowNull: false },
      request_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      leads_created_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Provider-specific extra counters (e.g. Hunter: emails_found, emails_verified, failed_enrichments).
      metadata: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'api_usage',
      indexes: [{ unique: true, fields: ['provider', 'usage_date'] }],
    }
  );
};
