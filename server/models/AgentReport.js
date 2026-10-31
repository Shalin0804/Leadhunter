const { DataTypes } = require('sequelize');

/**
 * A report written by the Claude Code agent: company research, lead qualification,
 * strategy, competitor intelligence, or a daily/weekly/prospecting report.
 * `content` holds the structured sections (overview, software needs, website
 * observations, public business contacts, opportunities, qualification, next action);
 * every web fact should be traceable to `source_urls`. Admin-only (agent.manage).
 * `ai_score` is Claude's own 0-100 view of a lead — it never overwrites the
 * rule-based score in `lead_scores` / `leads.lead_score`.
 */
const KINDS = ['company_research', 'lead_qualification', 'strategy', 'competitor', 'daily', 'weekly', 'prospecting'];

module.exports = (sequelize) => {
  const AgentReport = sequelize.define(
    'AgentReport',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      kind: { type: DataTypes.ENUM(...KINDS), allowNull: false },
      task_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      summary: { type: DataTypes.TEXT, allowNull: true },
      content: { type: DataTypes.JSON, allowNull: true },
      source_urls: { type: DataTypes.JSON, allowNull: true },
      confidence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 0-100
      ai_score: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, lead_qualification only
      session_id: { type: DataTypes.STRING(64), allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'agent_reports',
      indexes: [{ fields: ['kind'] }, { fields: ['company_id'] }, { fields: ['lead_id'] }, { fields: ['task_id'] }, { fields: ['created_at'] }],
    }
  );
  AgentReport.KINDS = KINDS;
  return AgentReport;
};

module.exports.KINDS = KINDS;
