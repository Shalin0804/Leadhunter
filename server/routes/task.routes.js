const router = require('express').Router();
const ctrl = require('../controllers/taskController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');

router.get('/', asyncHandler(ctrl.list));
router.post('/', validate({ title: { required: true, minLength: 2, maxLength: 200 } }), asyncHandler(ctrl.create));
router.put('/:id', asyncHandler(ctrl.update));
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
