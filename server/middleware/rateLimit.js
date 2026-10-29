const ApiError = require('../utils/ApiError');

/**
 * Fixed-window rate limiter keyed by `keyFn(req)`.
 * ponytail: in-memory, per process — move to a shared store (Redis) if the API runs multi-instance.
 */
function rateLimit({ windowMs, max, keyFn, message = 'Too many requests — please try again later' }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      if (hits.size > 10000) hits.clear(); // bound memory
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return next(new ApiError(429, message));
    }
    entry.count += 1;
    return next();
  };
}

module.exports = { rateLimit };
