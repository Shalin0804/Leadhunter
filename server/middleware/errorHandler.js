const config = require('../config/config');

// 404 for unmatched routes
const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// Centralized error handler — always emits { success:false, message }
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let status = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details;

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    status = 400;
    details = err.errors?.map((e) => ({ field: e.path, message: e.message }));
    message = 'Validation failed';
  } else if (err.name === 'SequelizeForeignKeyConstraintError') {
    status = 400;
    message = 'Related record not found or still referenced';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    status = 400;
    message = 'Uploaded file is too large';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }

  res.status(status).json({
    success: false,
    message,
    ...(details ? { details } : {}),
    ...(config.nodeEnv === 'development' && status >= 500 ? { stack: err.stack } : {}),
  });
};

module.exports = { notFoundHandler, errorHandler };
