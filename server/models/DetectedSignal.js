const { DataTypes } = require('sequelize');

/**
 * Automatically-inferred business-opportunity signals — distinct from the
 * `signals` table (which records a prospect explicitly ASKING for work).
 * These are derived only from data this app has actually collected (website
 * audit, registration/discovery recency, public social links, industry). No
 * signal is invented: if there's no real evidence, no row is created.
 */
const SIGNAL_TYPES = [
  'NO_WEBSITE',
  'OUTDATED_WEBSITE',
  'NEWLY_REGISTERED',
  'NEWLY_DISCOVERED',
  'ACTIVE_SOCIAL_PRESENCE',
  'ONLINE_BOOKING_GAP',
  'ECOMMERCE_OPPORTUNITY',
];

const SIGNAL_STRENGTHS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];

module.exports = (sequelize) => {
  const DetectedSignal = sequelize.define(
    'DetectedSignal',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      signal_type: { type: DataTypes.ENUM(...SIGNAL_TYPES), allowNull: false },
      signal_description: { type: DataTypes.STRING(255), allowNull: false },
      signal_strength: { type: DataTypes.ENUM(...SIGNAL_STRENGTHS), allowNull: false, defaultValue: 'NONE' },
      signal_source: { type: DataTypes.STRING(60), allowNull: false }, // e.g. 'website_audit', 'company_registration_data'
      signal_date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      // true = directly observed by this app (e.g. we fetched the site and it 404'd);
      // there is currently no case where we report an unverified detected signal.
      verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'detected_signals',
      indexes: [{ fields: ['company_id'] }, { fields: ['signal_type'] }],
    }
  );

  DetectedSignal.SIGNAL_TYPES = SIGNAL_TYPES;
  DetectedSignal.SIGNAL_STRENGTHS = SIGNAL_STRENGTHS;
  return DetectedSignal;
};

module.exports.SIGNAL_TYPES = SIGNAL_TYPES;
module.exports.SIGNAL_STRENGTHS = SIGNAL_STRENGTHS;
