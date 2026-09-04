const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

router.use('/auth', require('./auth.routes'));

// Everything below requires a valid JWT.
router.use(authenticate);

router.use('/users', require('./user.routes'));
router.use('/companies', require('./company.routes'));
router.use('/discovery', require('./discovery.routes'));
router.use('/leads', require('./lead.routes'));
router.use('/pipeline', require('./pipeline.routes'));
router.use('/tasks', require('./task.routes'));
router.use('/notes', require('./note.routes'));
router.use('/imports', require('./import.routes'));
router.use('/dashboard', require('./dashboard.routes'));

module.exports = router;
