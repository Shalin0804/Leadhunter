const { DataTypes } = require('sequelize');

/**
 * One sourced fact/claim from a HermesResearchRun. Every field Hermes returns
 * gets a row here, including ones never applied to a Company/Contact/etc. —
 * this is the audit trail behind "why did the CRM say this" (see Phase 4 of
 * the integration: unsupported AI-generated facts must never enter the CRM
 * as verified information without this trail).
 *
 * `status` mirrors hermesResultParser's classification:
 *   verified   — a real source_url backs it, high confidence
 *   likely     — a real source_url backs it, lower confidence
 *   inferred   — the agent's own reasoning, no direct source — never written
 *                to a Company/Contact/Website/Social column, display-only
 *   unavailable — Hermes looked and found nothing for this field
 */
const EVIDENCE_STATUSES = ['verified', 'likely', 'inferred', 'unavailable'];

module.exports = (sequelize) => {
  const HermesResearchEvidence = sequelize.define(
    'HermesResearchEvidence',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      research_run_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, // denormalized for company-scoped queries

      field_name: { type: DataTypes.STRING(80), allowNull: false }, // e.g. 'company.website', 'contacts[0].email'
      value: { type: DataTypes.TEXT, allowNull: true },
      source_url: { type: DataTypes.STRING(2048), allowNull: true },
      source_type: { type: DataTypes.STRING(60), allowNull: true }, // 'official_website' | 'directory' | 'social_profile' | ...
      confidence: { type: DataTypes.INTEGER, allowNull: true }, // 0-100, as reported by Hermes
      status: { type: DataTypes.ENUM(...EVIDENCE_STATUSES), allowNull: false, defaultValue: 'unavailable' },
      discovered_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'hermes_research_evidence',
      indexes: [{ fields: ['research_run_id'] }, { fields: ['company_id'] }],
    }
  );

  HermesResearchEvidence.EVIDENCE_STATUSES = EVIDENCE_STATUSES;
  return HermesResearchEvidence;
};

module.exports.EVIDENCE_STATUSES = EVIDENCE_STATUSES;
