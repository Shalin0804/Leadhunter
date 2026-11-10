const { DataTypes } = require('sequelize');

/**
 * Finance module: a paying client, entered by the Main Admin. Separate from `companies`
 * (discovered leads). Never hard-deleted — archived_at hides it from active lists while
 * keeping its projects, payments and invoices intact.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'Client',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      company_name: { type: DataTypes.STRING(200), allowNull: true },
      contact_person: { type: DataTypes.STRING(160), allowNull: true },
      email: { type: DataTypes.STRING(190), allowNull: true },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.TEXT, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      archived_at: { type: DataTypes.DATE, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'clients', indexes: [{ fields: ['name'] }, { fields: ['archived_at'] }] }
  );
