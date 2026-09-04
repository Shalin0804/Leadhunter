const router = require('express').Router();
const ctrl = require('../controllers/pipelineController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { Lead } = require('../models');

router.get('/', asyncHandler(ctrl.board));
router.patch(
  '/leads/:id/move',
  validate({ status: { required: true, in: Lead.STATUSES } }),
  asyncHandler(ctrl.move)
);

module.exports = router;
