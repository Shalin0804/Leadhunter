const router = require('express').Router();
const ctrl = require('../controllers/leadController');
const exportCtrl = require('../controllers/leadExportController');
const { validate } = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/http');
const { Lead } = require('../models');

// Record-level scope (which leads) is enforced inside the controller via accessService;
// these guards enforce what the role may do at all.
const view = requirePermission('leads.view');
const edit = requirePermission('leads.edit');
const exp = requirePermission('leads.export');

// Bounds bulk scraping of contact details through the reveal endpoint.
const revealLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.CONTACT_REVEAL_LIMIT_PER_HOUR || '120', 10),
  keyFn: (req) => `reveal:${req.user.id}`,
  message: 'Contact reveal limit reached for this hour',
});

router.get('/', view, asyncHandler(ctrl.list));
router.get('/export', exp, asyncHandler(ctrl.exportCsv));
// Advanced Excel export (registered before /:id so "export" isn't read as an id).
router.get('/export/meta', exp, asyncHandler(exportCtrl.meta));
router.get('/export/history', exp, asyncHandler(exportCtrl.history));
router.post('/export/preview', exp, asyncHandler(exportCtrl.preview));
router.post('/export', exp, asyncHandler(exportCtrl.exportXlsx));
router.post('/assign', requirePermission('leads.assign'), asyncHandler(ctrl.assign));
router.get('/:id', view, asyncHandler(ctrl.get));
router.get('/:id/assignments', view, asyncHandler(ctrl.assignments));
router.post('/:id/contacts/:contactId/reveal', requirePermission('contacts.reveal'), revealLimit, asyncHandler(ctrl.revealContact));
router.post('/', requirePermission('leads.create'), validate({ company_id: { required: true, type: 'integer' } }), asyncHandler(ctrl.createFromCompany));
router.put('/:id', edit, asyncHandler(ctrl.update));
router.patch(
  '/:id/status',
  edit,
  validate({ status: { required: true, in: Lead.STATUSES } }),
  asyncHandler(ctrl.updateStatus)
);
router.patch(
  '/:id/contact',
  edit,
  validate({ method: { in: Lead.CONTACT_METHODS } }),
  asyncHandler(ctrl.contact)
);
router.patch(
  '/:id/contact-status',
  edit,
  validate({ contact_status: { required: true, in: Lead.CONTACT_STATUSES }, method: { in: Lead.CONTACT_METHODS } }),
  asyncHandler(ctrl.updateContactStatus)
);
router.patch(
  '/:id/lead-status',
  edit,
  validate({ lead_status: { required: true, in: Lead.LEAD_QUALIFICATION_STATUSES } }),
  asyncHandler(ctrl.updateLeadStatus)
);
router.post('/:id/recontact', edit, asyncHandler(ctrl.recontact));
router.post('/:id/ai/analyze', edit, asyncHandler(ctrl.analyzeAI));
router.post('/:id/ai/reanalyze', edit, asyncHandler(ctrl.reanalyzeAI));
router.delete('/:id', requirePermission('leads.delete'), asyncHandler(ctrl.remove));

module.exports = router;
