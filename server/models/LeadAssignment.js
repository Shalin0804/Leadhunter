const { DataTypes } = require('sequelize');

/** Ownership history of a lead: one row per assign / reassign / unassign. */
module.exports = (sequelize) =>
  sequelize.define(
    'LeadAssignment',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      previous_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      new_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }, // null = unassigned
      assigned_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      reason: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      tableName: 'lead_assignments',
      updatedAt: false,
      indexes: [{ fields: ['lead_id', 'created_at'] }, { fields: ['new_user_id'] }],
    }
  );
