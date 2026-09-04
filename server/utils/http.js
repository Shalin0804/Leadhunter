/** Consistent JSON envelopes + async wrapper. */

const ok = (res, data = {}, status = 200) => res.status(status).json({ success: true, data });

const fail = (res, message = 'Error', status = 400, details) =>
  res.status(status).json({ success: false, message, ...(details ? { details } : {}) });

// Wrap async route handlers so rejected promises hit the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse pagination query params with sane bounds. */
const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  return { page, limit, offset: (page - 1) * limit };
};

const paginated = (rows, count, page, limit) => ({
  items: rows,
  pagination: {
    page,
    limit,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / limit)),
  },
});

module.exports = { ok, fail, asyncHandler, parsePagination, paginated };
