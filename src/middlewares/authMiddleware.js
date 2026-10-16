// Verifies the JWT sent in the Authorization header and loads the user.
// Trading endpoints use this so only logged-in users can reach them.

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const { AppError } = require('../utils/errorHandler');

async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      throw new AppError('Authentication required. Send a "Authorization: Bearer <token>" header.', 401);
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, config.jwt.secret);

    const user = await User.findById(decoded.id);
    if (!user) {
      throw new AppError('The user belonging to this token no longer exists', 401);
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    if (error.name === 'TokenExpiredError') {
      next(new AppError('Your session has expired. Please log in again.', 401));
      return;
    }
    if (error.name === 'JsonWebTokenError') {
      next(new AppError('Invalid authentication token', 401));
      return;
    }
    next(error);
  }
}

module.exports = { protect };
