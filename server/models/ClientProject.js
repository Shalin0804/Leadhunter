const { DataTypes } = require('sequelize');

const STATUSES = ['INQUIRY', 'CONFIRMED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

// One client has many projects. Totals (received, balance) are always derived from
// project_payments — never stored here — so they can't drift or double count.
module.exports = (sequelize) => {
  const ClientProject = sequelize.define(
    'ClientProject',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      start_date: { type: DataTypes.DATEONLY, allowNull: true },
      expected_delivery_date: { type: DataTypes.DATEONLY, allowNull: true },
      actual_completion_date: { type: DataTypes.DATEONLY, allowNull: true },
      project_value: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'INQUIRY' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'client_projects', indexes: [{ fields: ['client_id'] }, { fields: ['status'] }] }
  );
  ClientProject.STATUSES = STATUSES;
  return ClientProject;
};
