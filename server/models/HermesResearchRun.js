const { DataTypes } = require('sequelize');

/**
 * One invocation of the Hermes Agent research pipeline for a company — the
 * queue/status record (see server/jobs/hermesResearchWorker.js and
 * server/services/hermes/hermesResearchService.js). A company can have many
 * runs over time ("Research Again"); the latest one is what the dashboard
 * shows.
 */
const STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRY'];
const TRIGGER_SOURCES = ['manual', 'bulk', 'automation'];

module.exports = (sequelize) => {
  const HermesResearchRun = sequelize.define(
    'HermesResearchRun',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'PENDING' },
      hermes_run_id: { type: DataTypes.STRING(120), allowNull: true }, // the gateway's own /v1/runs id
      triggered_by: { type: DataTypes.ENUM(...TRIGGER_SOURCES), allowNull: false, defaultValue: 'manual' },
      triggered_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      duration_ms: { type: DataTypes.INTEGER, allowNull: true },

      sources_checked: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      fields_found: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      confidence: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, overall run confidence
      lead_quality_score: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, Hermes's own lead_quality.score

      retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: DataTypes.STRING(1000), allowNull: true },
      research_summary: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: 'hermes_research_runs',
      indexes: [{ fields: ['company_id'] }, { fields: ['status'] }],
    }
  );

  HermesResearchRun.STATUSES = STATUSES;
  HermesResearchRun.TRIGGER_SOURCES = TRIGGER_SOURCES;
  return HermesResearchRun;
};

module.exports.STATUSES = STATUSES;
module.exports.TRIGGER_SOURCES = TRIGGER_SOURCES;
