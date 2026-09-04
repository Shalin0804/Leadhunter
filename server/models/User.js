const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      email: { type: DataTypes.STRING(180), allowNull: false, unique: true, validate: { isEmail: true } },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      role: { type: DataTypes.ENUM('admin', 'manager', 'agent'), allowNull: false, defaultValue: 'agent' },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'users' }
  );

  User.prototype.verifyPassword = function (plain) {
    return bcrypt.compare(plain, this.password_hash);
  };

  User.hashPassword = (plain) => bcrypt.hash(plain, 10);

  User.prototype.toSafeJSON = function () {
    const { id, name, email, role, is_active, last_login_at, created_at } = this.get();
    return { id, name, email, role, is_active, last_login_at, created_at };
  };

  return User;
};
