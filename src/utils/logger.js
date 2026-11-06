// Very small logger with two jobs:
//   1. print timestamped ERROR lines to the console — errors and nothing else,
//      so the app stays quiet; set LOG_LEVEL (info / warn / debug) to bring the
//      other levels back when you need them
//   2. make sure secrets (API keys, tokens, passwords) are never printed

const util = require('util');

const SENSITIVE_KEY = /(secret|password|passwd|token|signature|apikey|api_key|api-key|authorization|jwt)/i;
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Errors only by default. LOG_LEVEL can opt back in to warn / info / debug.
function resolveLevel() {
  const wanted = (process.env.LOG_LEVEL || 'error').toLowerCase();
  return LEVELS[wanted] === undefined ? LEVELS.error : LEVELS[wanted];
}

const currentLevel = resolveLevel();

// Recursively replace sensitive values before anything is printed.
function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return copy;
}

function write(level, message, meta) {
  if (LEVELS[level] > currentLevel) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  const output = level === 'error' ? console.error : console.log;

  if (meta === undefined) {
    output(line);
    return;
  }
  output(line, util.inspect(redact(meta), { depth: 4, colors: false }));
}

module.exports = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
  redact,
};
