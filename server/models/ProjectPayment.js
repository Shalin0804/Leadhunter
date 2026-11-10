const { DataTypes } = require('sequelize');

const TYPES = ['ADVANCE_DEPOSIT', 'MILESTONE', 'PARTIAL', 'FINAL', 'OTHER'];
const METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER'];

/**
 * A payment the Main Admin received and recorded by hand. Never created from an invoice.
 * Removing one voids it (voided_at + reason) so history survives; every total counts
 * only rows with voided_at IS NULL.
 */
module.exports = (sequelize) => {
  const ProjectPayment = sequelize.define(
    'ProjectPayment',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      project_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      payment_date: { type: DataTypes.DATEONLY, allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      payment_type: { type: DataTypes.ENUM(...TYPES), allowNull: false },
      payment_method: { type: DataTypes.ENUM(...METHODS), allowNull: false },
      transaction_reference: { type: DataTypes.STRING(120), allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      voided_at: { type: DataTypes.DATE, allowNull: true },
      void_reason: { type: DataTypes.STRING(300), allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'project_payments',
      indexes: [{ fields: ['project_id'] }, { fields: ['client_id'] }, { fields: ['payment_date'] }, { fields: ['transaction_reference'] }],
    }
  );
  ProjectPayment.TYPES = TYPES;
  ProjectPayment.METHODS = METHODS;
  return ProjectPayment;
};
