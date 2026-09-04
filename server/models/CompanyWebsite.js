const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanyWebsite',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      url: { type: DataTypes.STRING(255), allowNull: false },
      status: {
        type: DataTypes.ENUM('unknown', 'live', 'down', 'parked', 'no_website'),
        allowNull: false,
        defaultValue: 'unknown',
      },
      is_https: { type: DataTypes.BOOLEAN, allowNull: true },
      health: {
        type: DataTypes.ENUM('unknown', 'excellent', 'good', 'fair', 'poor', 'outdated'),
        allowNull: false,
        defaultValue: 'unknown',
      },
      opportunity_score: { type: DataTypes.INTEGER, allowNull: true },

      // Lightweight audit signals from a single homepage fetch (no crawling).
      response_time_ms: { type: DataTypes.INTEGER, allowNull: true },
      http_status: { type: DataTypes.INTEGER, allowNull: true },
      is_mobile_friendly: { type: DataTypes.BOOLEAN, allowNull: true },
      page_title: { type: DataTypes.STRING(255), allowNull: true },
      meta_description: { type: DataTypes.STRING(500), allowNull: true },
      detected_technologies: { type: DataTypes.JSON, allowNull: true },
      audit_signals: { type: DataTypes.JSON, allowNull: true },

      last_checked_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: 'company_websites',
      indexes: [{ fields: ['company_id'] }, { fields: ['status'] }],
    }
  );
};
