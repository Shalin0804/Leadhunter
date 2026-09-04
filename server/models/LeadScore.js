const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'LeadScore',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      temperature: {
        type: DataTypes.ENUM('HOT', 'WARM', 'MEDIUM', 'LOW'),
        allowNull: false,
        defaultValue: 'LOW',
      },
      opportunity_level: { type: DataTypes.STRING(30), allowNull: true },
      recommended_service: { type: DataTypes.STRING(160), allowNull: true },

      // JSON breakdown of contributing rules and missing assets
      breakdown: { type: DataTypes.JSON, allowNull: true },
      reasons: { type: DataTypes.JSON, allowNull: true },
      missing_assets: { type: DataTypes.JSON, allowNull: true },

      model_version: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'v1' },
    },
    {
      tableName: 'lead_scores',
      indexes: [{ fields: ['company_id'] }, { fields: ['lead_id'] }, { fields: ['score'] }],
    }
  );
};
