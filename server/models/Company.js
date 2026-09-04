const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Company = sequelize.define(
    'Company',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_name: { type: DataTypes.STRING(255), allowNull: false },
      cin: { type: DataTypes.STRING(30), allowNull: true, unique: true },
      registration_number: { type: DataTypes.STRING(60), allowNull: true },
      date_of_incorporation: { type: DataTypes.DATEONLY, allowNull: true },
      company_status: { type: DataTypes.STRING(60), allowNull: true, defaultValue: 'Active' },
      company_type: { type: DataTypes.STRING(80), allowNull: true },
      company_category: { type: DataTypes.STRING(80), allowNull: true },
      industry: { type: DataTypes.STRING(120), allowNull: true },
      roc: { type: DataTypes.STRING(80), allowNull: true },
      state: { type: DataTypes.STRING(80), allowNull: true },
      city: { type: DataTypes.STRING(80), allowNull: true },
      registered_address: { type: DataTypes.STRING(500), allowNull: true },
      authorized_capital: { type: DataTypes.DECIMAL(16, 2), allowNull: true },
      paid_up_capital: { type: DataTypes.DECIMAL(16, 2), allowNull: true },

      // Denormalized online-presence flags (kept in sync from related tables / import)
      website: { type: DataTypes.STRING(255), allowNull: true },
      has_website: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      has_email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      has_phone: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

      source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'csv' },
      is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

      // Cached latest scoring for fast discovery listing / filtering
      lead_score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lead_temperature: {
        type: DataTypes.ENUM('HOT', 'HIGH', 'WARM', 'LOW', 'NOT_QUALIFIED'),
        allowNull: false,
        defaultValue: 'NOT_QUALIFIED',
      },
      recommended_service: { type: DataTypes.STRING(160), allowNull: true },
    },
    {
      tableName: 'companies',
      indexes: [
        // `cin` already gets a unique index from the column definition
        { fields: ['company_name'] },
        { fields: ['date_of_incorporation'] },
        { fields: ['state'] },
        { fields: ['city'] },
        { fields: ['industry'] },
        { fields: ['company_status'] },
        { fields: ['lead_score'] },
        { fields: ['lead_temperature'] },
      ],
    }
  );

  return Company;
};
