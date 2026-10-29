const { DataTypes } = require('sequelize');

/**
 * A possible duplicate the dedup service would NOT merge automatically (identity
 * uncertain: same name without a matching domain/phone/id, or same address only).
 * Both companies are kept; an admin decides.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'DuplicateReview',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, // the newly created record
      candidate_company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, // the existing look-alike
      reason: { type: DataTypes.STRING(60), allowNull: false }, // name_only | address_only | name_city_conflict
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' }, // open | not_duplicate | confirmed
      reviewed_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'duplicate_reviews', indexes: [{ unique: true, fields: ['company_id', 'candidate_company_id'] }, { fields: ['status'] }] }
  );
