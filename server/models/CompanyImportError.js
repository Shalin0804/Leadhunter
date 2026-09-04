const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanyImportError',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      import_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      row_number: { type: DataTypes.INTEGER, allowNull: true },
      field: { type: DataTypes.STRING(80), allowNull: true },
      message: { type: DataTypes.STRING(255), allowNull: false },
      raw_row: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'company_import_errors',
      indexes: [{ fields: ['import_id'] }],
    }
  );
};
