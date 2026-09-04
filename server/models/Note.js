const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Note',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: 'notes',
      indexes: [{ fields: ['lead_id'] }, { fields: ['company_id'] }, { fields: ['created_at'] }],
    }
  );
};
