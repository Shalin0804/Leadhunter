const { DataTypes } = require('sequelize');

// Applies to email contacts (Hunter) and, loosely, phone (VALID/UNKNOWN only — no phone verifier wired).
const VERIFICATION_STATUSES = ['VERIFIED', 'VALID', 'RISKY', 'INVALID', 'UNKNOWN'];

module.exports = (sequelize) => {
  const CompanyContact = sequelize.define(
    'CompanyContact',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      type: { type: DataTypes.ENUM('email', 'phone'), allowNull: false },
      value: { type: DataTypes.STRING(180), allowNull: false },
      label: { type: DataTypes.STRING(60), allowNull: true },
      is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_public_business: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      is_role_based: { type: DataTypes.BOOLEAN, allowNull: true }, // e.g. info@/contact@ vs a named person

      // Populated by an enrichment provider (Hunter for email). Never set to VERIFIED
      // unless the provider's own verification endpoint actually ran and said so.
      verification_status: { type: DataTypes.ENUM(...VERIFICATION_STATUSES), allowNull: true },
      confidence: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, as reported by the provider
      source: { type: DataTypes.STRING(40), allowNull: true }, // 'hunter' | 'osm' | 'apollo' | 'csv' | 'manual' | ...
      contact_name: { type: DataTypes.STRING(160), allowNull: true }, // publicly listed name, if any
      job_title: { type: DataTypes.STRING(160), allowNull: true },

      // Phone-specific.
      country_code: { type: DataTypes.STRING(8), allowNull: true },
    },
    {
      tableName: 'company_contacts',
      indexes: [{ fields: ['company_id'] }, { fields: ['type'] }],
    }
  );

  CompanyContact.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
  return CompanyContact;
};

module.exports.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
