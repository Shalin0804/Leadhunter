const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanyImport',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'csv' },
      original_filename: { type: DataTypes.STRING(255), allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'validated', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      total_records: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      imported_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updated_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      duplicate_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      invalid_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      summary: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'company_imports',
      indexes: [{ fields: ['user_id'] }, { fields: ['status'] }],
    }
  );
};
