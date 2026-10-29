const router = require('express').Router();
const ctrl = require('../controllers/taskController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { requirePermission } = require('../middleware/auth');

const edit = requirePermission('leads.edit');

router.get('/', requirePermission('leads.view'), asyncHandler(ctrl.list));
router.post('/', edit, validate({ title: { required: true, minLength: 2, maxLength: 200 } }), asyncHandler(ctrl.create));
router.put('/:id', edit, asyncHandler(ctrl.update));
router.delete('/:id', edit, asyncHandler(ctrl.remove));

module.exports = router;
