const { DataTypes } = require('sequelize');

/**
 * Persistent work queue for the Claude Code agent (services/agentService.js).
 * Claude Code pulls tasks over MCP; a task is claimed with a conditional UPDATE
 * (status PENDING -> RUNNING) so two sessions can never run the same one, and a
 * lease (lease_expires_at) returns a task to the queue if its session dies.
 * Separate from `tasks`, which are the CRM's human follow-up tasks.
 */
const MODES = ['research', 'lead_analyst', 'sales', 'strategy', 'competitor', 'reporting'];
const STATUSES = ['PENDING', 'RUNNING', 'PAUSED', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];

module.exports = (sequelize) => {
  const AgentTask = sequelize.define(
    'AgentTask',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      mode: { type: DataTypes.ENUM(...MODES), allowNull: false },
      type: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'PENDING' },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 }, // 1 = highest
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      input: { type: DataTypes.JSON, allowNull: true },
      result: { type: DataTypes.JSON, allowNull: true },
      error: { type: DataTypes.STRING(1000), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      available_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, // retry backoff
      claimed_by_session: { type: DataTypes.STRING(64), allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      duration_ms: { type: DataTypes.INTEGER, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Set only while the task is active (cleared when it finishes), so the unique
      // index blocks a duplicate *queued* task but allows the same work again later.
      dedupe_key: { type: DataTypes.STRING(191), allowNull: true, unique: true },
    },
    {
      tableName: 'agent_tasks',
      indexes: [{ fields: ['status', 'priority', 'available_at'] }, { fields: ['lead_id'] }, { fields: ['company_id'] }],
    }
  );

  AgentTask.MODES = MODES;
  AgentTask.STATUSES = STATUSES;
  return AgentTask;
};

module.exports.MODES = MODES;
module.exports.STATUSES = STATUSES;
