const { DataTypes } = require('sequelize');

// One row per email, outbound or inbound. A retry updates the same row, so a lead's
// history never shows duplicates. SENT means the SMTP server accepted it — not delivered.
const STATUSES = ['DRAFT', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED'];
const KINDS = ['initial', 'follow_up', 'test', 'reply'];

module.exports = (sequelize) => {
  const EmailMessage = sequelize.define(
    'EmailMessage',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }, // null for test emails
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      campaign_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      outreach_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }, // Claude Code / generator draft it came from
      direction: { type: DataTypes.ENUM('outbound', 'inbound'), allowNull: false, defaultValue: 'outbound' },
      kind: { type: DataTypes.ENUM(...KINDS), allowNull: false, defaultValue: 'initial' },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'DRAFT' },
      to_email: { type: DataTypes.STRING(254), allowNull: false },
      from_email: { type: DataTypes.STRING(254), allowNull: false },
      subject: { type: DataTypes.STRING(255), allowNull: false },
      body: { type: DataTypes.TEXT('medium'), allowNull: false }, // MEDIUMTEXT on MySQL/TiDB: 20k chars of utf8mb4 can exceed TEXT's 64 KB
      generated_by: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
      // RFC 5322 Message-ID: assigned before the first attempt (retries reuse it) or read from the inbound mail.
      message_id: { type: DataTypes.STRING(255), allowNull: true, unique: true },
      in_reply_to: { type: DataTypes.STRING(255), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      smtp_response: { type: DataTypes.STRING(255), allowNull: true },
      error: { type: DataTypes.STRING(1000), allowNull: true },
      opt_out: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // inbound "unsubscribe"
      sent_at: { type: DataTypes.DATE, allowNull: true },
      received_at: { type: DataTypes.DATE, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      sent_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'email_messages',
      indexes: [{ fields: ['lead_id'] }, { fields: ['campaign_id'] }, { fields: ['status'] }, { fields: ['to_email'] }, { fields: ['sent_at'] }],
    }
  );
  EmailMessage.STATUSES = STATUSES;
  EmailMessage.KINDS = KINDS;
  return EmailMessage;
};
