const { DataTypes } = require('sequelize');

const LEAD_STATUSES = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

module.exports = (sequelize) => {
  const Lead = sequelize.define(
    'Lead',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      assigned_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      status: { type: DataTypes.ENUM(...LEAD_STATUSES), allowNull: false, defaultValue: 'NEW' },
      priority: { type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH'), allowNull: false, defaultValue: 'MEDIUM' },

      lead_score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lead_temperature: {
        type: DataTypes.ENUM('HOT', 'HIGH', 'WARM', 'LOW', 'NOT_QUALIFIED'),
        allowNull: false,
        defaultValue: 'NOT_QUALIFIED',
      },
      recommended_service: { type: DataTypes.STRING(160), allowNull: true },

      estimated_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
      next_follow_up_at: { type: DataTypes.DATE, allowNull: true },
      last_contacted_at: { type: DataTypes.DATE, allowNull: true },
      lost_reason: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: 'leads',
      indexes: [
        { fields: ['company_id'] },
        { fields: ['assigned_user_id'] },
        { fields: ['status'] },
        { fields: ['lead_score'] },
        { fields: ['lead_temperature'] },
        { fields: ['next_follow_up_at'] },
      ],
    }
  );

  Lead.STATUSES = LEAD_STATUSES;
  return Lead;
};

module.exports.LEAD_STATUSES = LEAD_STATUSES;
