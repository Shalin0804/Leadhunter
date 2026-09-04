const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Task',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      assigned_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      title: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      due_date: { type: DataTypes.DATE, allowNull: true },
      priority: { type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH'), allowNull: false, defaultValue: 'MEDIUM' },
      status: {
        type: DataTypes.ENUM('TODO', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'TODO',
      },
      is_follow_up: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      follow_up_method: { type: DataTypes.ENUM('EMAIL', 'WHATSAPP', 'PHONE', 'LINKEDIN', 'INSTAGRAM', 'OTHER'), allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'tasks',
      indexes: [
        { fields: ['lead_id'] },
        { fields: ['assigned_user_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
      ],
    }
  );
};
