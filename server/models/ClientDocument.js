const { DataTypes } = require('sequelize');

const KINDS = ['RECEIPT', 'INVOICE', 'DOCUMENT'];

/**
 * Receipts, invoice PDFs and other client files. The bytes live in the database (not on
 * Render's ephemeral disk or any public bucket) and are only served through the
 * admin-only /api/finance/documents/:id/file route. The default scope leaves `data` out,
 * so listing documents never loads file contents.
 */
module.exports = (sequelize) => {
  const ClientDocument = sequelize.define(
    'ClientDocument',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      project_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      payment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      kind: { type: DataTypes.ENUM(...KINDS), allowNull: false, defaultValue: 'DOCUMENT' },
      file_name: { type: DataTypes.STRING(200), allowNull: false },
      mime_type: { type: DataTypes.STRING(80), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      data: { type: DataTypes.BLOB('long'), allowNull: false },
      notes: { type: DataTypes.STRING(300), allowNull: true },
      uploaded_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'client_documents',
      defaultScope: { attributes: { exclude: ['data'] } },
      scopes: { withData: { attributes: { include: ['data'] } } },
      indexes: [{ fields: ['client_id'] }, { fields: ['payment_id'] }, { fields: ['invoice_id'] }],
    }
  );
  ClientDocument.KINDS = KINDS;
  return ClientDocument;
};
