const router = require('express').Router();
const ctrl = require('../controllers/userController');
const { requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { ROLES } = require('../config/permissions');

// Listing is scoped inside the controller; every write is Main Admin only.
router.get('/', asyncHandler(ctrl.list));
router.post(
  '/invite',
  requirePermission('users.manage'),
  validate({ name: { required: true, minLength: 2, maxLength: 120 }, email: { required: true, isEmail: true, maxLength: 180 }, role: { in: ROLES } }),
  asyncHandler(ctrl.invite)
);
// Kept for existing API clients: same as /invite (no admin-chosen passwords any more).
router.post(
  '/',
  requirePermission('users.manage'),
  validate({ name: { required: true, minLength: 2, maxLength: 120 }, email: { required: true, isEmail: true, maxLength: 180 }, role: { in: ROLES } }),
  asyncHandler(ctrl.invite)
);
router.patch('/:id', requirePermission('users.manage'), validate({ role: { in: ROLES }, is_active: { type: 'boolean' } }), asyncHandler(ctrl.update));
router.post('/:id/reset-password', requirePermission('users.manage'), asyncHandler(ctrl.resetPassword));

module.exports = router;
