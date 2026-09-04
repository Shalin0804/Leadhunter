const router = require('express').Router();
const ctrl = require('../controllers/userController');
const { requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

router.get('/', asyncHandler(ctrl.list));
router.post('/', requireRole('admin'), asyncHandler(ctrl.create));

module.exports = router;
