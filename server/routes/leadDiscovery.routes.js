const router = require('express').Router();
const ctrl = require('../controllers/leadDiscoveryController');
const { requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/http');

const run = requirePermission('discovery.run');
const manage = requirePermission('settings.manage'); // global category definitions: Main Admin only
const runLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => `discover:${req.user.id}`, message: 'Discovery run limit reached for this hour' });

router.get('/options', run, asyncHandler(ctrl.options));
router.get('/categories', manage, asyncHandler(ctrl.listCategories));
router.post('/categories', manage, validate({ name: { required: true, minLength: 2, maxLength: 80 }, is_enabled: { type: 'boolean' } }), asyncHandler(ctrl.createCategory));
router.patch('/categories/:id', manage, validate({ is_enabled: { type: 'boolean' } }), asyncHandler(ctrl.updateCategory));
router.post('/run', run, runLimit, asyncHandler(ctrl.run));
router.get('/runs', run, asyncHandler(ctrl.runs));
router.get('/runs/:id/leads', run, asyncHandler(ctrl.runLeads));

module.exports = router;
