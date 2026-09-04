const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'LeadStatusHistory',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      from_status: { type: DataTypes.STRING(20), allowNull: true },
      to_status: { type: DataTypes.STRING(20), allowNull: false },
      changed_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      note: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: 'lead_status_history',
      indexes: [{ fields: ['lead_id'] }],
    }
  );
};
