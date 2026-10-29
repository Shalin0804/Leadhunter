const router = require('express').Router();
const ctrl = require('../controllers/pipelineController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { requirePermission } = require('../middleware/auth');
const { Lead } = require('../models');

router.get('/', requirePermission('leads.view'), asyncHandler(ctrl.board));
router.patch(
  '/leads/:id/move',
  requirePermission('leads.edit'),
  validate({ status: { required: true, in: Lead.STATUSES } }),
  asyncHandler(ctrl.move)
);

module.exports = router;
