const router = require('express').Router();
const ctrl = require('../controllers/noteController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { requirePermission } = require('../middleware/auth');

const edit = requirePermission('leads.edit');

router.get('/', requirePermission('leads.view'), asyncHandler(ctrl.list));
router.post('/', edit, validate({ body: { required: true, minLength: 1, maxLength: 5000 } }), asyncHandler(ctrl.create));
router.delete('/:id', edit, asyncHandler(ctrl.remove));

module.exports = router;
