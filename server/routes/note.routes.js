const router = require('express').Router();
const ctrl = require('../controllers/noteController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');

router.get('/', asyncHandler(ctrl.list));
router.post('/', validate({ body: { required: true, minLength: 1, maxLength: 5000 } }), asyncHandler(ctrl.create));
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
