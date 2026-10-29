const { DataTypes } = require('sequelize');

/**
 * A scheduled business-discovery target: one approved location x one business category.
 * Persisted (not in memory), so a sleeping/restarted host just picks up due jobs on the
 * next scheduler tick or external-cron call. Unique per (location, category).
 */
const FREQUENCIES = ['every_6h', 'every_12h', 'daily', 'weekly'];

module.exports = (sequelize) => {
  const Job = sequelize.define(
    'DiscoveryJob',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      location_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      business_category_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      frequency: { type: DataTypes.ENUM(...FREQUENCIES), allowNull: false, defaultValue: 'daily' },
      max_results: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 25 },
      radius_km: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      next_run_at: { type: DataTypes.DATE, allowNull: true },
      last_run_at: { type: DataTypes.DATE, allowNull: true },
      last_status: { type: DataTypes.STRING(20), allowNull: true }, // completed | failed | interrupted
      last_error: { type: DataTypes.STRING(500), allowNull: true },
      last_search_run_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      running_since: { type: DataTypes.DATE, allowNull: true },
      consecutive_failures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'discovery_jobs',
      indexes: [{ unique: true, fields: ['location_id', 'business_category_id'] }, { fields: ['is_enabled', 'next_run_at'] }],
    }
  );
  Job.FREQUENCIES = FREQUENCIES;
  Job.INTERVAL_MS = { every_6h: 6 * 3600e3, every_12h: 12 * 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
  return Job;
};
