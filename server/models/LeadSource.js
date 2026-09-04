const { DataTypes } = require('sequelize');

/**
 * One row per (company, discovery hit). A company can be rediscovered many
 * times, from the same or different providers — each hit gets its own row
 * here, but never creates a second company or lead (see dedupeService).
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'LeadSource',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      search_run_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      provider: { type: DataTypes.STRING(40), allowNull: false }, // osm | google_places | apollo | csv | manual
      external_id: { type: DataTypes.STRING(120), allowNull: true },
      source_url: { type: DataTypes.STRING(500), allowNull: true },
      raw: { type: DataTypes.JSON, allowNull: true },

      discovered_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'lead_sources',
      indexes: [{ fields: ['company_id'] }, { fields: ['provider'] }, { fields: ['search_run_id'] }],
    }
  );
};
