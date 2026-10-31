const { DataTypes } = require('sequelize');

/**
 * Chronological feed of everything the Claude Code agent does (every MCP tool call,
 * task lifecycle step, connection change). High-volume operational log for the
 * AI Agent dashboard; security-relevant events also go to `audit_logs`.
 * Never stores contact values, passwords or tokens (metadata is scrubbed).
 */
module.exports = (sequelize) =>
  sequelize.define(
    'AgentActivity',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      type: { type: DataTypes.STRING(40), allowNull: false }, // tool_call, task_claimed, connected, ...
      tool: { type: DataTypes.STRING(60), allowNull: true },
      action: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'success' }, // success | failure | denied
      duration_ms: { type: DataTypes.INTEGER, allowNull: true },
      error: { type: DataTypes.STRING(1000), allowNull: true },
      task_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      session_id: { type: DataTypes.STRING(64), allowNull: true },
      metadata: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'agent_activity',
      updatedAt: false,
      indexes: [{ fields: ['created_at'] }, { fields: ['type'] }, { fields: ['status'] }, { fields: ['task_id'] }, { fields: ['lead_id'] }, { fields: ['company_id'] }],
    }
  );
