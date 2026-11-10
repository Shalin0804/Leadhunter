const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/financeController');
const { asyncHandler } = require('../utils/http');
const { MAX_FILE_BYTES } = require('../services/financeService');

// Mounted behind requirePermission('finance.manage') — Main Admin only. Not in
// agentService.AGENT_ROUTES, and finance.manage is in AGENT_DENIED, so the agent can't reach it.
// Files stay in memory and are type-checked by magic bytes in financeService.checkFile.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const file = (field) => upload.single(field);

router.get('/dashboard', asyncHandler(ctrl.dashboard));
router.get('/reports/:type', asyncHandler(ctrl.report));

router.get('/clients', asyncHandler(ctrl.listClients));
router.post('/clients', asyncHandler(ctrl.createClient));
router.get('/clients/:id', asyncHandler(ctrl.getClient));
router.put('/clients/:id', asyncHandler(ctrl.updateClient));
router.post('/clients/:id/:action(archive|restore)', asyncHandler(ctrl.archiveClient));

router.get('/projects', asyncHandler(ctrl.listProjects));
router.post('/projects', asyncHandler(ctrl.createProject));
router.get('/projects/:id', asyncHandler(ctrl.getProject));
router.put('/projects/:id', asyncHandler(ctrl.updateProject));
router.delete('/projects/:id', asyncHandler(ctrl.deleteProject));

router.get('/payments', asyncHandler(ctrl.listPayments));
router.post('/payments', file('receipt'), asyncHandler(ctrl.createPayment));
router.put('/payments/:id', file('receipt'), asyncHandler(ctrl.updatePayment));
router.post('/payments/:id/void', asyncHandler(ctrl.voidPayment));

router.get('/invoices', asyncHandler(ctrl.listInvoices));
router.post('/invoices', file('pdf'), asyncHandler(ctrl.createInvoice));
router.put('/invoices/:id', file('pdf'), asyncHandler(ctrl.updateInvoice));
router.delete('/invoices/:id', asyncHandler(ctrl.deleteInvoice));

router.get('/documents', asyncHandler(ctrl.listDocuments));
router.post('/documents', file('file'), asyncHandler(ctrl.uploadDocument));
router.get('/documents/:id/file', asyncHandler(ctrl.downloadDocument));
router.delete('/documents/:id', asyncHandler(ctrl.deleteDocument));

module.exports = router;
