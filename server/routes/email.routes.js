const router = require('express').Router();
const ctrl = require('../controllers/emailController');
const { asyncHandler } = require('../utils/http');
const { rateLimit } = require('../middleware/rateLimit');

// Mounted behind requirePermission('email.send') — Main Admin only. The Claude Code
// agent token is denied email.send and none of these paths are in agentService.AGENT_ROUTES.
const sendLimit = rateLimit({ windowMs: 60 * 1000, max: parseInt(process.env.EMAIL_SEND_RATE_PER_MIN || '20', 10), keyFn: (req) => `email:${req.user.id}`, message: 'Too many send requests — slow down' });

router.get('/settings', asyncHandler(ctrl.settings));
router.post('/settings/test-connection', sendLimit, asyncHandler(ctrl.testConnection));
router.post('/settings/test-email', sendLimit, asyncHandler(ctrl.testEmail));

router.get('/messages', asyncHandler(ctrl.recent));
router.post('/generate', asyncHandler(ctrl.generate));
router.post('/messages', asyncHandler(ctrl.saveDraft));
router.put('/messages/:id', asyncHandler(ctrl.updateDraft));
router.delete('/messages/:id', asyncHandler(ctrl.removeDraft));
router.post('/messages/:id/send', sendLimit, asyncHandler(ctrl.send));

router.get('/leads/:leadId', asyncHandler(ctrl.leadOverview));
router.post('/leads/:leadId/claude-draft', asyncHandler(ctrl.claudeDraft));

router.get('/campaigns', asyncHandler(ctrl.listCampaigns));
router.post('/campaigns', asyncHandler(ctrl.prepareCampaign));
router.get('/campaigns/:id', asyncHandler(ctrl.getCampaign));
router.post('/campaigns/:id/send', sendLimit, asyncHandler(ctrl.startCampaign));
router.post('/campaigns/:id/cancel', asyncHandler(ctrl.cancelCampaign));

router.get('/follow-ups', asyncHandler(ctrl.followUps));
router.post('/replies/sync', sendLimit, asyncHandler(ctrl.syncReplies));

module.exports = router;
