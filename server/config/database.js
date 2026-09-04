const { Sequelize } = require('sequelize');
const config = require('./config');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: config.db.dialect,
  logging: config.nodeEnv === 'development' ? false : false,
  define: {
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
});

module.exports = sequelize;
