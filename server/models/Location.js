const { DataTypes } = require('sequelize');

/**
 * Geographic locations used to target business discovery — a separate concern from
 * companies/leads (a location never implies any business exists there).
 * Hierarchy: country -> state (admin region) -> city -> area, via parent_id.
 * Imported rows are identified by (source, source_external_id), never by name.
 */
const LOCATION_TYPES = ['country', 'state', 'city', 'area'];

module.exports = (sequelize) => {
  const Location = sequelize.define(
    'Location',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' }, // geonames | manual
      source_external_id: { type: DataTypes.STRING(40), allowNull: true }, // e.g. GeoNames geonameid / admin1 code
      name: { type: DataTypes.STRING(200), allowNull: false },
      normalized_name: { type: DataTypes.STRING(200), allowNull: false },
      alternate_names: { type: DataTypes.JSON, allowNull: true }, // bounded list of other spellings
      country_code: { type: DataTypes.STRING(2), allowNull: false },
      location_type: { type: DataTypes.ENUM(...LOCATION_TYPES), allowNull: false },
      administrative_level: { type: DataTypes.INTEGER, allowNull: true }, // 0 country, 1 state, 2 city, 3 area
      feature_code: { type: DataTypes.STRING(30), allowNull: true }, // GeoNames code (PPLA, PPLX, ...) or osm:<place>
      parent_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      population: { type: DataTypes.BIGINT, allowNull: true },
      search_radius_km: { type: DataTypes.INTEGER, allowNull: true }, // used only by providers that support a radius
      metadata: { type: DataTypes.JSON, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, // inactive = not usable for discovery
      discovered_at: { type: DataTypes.DATE, allowNull: true },
      last_verified_at: { type: DataTypes.DATE, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updated_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'locations',
      indexes: [
        { unique: true, fields: ['source', 'source_external_id'] },
        { fields: ['country_code', 'location_type'] },
        { fields: ['parent_id'] },
        { fields: ['normalized_name'] },
        { fields: ['is_active'] },
      ],
    }
  );
  Location.TYPES = LOCATION_TYPES;
  return Location;
};
