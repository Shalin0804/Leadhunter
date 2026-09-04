const ApiError = require('../utils/ApiError');

/**
 * Tiny schema validator — no external dependency.
 * schema: { field: { required, type, in, min, max, minLength, maxLength, isEmail, default } }
 * Validates and coerces req[source]; throws ApiError.badRequest on failure.
 */
const TYPES = {
  string: (v) => (typeof v === 'string' ? v : String(v)),
  number: (v) => {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error('must be a number');
    return n;
  },
  integer: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error('must be an integer');
    return n;
  },
  boolean: (v) => {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1' || v === 1) return true;
    if (v === 'false' || v === '0' || v === 0) return false;
    throw new Error('must be a boolean');
  },
  date: (v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error('must be a valid date');
    return d;
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validate = (schema, source = 'body') => (req, res, next) => {
  const data = req[source] || {};
  const out = {};
  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    let value = data[field];

    if (value === undefined || value === null || value === '') {
      if (rules.default !== undefined) {
        out[field] = typeof rules.default === 'function' ? rules.default() : rules.default;
      } else if (rules.required) {
        errors.push({ field, message: 'is required' });
      }
      continue;
    }

    try {
      if (rules.type && TYPES[rules.type]) value = TYPES[rules.type](value);
    } catch (e) {
      errors.push({ field, message: e.message });
      continue;
    }

    if (rules.isEmail && !EMAIL_RE.test(value)) errors.push({ field, message: 'must be a valid email' });
    if (rules.in && !rules.in.includes(value)) errors.push({ field, message: `must be one of: ${rules.in.join(', ')}` });
    if (rules.minLength && String(value).length < rules.minLength)
      errors.push({ field, message: `must be at least ${rules.minLength} characters` });
    if (rules.maxLength && String(value).length > rules.maxLength)
      errors.push({ field, message: `must be at most ${rules.maxLength} characters` });
    if (rules.min !== undefined && value < rules.min) errors.push({ field, message: `must be >= ${rules.min}` });
    if (rules.max !== undefined && value > rules.max) errors.push({ field, message: `must be <= ${rules.max}` });

    out[field] = value;
  }

  if (errors.length) return next(ApiError.badRequest('Validation failed', errors));

  req[`valid_${source}`] = out;
  // also merge coerced values back for convenience
  req[source] = { ...data, ...out };
  next();
};

module.exports = { validate };
