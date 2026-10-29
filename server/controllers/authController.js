const { Op } = require('sequelize');
const { User } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../middleware/auth');
const { permissionsFor } = require('../config/permissions');
const audit = require('../services/auditService');

const session = (user) => ({ user: user.toSafeJSON(), permissions: permissionsFor(user.role) });

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: String(email).toLowerCase().trim() } });
  const valid = user && user.is_active && (await user.verifyPassword(password));

  if (!valid) {
    // The attempted email is never stored; a known account is referenced by id only.
    await audit.record(req, {
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: user?.id,
      result: 'failure',
      metadata: { reason: !user ? 'unknown_account' : !user.is_active ? 'inactive_account' : 'bad_password' },
      actor: null,
    });
    throw ApiError.unauthorized('Invalid email or password');
  }

  user.last_login_at = new Date();
  user.last_activity_at = user.last_login_at;
  await user.save();
  await audit.record(req, { action: 'auth.login', resourceType: 'user', resourceId: user.id, actor: user });

  const token = signToken(user);
  return ok(res, { token, ...session(user) });
};

exports.me = async (req, res) => ok(res, session(req.user));

// Logout revokes the token server-side: every JWT this user holds that was issued before
// now stops working (signing out ends the user's sessions on all devices).
exports.logout = async (req, res) => {
  await req.user.update({ sessions_revoked_at: new Date() });
  await audit.record(req, { action: 'auth.logout', resourceType: 'user', resourceId: req.user.id });
  return ok(res, { message: 'Logged out' });
};

/** Public: accept an invite or complete a password reset with the one-time token. */
exports.setPassword = async (req, res) => {
  const { token, password } = req.body;
  const user = await User.findOne({
    where: { set_password_token_hash: User.hashToken(token), set_password_expires_at: { [Op.gt]: new Date() } },
  });
  if (!user || !user.is_active) throw ApiError.badRequest('This link is invalid or has expired. Ask your admin for a new one.');

  const wasInvite = user.password_hash === User.NO_PASSWORD;
  user.password_hash = await User.hashPassword(password);
  user.password_changed_at = new Date();
  user.set_password_token_hash = null;
  user.set_password_expires_at = null;
  await user.save();
  await audit.record(req, {
    action: wasInvite ? 'auth.invite_accepted' : 'auth.password_reset_completed',
    resourceType: 'user',
    resourceId: user.id,
    actor: user,
  });
  return ok(res, { message: 'Password set — you can sign in now' });
};
