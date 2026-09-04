const { DataTypes } = require('sequelize');

const TRIGGERS = ['scheduled', 'manual', 'external'];
const RUN_STATUSES = ['running', 'completed', 'failed'];

module.exports = (sequelize) => {
  const SearchRun = sequelize.define(
    'SearchRun',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      triggered_by: { type: DataTypes.ENUM(...TRIGGERS), allowNull: false, defaultValue: 'manual' },
      triggered_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      status: { type: DataTypes.ENUM(...RUN_STATUSES), allowNull: false, defaultValue: 'running' },

      // Target snapshot for this run (a run may cover several location x industry pairs).
      locations: { type: DataTypes.JSON, allowNull: true },
      industries: { type: DataTypes.JSON, allowNull: true },
      opportunities: { type: DataTypes.JSON, allowNull: true },
      provider: { type: DataTypes.STRING(40), allowNull: true },

      started_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      finished_at: { type: DataTypes.DATE, allowNull: true },

      businesses_discovered: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      duplicates_skipped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      already_contacted_skipped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      qualified_leads: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      hot_leads: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      api_calls_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

      error_message: { type: DataTypes.TEXT, allowNull: true },
      summary: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'search_runs',
      indexes: [{ fields: ['status'] }, { fields: ['started_at'] }],
    }
  );

  SearchRun.TRIGGERS = TRIGGERS;
  SearchRun.RUN_STATUSES = RUN_STATUSES;
  return SearchRun;
};

module.exports.TRIGGERS = TRIGGERS;
module.exports.RUN_STATUSES = RUN_STATUSES;
