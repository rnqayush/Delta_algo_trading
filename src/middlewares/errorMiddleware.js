// Global error handling.
// Every error response uses the same shape: { success: false, message: "..." }

const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

// Reached when no route matched the request.
function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong';

  // --- Mongoose / MongoDB errors -------------------------------------------
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for "${err.path}": ${err.value}`;
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((item) => item.message)
      .join(', ');
  } else if (err.code === 11000) {
    statusCode = 409;
    message = `Duplicate value for: ${Object.keys(err.keyValue || {}).join(', ')}`;
  } else if (err.name === 'MongooseServerSelectionError') {
    statusCode = 503;
    message = 'Database is unavailable. Please try again in a moment.';
  }
  // --- JSON body parsing errors --------------------------------------------
  else if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Request body contains invalid JSON';
  }

  // Unexpected (non-operational) errors are logged with the full stack so they
  // can be debugged. Secrets are redacted by the logger.
  if (statusCode >= 500) {
    logger.error(`Unexpected error: ${message}`, err);
  } else {
    logger.debug(`Request error (${statusCode}): ${message}`);
  }

  res.status(statusCode).json({ success: false, message });
}

module.exports = { notFoundHandler, errorHandler };
