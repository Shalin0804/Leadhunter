const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User } = require('../models');
const { can } = require('../config/permissions');
const ApiError = require('../utils/ApiError');
const { asyncHandler } = require('../utils/http');

const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });

const ACTIVITY_TOUCH_MS = 60 * 1000;

const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Authentication token missing');

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch (e) {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  // Role, status and team are always re-read from the DB — never trusted from the token,
  // so a deactivation or role change takes effect on the very next request.
  const user = await User.findByPk(payload.sub);
  if (!user || !user.is_active) throw ApiError.unauthorized('Account not found or inactive');
  // Sessions issued before the last password change are revoked.
  if (user.password_changed_at && payload.iat * 1000 < user.password_changed_at.getTime() - 1000) {
    throw ApiError.unauthorized('Session expired — please sign in again');
  }

  if (!user.last_activity_at || Date.now() - user.last_activity_at.getTime() > ACTIVITY_TOUCH_MS) {
    user.last_activity_at = new Date();
    await User.update({ last_activity_at: user.last_activity_at }, { where: { id: user.id }, silent: true });
  }

  req.user = user;
  next();
});

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

const requirePermission = (...permissions) => (req, res, next) => {
  if (!permissions.every((p) => can(req.user, p))) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

module.exports = { authenticate, requireRole, requirePermission, signToken };
