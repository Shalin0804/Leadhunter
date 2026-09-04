const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Activity',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      type: {
        type: DataTypes.ENUM(
          'note',
          'call',
          'email',
          'status_change',
          'follow_up',
          'meeting',
          'assignment',
          'import',
          'system'
        ),
        allowNull: false,
      },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: true },
      meta: { type: DataTypes.JSON, allowNull: true },
      occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'activities',
      indexes: [{ fields: ['lead_id'] }, { fields: ['company_id'] }, { fields: ['type'] }, { fields: ['occurred_at'] }],
    }
  );
};
