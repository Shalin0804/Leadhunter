const { DataTypes } = require('sequelize');

/** One country import from a geographic source. Checkpointed so it can resume after a restart. */
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

module.exports = (sequelize) => {
  const Job = sequelize.define(
    'LocationImportJob',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      country_code: { type: DataTypes.STRING(2), allowNull: false },
      country_name: { type: DataTypes.STRING(120), allowNull: true },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'geonames' },
      dataset: { type: DataTypes.STRING(40), allowNull: true }, // e.g. cities1000
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'queued' },
      stage: { type: DataTypes.STRING(40), allowNull: true }, // country | states | places | linking | done
      checkpoint: { type: DataTypes.JSON, allowNull: true }, // { stage, line } — resume point
      states_found: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cities_found: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      areas_found: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      imported: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updated: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      skipped_existing: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_records: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      errors: { type: DataTypes.JSON, allowNull: true }, // last few errors, bounded
      coverage_note: { type: DataTypes.STRING(500), allowNull: true },
      started_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      heartbeat_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'location_import_jobs', indexes: [{ fields: ['country_code'] }, { fields: ['status'] }] }
  );
  Job.STATUSES = STATUSES;
  return Job;
};
