// HTTP layer for authentication. Passwords are hashed in the User model and
// are never returned by any endpoint.

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { sendSuccess } = require('../utils/helpers');

function signToken(userId) {
  return jwt.sign({ id: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

// POST /api/auth/register
async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      throw new AppError('name, email and password are all required', 400);
    }
    if (String(password).length < 6) {
      throw new AppError('Password must be at least 6 characters long', 400);
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      throw new AppError('An account with this email already exists', 409);
    }

    const user = await User.create({ name, email, password });

    logger.info(`New user registered: ${user.email}`);

    return sendSuccess(res, { user: user.toJSON(), token: signToken(user._id) }, 201);
  } catch (error) {
    next(error);
  }
}

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError('email and password are required', 400);
    }

    // "password" is not selected by default, so ask for it explicitly.
    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    const passwordMatches = await user.comparePassword(password);
    if (!passwordMatches) {
      throw new AppError('Invalid email or password', 401);
    }

    logger.info(`User logged in: ${user.email}`);

    return sendSuccess(res, { user: user.toJSON(), token: signToken(user._id) });
  } catch (error) {
    next(error);
  }
}

// GET /api/auth/me
async function me(req, res, next) {
  try {
    return sendSuccess(res, { user: req.user.toJSON() });
  } catch (error) {
    next(error);
  }
}

module.exports = { register, login, me };
