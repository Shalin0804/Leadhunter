/**
 * Team Management. Listing is scoped (admin: everyone, manager: their team, others: self);
 * every write requires users.manage (Main Admin only) and is audited.
 */
const { Op } = require('sequelize');
const { User, Lead } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { ROLES, can } = require('../config/permissions');
const { visibleUserIds } = require('../services/accessService');
const { likeOp } = require('../utils/dialect');
const { sendSetPasswordEmail } = require('../services/alertService');
const audit = require('../services/auditService');

const clientUrl = () => (process.env.APP_URL || require('../config/config').clientOrigin.split(',')[0]).replace(/\/$/, '');
const setPasswordLink = (token) => `${clientUrl()}/set-password?token=${encodeURIComponent(token)}`;

exports.list = async (req, res) => {
  const where = {};
  const ids = await visibleUserIds(req.user);
  if (ids) where.id = { [Op.in]: ids };
  // Assignment dropdowns only want active users; Team Management asks for all.
  if (req.query.include_inactive !== 'true' || !can(req.user, 'team.view')) where.is_active = true;
  if (req.query.role && ROLES.includes(req.query.role)) where.role = req.query.role;
  if (req.query.search) {
    where[Op.or] = [{ name: { [likeOp]: `%${req.query.search}%` } }, { email: { [likeOp]: `%${req.query.search}%` } }];
  }
  const users = await User.findAll({ where, order: [['name', 'ASC']] });

  let rows = users.map((u) => u.toSafeJSON());
  if (req.query.status) rows = rows.filter((u) => u.status === req.query.status);

  if (can(req.user, 'team.view')) {
    const counts = await Lead.findAll({
      where: { assigned_user_id: { [Op.in]: rows.map((u) => u.id) } },
      attributes: ['assigned_user_id', [Lead.sequelize.fn('COUNT', Lead.sequelize.col('id')), 'n']],
      group: ['assigned_user_id'],
      raw: true,
    });
    const byUser = Object.fromEntries(counts.map((c) => [c.assigned_user_id, Number(c.n)]));
    rows = rows.map((u) => ({ ...u, assigned_leads: byUser[u.id] || 0 }));
  }
  return ok(res, { users: rows });
};

async function loadUser(id) {
  const user = await User.findByPk(id);
  if (!user) throw ApiError.notFound('Employee not found');
  return user;
}

async function validManagerId(managerId) {
  if (managerId === undefined) return undefined;
  if (managerId === null || managerId === '') return null;
  const m = await User.findByPk(managerId);
  if (!m || !['manager', 'admin'].includes(m.role)) throw ApiError.badRequest('manager_id must reference a manager');
  return m.id;
}

// The Main Admin can't be locked out: never remove the last active admin.
async function assertNotLastAdmin(user) {
  if (user.role !== 'admin' || !user.is_active) return;
  const admins = await User.count({ where: { role: 'admin', is_active: true } });
  if (admins <= 1) throw ApiError.badRequest('This is the last active Main Admin — promote another admin first');
}

/** Invite: creates the account with no usable password and returns a one-time set-password link. */
exports.invite = async (req, res) => {
  const { name, email, role = 'agent', manager_id } = req.body;
  if (!ROLES.includes(role)) throw ApiError.badRequest(`role must be one of: ${ROLES.join(', ')}`);
  const normalized = String(email).toLowerCase().trim();
  if (await User.findOne({ where: { email: normalized } })) throw ApiError.conflict('A user with this email already exists');

  const user = await User.create({
    name: String(name).trim(),
    email: normalized,
    password_hash: User.NO_PASSWORD,
    role,
    manager_id: await validManagerId(manager_id),
  });
  const token = await user.issueSetPasswordToken(72);
  const link = setPasswordLink(token);
  const emailed = await sendSetPasswordEmail(user, link, 'invite');

  await audit.record(req, { action: 'user.invited', resourceType: 'user', resourceId: user.id, metadata: { role, emailed } });
  // The link is shown once to the admin (to share if email isn't configured) and never stored in plain text.
  return ok(res, { user: user.toSafeJSON(), set_password_link: link, emailed }, 201);
};

exports.update = async (req, res) => {
  const user = await loadUser(req.params.id);
  const { name, role, manager_id, is_active } = req.body;
  const self = user.id === req.user.id;
  const changes = {};

  if (role !== undefined && role !== user.role) {
    if (!ROLES.includes(role)) throw ApiError.badRequest(`role must be one of: ${ROLES.join(', ')}`);
    if (self) throw ApiError.forbidden('You cannot change your own role');
    await assertNotLastAdmin(user);
    changes.role = { from: user.role, to: role };
    user.role = role;
  }
  if (is_active !== undefined && Boolean(is_active) !== user.is_active) {
    if (self) throw ApiError.forbidden('You cannot change your own account status');
    if (!is_active) await assertNotLastAdmin(user);
    changes.is_active = { from: user.is_active, to: Boolean(is_active) };
    user.is_active = Boolean(is_active);
  }
  const mid = await validManagerId(manager_id);
  if (mid !== undefined && mid !== user.manager_id) {
    if (mid === user.id) throw ApiError.badRequest('An employee cannot be their own manager');
    changes.manager_id = { from: user.manager_id, to: mid };
    user.manager_id = mid;
  }
  if (name !== undefined && String(name).trim() && String(name).trim() !== user.name) {
    changes.name = true;
    user.name = String(name).trim().slice(0, 120);
  }
  if (!Object.keys(changes).length) return ok(res, { user: user.toSafeJSON() });
  await user.save();

  if (changes.role) await audit.record(req, { action: 'user.role_changed', resourceType: 'user', resourceId: user.id, metadata: changes.role });
  if (changes.is_active)
    await audit.record(req, { action: user.is_active ? 'user.activated' : 'user.deactivated', resourceType: 'user', resourceId: user.id });
  if (changes.manager_id || changes.name)
    await audit.record(req, {
      action: 'user.updated',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { ...(changes.manager_id ? { manager_from: changes.manager_id.from, manager_to: changes.manager_id.to } : {}), ...(changes.name ? { name_changed: true } : {}) },
    });
  return ok(res, { user: user.toSafeJSON() });
};

/** Admin-initiated password reset: issues a fresh one-time link (old sessions end once it is used). */
exports.resetPassword = async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user.is_active) throw ApiError.badRequest('Activate the account before resetting its password');
  const token = await user.issueSetPasswordToken(24);
  const link = setPasswordLink(token);
  const emailed = await sendSetPasswordEmail(user, link, 'reset');
  await audit.record(req, { action: 'auth.password_reset_initiated', resourceType: 'user', resourceId: user.id, metadata: { emailed } });
  return ok(res, { set_password_link: link, emailed });
};
