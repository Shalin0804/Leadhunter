const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanyContact',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      type: { type: DataTypes.ENUM('email', 'phone'), allowNull: false },
      value: { type: DataTypes.STRING(180), allowNull: false },
      label: { type: DataTypes.STRING(60), allowNull: true },
      is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_public_business: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'company_contacts',
      indexes: [{ fields: ['company_id'] }, { fields: ['type'] }],
    }
  );
};
