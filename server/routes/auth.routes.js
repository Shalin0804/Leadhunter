const router = require('express').Router();
const ctrl = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');

router.post(
  '/login',
  validate({ email: { required: true, isEmail: true }, password: { required: true, minLength: 6 } }),
  asyncHandler(ctrl.login)
);
router.post('/logout', authenticate, asyncHandler(ctrl.logout));
router.get('/me', authenticate, asyncHandler(ctrl.me));

module.exports = router;
