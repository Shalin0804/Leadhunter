const { User } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');

exports.list = async (req, res) => {
  const users = await User.findAll({ where: { is_active: true }, order: [['name', 'ASC']] });
  return ok(res, { users: users.map((u) => u.toSafeJSON()) });
};

exports.create = async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) throw ApiError.badRequest('name, email and password are required');
  const exists = await User.findOne({ where: { email: email.toLowerCase() } });
  if (exists) throw ApiError.conflict('A user with this email already exists');
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    password_hash: await User.hashPassword(password),
    role: ['admin', 'manager', 'agent'].includes(role) ? role : 'agent',
  });
  return ok(res, { user: user.toSafeJSON() }, 201);
};
