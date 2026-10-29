/**
 * Writes the append-only audit trail (models/AuditLog.js).
 *
 * Identity always comes from the authenticated request (req.user), never from the
 * request body. Writes are awaited and FAIL CLOSED: if the audit row can't be stored,
 * the caller's request fails too, so sensitive data is never served unlogged.
 * Never pass contact values, passwords or tokens in `metadata`.
 */
const { sequelize, AuditLog } = require('../models');

const SENSITIVE_KEY = /pass|token|secret|authorization|^value$|phone|email/i;

// Drop sensitive keys defensively and bound the size of what we store.
function scrub(meta) {
  if (!meta) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || SENSITIVE_KEY.test(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  return Object.keys(out).length ? out : null;
}

async function record(req, { action, resourceType, resourceId, leadId, companyId, contactId, fields, metadata, result = 'success', actor } = {}) {
  const user = actor || req?.user || null;
  try {
    return await AuditLog.create({
      actor_user_id: user?.id ?? null,
      actor_name: user?.name ?? null,
      actor_role: user?.role ?? null,
      action,
      resource_type: resourceType ?? null,
      resource_id: resourceId != null ? String(resourceId) : null,
      lead_id: leadId ?? null,
      company_id: companyId ?? null,
      contact_id: contactId ?? null,
      accessed_fields: fields && fields.length ? fields : null,
      metadata: scrub(metadata),
      result,
      request_id: req?.id ?? null,
      ip: req?.ip ? String(req.ip).slice(0, 64) : null,
      user_agent: req?.get ? (req.get('user-agent') || '').slice(0, 255) || null : null,
    });
  } catch (err) {
    // Observable: always logged loudly; then re-thrown so the request fails closed.
    console.error(`[audit] FAILED to record ${action} (request ${req?.id}):`, err.message);
    throw err;
  }
}

/**
 * Retention: delete rows older than AUDIT_RETENTION_DAYS (unset/0 = keep forever).
 * The only code path that deletes audit rows. Bypasses the model's append-only hooks
 * with raw SQL and, on Postgres, opens the trigger for this transaction only.
 */
async function purgeExpired(days = parseInt(process.env.AUDIT_RETENTION_DAYS || '0', 10)) {
  if (!days || days < 1) return 0;
  const cutoff = new Date(Date.now() - days * 86400000);
  return sequelize.transaction(async (transaction) => {
    if (sequelize.getDialect() === 'postgres') await sequelize.query("SET LOCAL app.audit_purge = 'on'", { transaction });
    const [, meta] = await sequelize.query('DELETE FROM audit_logs WHERE created_at < :cutoff', { replacements: { cutoff }, transaction });
    const n = typeof meta === 'number' ? meta : meta?.rowCount ?? meta?.affectedRows ?? 0;
    if (n) console.log(`[audit] retention: purged ${n} rows older than ${days} days`);
    return n;
  });
}

module.exports = { record, scrub, purgeExpired };
