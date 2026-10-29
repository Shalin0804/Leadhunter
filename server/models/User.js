const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      email: { type: DataTypes.STRING(180), allowNull: false, unique: true, validate: { isEmail: true } },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      // admin = Main Admin, agent = BDE / Sales Executive (see config/permissions.js).
      role: { type: DataTypes.ENUM('admin', 'manager', 'agent', 'viewer'), allowNull: false, defaultValue: 'agent' },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
      last_activity_at: { type: DataTypes.DATE, allowNull: true },
      // The manager whose team this user belongs to (managers see their team's leads).
      manager_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // JWTs issued before this moment are rejected (set on password change).
      password_changed_at: { type: DataTypes.DATE, allowNull: true },
      // Set on logout: every JWT issued before it is rejected (logout ends the user's sessions).
      sessions_revoked_at: { type: DataTypes.DATE, allowNull: true },
      // One-time invite / password-reset token — only its SHA-256 is stored.
      set_password_token_hash: { type: DataTypes.STRING(64), allowNull: true },
      set_password_expires_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'users', indexes: [{ fields: ['manager_id'] }] }
  );

  // Marker for an invited account that has not set a password yet — never a valid bcrypt hash.
  User.NO_PASSWORD = '!invited';

  User.prototype.verifyPassword = function (plain) {
    if (!this.password_hash || this.password_hash === User.NO_PASSWORD) return Promise.resolve(false);
    return bcrypt.compare(plain, this.password_hash);
  };

  User.hashPassword = (plain) => bcrypt.hash(plain, 10);

  User.hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

  /** Issue a one-time invite/reset token (returned once, only its hash is stored). */
  User.prototype.issueSetPasswordToken = async function (ttlHours = 72) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.set_password_token_hash = User.hashToken(token);
    this.set_password_expires_at = new Date(Date.now() + ttlHours * 3600 * 1000);
    await this.save();
    return token;
  };

  User.prototype.toSafeJSON = function () {
    const { id, name, email, role, is_active, last_login_at, last_activity_at, manager_id, created_at } = this.get();
    const status = !is_active ? 'inactive' : this.password_hash === User.NO_PASSWORD ? 'invited' : 'active';
    return { id, name, email, role, is_active, status, last_login_at, last_activity_at, manager_id, created_at };
  };

  return User;
};
