const { Op } = require('sequelize');
const sequelize = require('../config/database');

const isPostgres = sequelize.getDialect() === 'postgres';

// Case-insensitive LIKE: MySQL's LIKE is already case-insensitive; Postgres needs ILIKE.
const likeOp = isPostgres ? Op.iLike : Op.like;

module.exports = { isPostgres, likeOp };
