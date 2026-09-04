const { DataTypes } = require('sequelize');

const CHANNELS = ['EMAIL', 'WHATSAPP', 'LINKEDIN', 'PHONE_TALKING_POINTS', 'FOLLOW_UP'];

module.exports = (sequelize) => {
  const Outreach = sequelize.define(
    'Outreach',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
      subject: { type: DataTypes.STRING(255), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: false },
      // The concrete, real facts the message text was built from — never fabricated.
      evidence: { type: DataTypes.JSON, allowNull: true },
      generated_by: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'rule_based' },
    },
    {
      tableName: 'outreach',
      indexes: [{ fields: ['lead_id'] }, { fields: ['company_id'] }],
    }
  );

  Outreach.CHANNELS = CHANNELS;
  return Outreach;
};

module.exports.CHANNELS = CHANNELS;
