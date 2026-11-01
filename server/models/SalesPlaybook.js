const { DataTypes } = require('sequelize');

/**
 * Claude Code's sales playbook for one lead: intelligence, sales angle, objection
 * handling, closing approach and follow-up schedule (`content`, validated by
 * services/salesService.js). Every generation is a new version, so history is kept;
 * an admin edit updates that version in place and is audited. The outreach messages
 * themselves are `outreach` rows (purpose + playbook_id) so they go through the
 * normal approval queue.
 */
const QUALITIES = ['high', 'medium', 'low', 'unknown'];

module.exports = (sequelize) => {
  const SalesPlaybook = sequelize.define(
    'SalesPlaybook',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      task_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      content: { type: DataTypes.JSON, allowNull: false },
      // Copied out of content for the dashboard: filtering JSON is not portable across MySQL/Postgres.
      lead_quality: { type: DataTypes.ENUM(...QUALITIES), allowNull: false, defaultValue: 'unknown' },
      next_step: { type: DataTypes.STRING(500), allowNull: true },
      confidence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      source_urls: { type: DataTypes.JSON, allowNull: true },
      session_id: { type: DataTypes.STRING(64), allowNull: true },
      edited_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      edited_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'sales_playbooks',
      indexes: [{ unique: true, fields: ['lead_id', 'version'] }, { fields: ['lead_quality'] }, { fields: ['created_at'] }],
    }
  );
  SalesPlaybook.QUALITIES = QUALITIES;
  return SalesPlaybook;
};
