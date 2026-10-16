// The only place in the app that talks to the Delta Exchange REST API.
// Authentication/signing, timeouts, retries and error translation all live here
// so no other module has to repeat them.

const axios = require('axios');
const deltaConfig = require('../../config/deltaConfig');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errorHandler');
const { buildAuthHeaders, buildQueryString, sleep } = require('../../utils/helpers');

const httpClient = axios.create({
  baseURL: deltaConfig.baseUrl,
  timeout: deltaConfig.timeout,
  headers: { 'Content-Type': 'application/json' },
});

// Network level problems that are worth retrying.
const RETRYABLE_CODES = ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];

// Delta sends errors in a few different shapes. This flattens them all.
function extractDeltaError(data) {
  if (!data) return 'Unknown Delta Exchange error';
  if (typeof data === 'string') return data;
  if (typeof data.error === 'string') return data.error;
  if (data.error && data.error.code) return data.error.context?.error || data.error.code;
  if (data.message) return data.message;
  return 'Delta Exchange request failed';
}

function shouldRetry(error) {
  if (RETRYABLE_CODES.includes(error.code)) return true;
  return (error.response?.status ?? 0) >= 500;
}

function translateError(error, method, url) {
  if (error instanceof AppError) return error;

  if (RETRYABLE_CODES.includes(error.code)) {
    return new AppError(`Delta Exchange request timed out (${method} ${url})`, 504);
  }

  if (error.response) {
    const status = error.response.status;
    const message = extractDeltaError(error.response.data);
    return new AppError(
      `Delta Exchange error: ${message}`,
      status >= 400 && status < 500 ? status : 502
    );
  }

  return new AppError(`Unable to reach Delta Exchange (${method} ${url}): ${error.message}`, 502);
}

// Unwraps Delta's { success, result } envelope.
function extractResult(response, fallback = null) {
  if (response === undefined || response === null) return fallback;
  if (response.result !== undefined) return response.result;
  return response;
}

async function request({ method, path, params, body, auth = true, retry = true }) {
  const queryString = buildQueryString(params);
  const url = queryString ? `${path}?${queryString}` : path;

  // The body is stringified once so the signature always matches what is sent.
  const rawBody = body ? JSON.stringify(body) : '';

  const headers = { 'Content-Type': 'application/json' };

  if (auth) {
    if (!deltaConfig.apiKey || !deltaConfig.apiSecret) {
      throw new AppError(
        'Delta Exchange API credentials are not configured. Add DELTA_API_KEY and DELTA_API_SECRET to your .env file.',
        500
      );
    }
    // Never log these headers.
    Object.assign(headers, buildAuthHeaders({ method, path, queryString, rawBody }));
  }

  const attempts = retry ? deltaConfig.maxRetries + 1 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      logger.debug(`Delta API ${method} ${url}${auth ? '' : ' (public)'}`);

      const response = await httpClient.request({
        method,
        url,
        headers,
        data: rawBody || undefined,
      });

      return response.data;
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error) || attempt === attempts) break;

      logger.warn(`Delta API ${method} ${url} failed (attempt ${attempt}/${attempts}), retrying`);
      await sleep(400 * attempt);
    }
  }

  throw translateError(lastError, method, url);
}

module.exports = {
  baseUrl: deltaConfig.baseUrl,
  extractResult,

  // True when API keys are present in the environment.
  isConfigured: () => Boolean(deltaConfig.apiKey && deltaConfig.apiSecret),

  // Signed (private) requests.
  get: (path, params, options = {}) => request({ method: 'GET', path, params, ...options }),
  post: (path, body, options = {}) => request({ method: 'POST', path, body, ...options }),
  delete: (path, body, options = {}) => request({ method: 'DELETE', path, body, ...options }),

  // Unsigned (public) requests used for market data.
  publicGet: (path, params) => request({ method: 'GET', path, params, auth: false }),

  // Exposed for advanced use / tests.
  request,
};
