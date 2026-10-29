const { DataTypes } = require('sequelize');

const EXPORT_STATUSES = ['SUCCESS', 'FAILED'];

/**
 * Audit trail for Excel lead exports — metadata only (who, when, which filters,
 * how many rows). Never stores the exported personal data itself.
 */
module.exports = (sequelize) => {
  const LeadExport = sequelize.define(
    'LeadExport',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      date_field: { type: DataTypes.STRING(40), allowNull: true },
      date_from: { type: DataTypes.STRING(10), allowNull: true }, // YYYY-MM-DD as the user picked it
      date_to: { type: DataTypes.STRING(10), allowNull: true },
      timezone: { type: DataTypes.STRING(60), allowNull: true },
      filters: { type: DataTypes.JSON, allowNull: true },
      columns: { type: DataTypes.JSON, allowNull: true },
      row_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.ENUM(...EXPORT_STATUSES), allowNull: false },
      error_message: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      tableName: 'lead_exports',
      indexes: [{ fields: ['user_id'] }, { fields: ['created_at'] }],
    }
  );

  LeadExport.STATUSES = EXPORT_STATUSES;
  return LeadExport;
};
