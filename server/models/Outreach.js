const { DataTypes } = require('sequelize');

const CHANNELS = ['EMAIL', 'WHATSAPP', 'LINKEDIN', 'PHONE_TALKING_POINTS', 'FOLLOW_UP', 'PROPOSAL'];
// Approval state. Rule-based drafts stay DRAFT (unchanged behaviour); Claude Code agent
// drafts start PENDING_APPROVAL. Nothing is ever sent by the system in any state.
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

module.exports = (sequelize) => {
  const Outreach = sequelize.define(
    'Outreach',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
      subject: { type: DataTypes.STRING(255), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: false },
      // The concrete, real facts the message text was built from — never fabricated.
      evidence: { type: DataTypes.JSON, allowNull: true },
      generated_by: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'rule_based' },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'DRAFT' },
      reviewed_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_note: { type: DataTypes.STRING(500), allowNull: true },
      agent_task_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Which message of a sales pack this is (cold_email, whatsapp, call_script, ...); null for older drafts.
      purpose: { type: DataTypes.STRING(30), allowNull: true },
      playbook_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Set when a person marks an approved draft as sent (WhatsApp / call / LinkedIn are sent by hand).
      sent_at: { type: DataTypes.DATE, allowNull: true },
      sent_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'outreach',
      indexes: [{ fields: ['lead_id'] }, { fields: ['company_id'] }],
    }
  );

  Outreach.CHANNELS = CHANNELS;
  Outreach.STATUSES = STATUSES;
  return Outreach;
};

module.exports.CHANNELS = CHANNELS;
module.exports.STATUSES = STATUSES;
