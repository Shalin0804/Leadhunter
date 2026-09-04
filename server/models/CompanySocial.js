const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CompanySocial',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      platform: {
        type: DataTypes.ENUM('linkedin', 'facebook', 'instagram', 'twitter', 'youtube', 'other'),
        allowNull: false,
      },
      url: { type: DataTypes.STRING(255), allowNull: false },
    },
    {
      tableName: 'company_socials',
      indexes: [{ fields: ['company_id'] }],
    }
  );
};
