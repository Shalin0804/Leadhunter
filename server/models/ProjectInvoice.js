const { DataTypes } = require('sequelize');

const STATUSES = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'];

// An invoice record. Its status is set by hand and never creates or implies a payment:
// money received lives only in project_payments.
module.exports = (sequelize) => {
  const ProjectInvoice = sequelize.define(
    'ProjectInvoice',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      invoice_number: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      project_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
      due_date: { type: DataTypes.DATEONLY, allowNull: true },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      tax_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      total_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'DRAFT' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'project_invoices', indexes: [{ fields: ['client_id'] }, { fields: ['project_id'] }, { fields: ['status'] }, { fields: ['invoice_date'] }] }
  );
  ProjectInvoice.STATUSES = STATUSES;
  return ProjectInvoice;
};
