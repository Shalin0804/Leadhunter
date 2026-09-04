const { DataTypes } = require('sequelize');

const SERVICES = [
  'WEBSITE_DEVELOPMENT',
  'WEBSITE_REDESIGN',
  'SOFTWARE_DEVELOPMENT',
  'MOBILE_APP',
  'CRM',
  'ECOMMERCE',
  'DIGITAL_MARKETING',
  'OTHER',
];

const SOURCES = [
  'linkedin',
  'instagram',
  'facebook',
  'twitter',
  'youtube',
  'referral',
  'inbound_form',
  'event',
  'marketplace',
  'cold_outreach',
  'manual',
  'csv',
];

const STATUSES = ['NEW', 'REVIEWED', 'CONVERTED', 'DISMISSED'];

module.exports = (sequelize) => {
  const Signal = sequelize.define(
    'Signal',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      // What the prospect is asking for.
      service: { type: DataTypes.ENUM(...SERVICES), allowNull: false, defaultValue: 'OTHER' },
      // Where the signal was captured (a channel you are permitted to use — NOT scraped).
      source: { type: DataTypes.ENUM(...SOURCES), allowNull: false, defaultValue: 'manual' },
      source_url: { type: DataTypes.STRING(500), allowNull: true },

      // The prospect's own words / the gist of the request.
      headline: { type: DataTypes.STRING(255), allowNull: true },
      detail: { type: DataTypes.TEXT, allowNull: true },

      // Business contact (not sensitive personal data).
      contact_name: { type: DataTypes.STRING(160), allowNull: true },
      contact_email: { type: DataTypes.STRING(180), allowNull: true },
      contact_phone: { type: DataTypes.STRING(60), allowNull: true },
      company_name_raw: { type: DataTypes.STRING(255), allowNull: true },
      website_raw: { type: DataTypes.STRING(255), allowNull: true },

      confidence: { type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH'), allowNull: false, defaultValue: 'MEDIUM' },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'NEW' },

      captured_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      import_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      raw: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'signals',
      indexes: [
        { fields: ['company_id'] },
        { fields: ['lead_id'] },
        { fields: ['service'] },
        { fields: ['source'] },
        { fields: ['status'] },
        { fields: ['captured_at'] },
      ],
    }
  );

  Signal.SERVICES = SERVICES;
  Signal.SOURCES = SOURCES;
  Signal.STATUSES = STATUSES;
  return Signal;
};

module.exports.SERVICES = SERVICES;
module.exports.SOURCES = SOURCES;
module.exports.STATUSES = STATUSES;
