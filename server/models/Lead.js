const { DataTypes } = require('sequelize');

// Pipeline stage — drives the Kanban board. Kept in sync with contact_status
// (see CONTACT_TO_PIPELINE below) so the board always reflects contact history.
const LEAD_STATUSES = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
];

// Qualification state — independent of whether/how the lead has been contacted.
const LEAD_QUALIFICATION_STATUSES = ['NEW', 'QUALIFIED', 'UNQUALIFIED', 'ARCHIVED'];

// Contact state — the permanent record of "have we reached out, and how far did it go".
const CONTACT_STATUSES = [
  'NOT_CONTACTED',
  'CONTACTED',
  'FOLLOW_UP',
  'REPLIED',
  'INTERESTED',
  'MEETING_BOOKED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
];

const CONTACT_METHODS = ['EMAIL', 'WHATSAPP', 'PHONE', 'LINKEDIN', 'INSTAGRAM', 'OTHER'];

// Nemotron (NVIDIA NIM) AI qualification verdict — an additional intelligence signal
// layered on top of lead_score/lead_temperature above, never a replacement for them.
const AI_QUALIFICATION_STATUSES = ['high_potential', 'medium_potential', 'low_potential', 'insufficient_data'];
const AI_PROCESSING_STATUSES = ['NOT_ANALYZED', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'];

// Score-derived priority tier (Prospecting Engine 2.0): 80-100 HOT, 60-79 WARM,
// 50-59 MEDIUM, 0-49 LOW. Replaces the earlier 5-tier HOT/HIGH/WARM/LOW/NOT_QUALIFIED
// scale — see seed/migrate.js for the one-time data remap (HIGH->WARM, NOT_QUALIFIED->LOW).
const LEAD_TEMPERATURES = ['HOT', 'WARM', 'MEDIUM', 'LOW'];

// contact_status values that mean "don't surface this as a fresh new lead again".
const ALREADY_ENGAGED_CONTACT_STATUSES = CONTACT_STATUSES.filter((s) => s !== 'NOT_CONTACTED');

// contact_status -> pipeline stage. FOLLOW_UP stays visually at CONTACTED (it's a
// sub-state — "contacted, awaiting a follow-up" — not a further-along stage).
const CONTACT_TO_PIPELINE = {
  NOT_CONTACTED: 'NEW',
  CONTACTED: 'CONTACTED',
  FOLLOW_UP: 'CONTACTED',
  REPLIED: 'REPLIED',
  INTERESTED: 'INTERESTED',
  MEETING_BOOKED: 'MEETING',
  PROPOSAL_SENT: 'PROPOSAL',
  NEGOTIATION: 'NEGOTIATION',
  WON: 'WON',
  LOST: 'LOST',
  NOT_INTERESTED: 'NOT_INTERESTED',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
};

module.exports = (sequelize) => {
  const Lead = sequelize.define(
    'Lead',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      assigned_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      created_by_user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      // Pipeline stage (Kanban) — kept as `status` for compatibility with the existing board/API.
      status: { type: DataTypes.ENUM(...LEAD_STATUSES), allowNull: false, defaultValue: 'NEW' },
      priority: { type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH'), allowNull: false, defaultValue: 'MEDIUM' },

      // Qualification vs. contact tracking — deliberately separate (section 16 of the spec).
      lead_status: { type: DataTypes.ENUM(...LEAD_QUALIFICATION_STATUSES), allowNull: false, defaultValue: 'NEW' },
      contact_status: { type: DataTypes.ENUM(...CONTACT_STATUSES), allowNull: false, defaultValue: 'NOT_CONTACTED' },
      contact_method: { type: DataTypes.ENUM(...CONTACT_METHODS), allowNull: true },
      contacted_at: { type: DataTypes.DATE, allowNull: true },

      lead_score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lead_temperature: {
        type: DataTypes.ENUM(...LEAD_TEMPERATURES),
        allowNull: false,
        defaultValue: 'LOW',
      },
      recommended_service: { type: DataTypes.STRING(160), allowNull: true },

      // Populated by the automation pipeline's rule-based "AI qualification" step.
      ai_problem: { type: DataTypes.TEXT, allowNull: true }, // opportunity_reason
      ai_evidence: { type: DataTypes.JSON, allowNull: true },
      ai_sales_angle: { type: DataTypes.TEXT, allowNull: true }, // outreach_angle

      // Nemotron (NVIDIA NIM) AI qualification — a second, LLM-backed intelligence
      // layer on top of the rule-based ai_problem/ai_evidence/ai_sales_angle above and
      // the deterministic lead_score/recommended_service. Populated by
      // aiQualificationService.qualifyWithNemotron(); never invented, never required —
      // every field here stays null until NVIDIA_API_KEY is configured and a run succeeds.
      ai_qualification_status: { type: DataTypes.ENUM(...AI_QUALIFICATION_STATUSES), allowNull: true },
      ai_confidence: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, Nemotron's own confidence
      ai_summary: { type: DataTypes.TEXT, allowNull: true }, // business_summary
      ai_recommended_service: { type: DataTypes.STRING(60), allowNull: true }, // one of Codefloor's 5 configured services (relevant_service)
      ai_outreach_angle: { type: DataTypes.TEXT, allowNull: true }, // outreach.angle
      ai_analysis: { type: DataTypes.JSON, allowNull: true }, // full structured Nemotron response (business_summary/website_quality/technology_opportunities/...)
      ai_processing_status: { type: DataTypes.ENUM(...AI_PROCESSING_STATUSES), allowNull: false, defaultValue: 'NOT_ANALYZED' },
      ai_processing_error: { type: DataTypes.STRING(500), allowNull: true },
      ai_processed_at: { type: DataTypes.DATE, allowNull: true },
      ai_retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ai_model_version: { type: DataTypes.STRING(80), allowNull: true },

      estimated_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
      next_follow_up_at: { type: DataTypes.DATE, allowNull: true },
      last_contacted_at: { type: DataTypes.DATE, allowNull: true },
      lost_reason: { type: DataTypes.STRING(255), allowNull: true },

      // True once this lead has ever left NOT_CONTACTED — never flips back automatically.
      ever_contacted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' }, // manual | automation
    },
    {
      tableName: 'leads',
      indexes: [
        { fields: ['company_id'] },
        { fields: ['assigned_user_id'] },
        { fields: ['status'] },
        { fields: ['lead_status'] },
        { fields: ['contact_status'] },
        { fields: ['lead_score'] },
        { fields: ['lead_temperature'] },
        { fields: ['next_follow_up_at'] },
      ],
    }
  );

  Lead.STATUSES = LEAD_STATUSES;
  Lead.LEAD_QUALIFICATION_STATUSES = LEAD_QUALIFICATION_STATUSES;
  Lead.CONTACT_STATUSES = CONTACT_STATUSES;
  Lead.CONTACT_METHODS = CONTACT_METHODS;
  Lead.LEAD_TEMPERATURES = LEAD_TEMPERATURES;
  Lead.ALREADY_ENGAGED_CONTACT_STATUSES = ALREADY_ENGAGED_CONTACT_STATUSES;
  Lead.CONTACT_TO_PIPELINE = CONTACT_TO_PIPELINE;
  Lead.AI_QUALIFICATION_STATUSES = AI_QUALIFICATION_STATUSES;
  Lead.AI_PROCESSING_STATUSES = AI_PROCESSING_STATUSES;
  return Lead;
};

module.exports.LEAD_STATUSES = LEAD_STATUSES;
module.exports.LEAD_QUALIFICATION_STATUSES = LEAD_QUALIFICATION_STATUSES;
module.exports.CONTACT_STATUSES = CONTACT_STATUSES;
module.exports.CONTACT_METHODS = CONTACT_METHODS;
module.exports.LEAD_TEMPERATURES = LEAD_TEMPERATURES;
module.exports.ALREADY_ENGAGED_CONTACT_STATUSES = ALREADY_ENGAGED_CONTACT_STATUSES;
module.exports.CONTACT_TO_PIPELINE = CONTACT_TO_PIPELINE;
module.exports.AI_QUALIFICATION_STATUSES = AI_QUALIFICATION_STATUSES;
module.exports.AI_PROCESSING_STATUSES = AI_PROCESSING_STATUSES;
