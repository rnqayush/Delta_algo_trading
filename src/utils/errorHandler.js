// A single error type used across the application.
// Errors we create ourselves carry an HTTP status code, so the global error
// middleware knows exactly how to respond.

class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    // "Operational" errors are expected (bad input, rejected order, timeout).
    // Unexpected programming errors are not operational and get logged in full.
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
