const router = require('express').Router();
const ctrl = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/http');

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`,
  message: 'Too many sign-in attempts — please wait 15 minutes',
});
const setPasswordLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: (req) => req.ip });

router.post(
  '/login',
  loginLimit,
  validate({ email: { required: true, isEmail: true }, password: { required: true, minLength: 6 } }),
  asyncHandler(ctrl.login)
);
router.post(
  '/set-password',
  setPasswordLimit,
  validate({ token: { required: true, minLength: 20, maxLength: 200 }, password: { required: true, minLength: 8, maxLength: 128 } }),
  asyncHandler(ctrl.setPassword)
);
router.post('/logout', authenticate, asyncHandler(ctrl.logout));
router.get('/me', authenticate, asyncHandler(ctrl.me));

module.exports = router;
