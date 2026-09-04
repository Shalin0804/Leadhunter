const { User } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../middleware/auth');

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !user.is_active) throw ApiError.unauthorized('Invalid email or password');

  const valid = await user.verifyPassword(password);
  if (!valid) throw ApiError.unauthorized('Invalid email or password');

  user.last_login_at = new Date();
  await user.save();

  const token = signToken(user);
  return ok(res, { token, user: user.toSafeJSON() });
};

exports.me = async (req, res) => ok(res, { user: req.user.toSafeJSON() });

// Stateless JWT — logout is a client-side token discard. Endpoint kept for symmetry.
exports.logout = async (req, res) => ok(res, { message: 'Logged out' });
