const router = require('express').Router();
const ctrl = require('../controllers/leadController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { Lead } = require('../models');

router.get('/', asyncHandler(ctrl.list));
router.get('/export', asyncHandler(ctrl.exportCsv));
router.get('/:id', asyncHandler(ctrl.get));
router.post('/', validate({ company_id: { required: true, type: 'integer' } }), asyncHandler(ctrl.createFromCompany));
router.put('/:id', asyncHandler(ctrl.update));
router.patch(
  '/:id/status',
  validate({ status: { required: true, in: Lead.STATUSES } }),
  asyncHandler(ctrl.updateStatus)
);
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
