const router = require('express').Router();
const ctrl = require('../controllers/exploriumController');
const { asyncHandler } = require('../utils/http');
const { validate } = require('../middleware/validate');
const ApiError = require('../utils/ApiError');

// Per-user throttle on the calls that reach Explorium (their limit is 200 queries/min
// per key, and one search can use up to 3: two autocompletes + the fetch).
// ponytail: in-memory fixed window, per process — move to a shared store if the API ever runs multi-instance
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();
const throttle = (req, res, next) => {
  const now = Date.now();
  const entry = hits.get(req.user.id);
  if (!entry || now - entry.start >= WINDOW_MS) {
    hits.set(req.user.id, { start: now, count: 1 });
    return next();
  }
  if (entry.count >= MAX_PER_WINDOW) {
    return next(new ApiError(429, `Too many Explorium requests — try again in ${Math.ceil((entry.start + WINDOW_MS - now) / 1000)}s`));
  }
  entry.count += 1;
  return next();
};

// Mounted behind `authenticate` in routes/index.js — every route needs a valid JWT.
router.get('/status', throttle, asyncHandler(ctrl.status));
router.get('/stats', asyncHandler(ctrl.stats));
router.post('/search', throttle, validate(ctrl.searchSchema), asyncHandler(ctrl.search));
router.post('/import', asyncHandler(ctrl.import));

module.exports = router;
