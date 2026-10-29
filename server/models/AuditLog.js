const { DataTypes } = require('sequelize');

/**
 * Append-only security / activity audit trail. Written only by services/auditService.js
 * with the actor taken from the authenticated request (never from the client).
 * Never stores contact values, passwords or tokens — only which fields were accessed.
 * Separate from `activities`, which is the lead timeline shown in the UI.
 */
module.exports = (sequelize) => {
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      actor_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }, // null = anonymous (e.g. failed login)
      actor_name: { type: DataTypes.STRING(120), allowNull: true }, // snapshot at the time of the event
      actor_role: { type: DataTypes.STRING(20), allowNull: true },
      action: { type: DataTypes.STRING(60), allowNull: false },
      resource_type: { type: DataTypes.STRING(40), allowNull: true },
      resource_id: { type: DataTypes.STRING(64), allowNull: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      contact_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      accessed_fields: { type: DataTypes.JSON, allowNull: true },
      metadata: { type: DataTypes.JSON, allowNull: true },
      result: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'success' }, // success | denied | failure
      request_id: { type: DataTypes.STRING(64), allowNull: true },
      ip: { type: DataTypes.STRING(64), allowNull: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: 'audit_logs',
      updatedAt: false,
      indexes: [
        { fields: ['actor_user_id', 'created_at'] },
        { fields: ['action'] },
        { fields: ['resource_type', 'resource_id'] },
        { fields: ['lead_id'] },
        { fields: ['company_id'] },
        { fields: ['created_at'] },
      ],
    }
  );

  // Application-level append-only guard. On Postgres, seed/migrate.js also installs a
  // trigger so the rows can't be changed through any other code path either.
  const immutable = () => {
    throw new Error('audit_logs is append-only');
  };
  AuditLog.addHook('beforeUpdate', immutable);
  AuditLog.addHook('beforeDestroy', immutable);
  AuditLog.addHook('beforeBulkUpdate', immutable);
  AuditLog.addHook('beforeBulkDestroy', immutable);

  return AuditLog;
};
