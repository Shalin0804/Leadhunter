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
router.patch(
  '/:id/contact',
  validate({ method: { in: Lead.CONTACT_METHODS } }),
  asyncHandler(ctrl.contact)
);
router.patch(
  '/:id/contact-status',
  validate({ contact_status: { required: true, in: Lead.CONTACT_STATUSES }, method: { in: Lead.CONTACT_METHODS } }),
  asyncHandler(ctrl.updateContactStatus)
);
router.patch(
  '/:id/lead-status',
  validate({ lead_status: { required: true, in: Lead.LEAD_QUALIFICATION_STATUSES } }),
  asyncHandler(ctrl.updateLeadStatus)
);
router.post('/:id/recontact', asyncHandler(ctrl.recontact));
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
