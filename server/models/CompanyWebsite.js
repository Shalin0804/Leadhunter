const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanyWebsite',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      url: { type: DataTypes.STRING(255), allowNull: false },
      // status: unknown until Phase 2 website scanning; import can hint it
      status: {
        type: DataTypes.ENUM('unknown', 'live', 'down', 'parked', 'no_website'),
        allowNull: false,
        defaultValue: 'unknown',
      },
      is_https: { type: DataTypes.BOOLEAN, allowNull: true },
      health: { type: DataTypes.ENUM('unknown', 'good', 'fair', 'poor', 'outdated'), allowNull: false, defaultValue: 'unknown' },
      last_checked_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: 'company_websites',
      indexes: [{ fields: ['company_id'] }, { fields: ['status'] }],
    }
  );
};
