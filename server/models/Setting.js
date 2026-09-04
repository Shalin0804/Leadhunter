const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Setting',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      value: { type: DataTypes.JSON, allowNull: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    { tableName: 'settings' }
  );
};
