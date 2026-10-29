const { DataTypes } = require('sequelize');

/**
 * Admin-managed business categories that drive Lead Discovery. `keyword` is the term
 * sent to discovery providers (OSM maps it to tags); `opportunity_types` uses the
 * opportunity codes from services/opportunityDetectionService.js.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'BusinessCategory',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(80), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      parent_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }, // industry grouping
      keyword: { type: DataTypes.STRING(60), allowNull: false },
      opportunity_types: { type: DataTypes.JSON, allowNull: true },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 }, // 1 (low) - 5 (high)
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updated_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'business_categories', indexes: [{ fields: ['is_enabled'] }, { fields: ['parent_id'] }] }
  );
