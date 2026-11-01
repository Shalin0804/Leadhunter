const { DataTypes } = require('sequelize');

// A bulk send: one individually addressed EmailMessage per recipient. Counts are derived from the messages.
const STATUSES = ['DRAFT', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED'];

module.exports = (sequelize) => {
  const EmailCampaign = sequelize.define(
    'EmailCampaign',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'DRAFT' },
      status_note: { type: DataTypes.STRING(255), allowNull: true }, // e.g. why it paused
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'email_campaigns', indexes: [{ fields: ['status'] }] }
  );
  EmailCampaign.STATUSES = STATUSES;
  return EmailCampaign;
};
