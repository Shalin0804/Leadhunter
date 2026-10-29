const router = require('express').Router();
const ctrl = require('../controllers/contactController');
const { requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

router.get('/', requirePermission('leads.view'), asyncHandler(ctrl.list));

module.exports = router;
