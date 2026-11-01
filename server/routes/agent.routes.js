const router = require('express').Router();
const ctrl = require('../controllers/agentController');
const sales = require('../controllers/salesController');
const { asyncHandler } = require('../utils/http');
const ApiError = require('../utils/ApiError');

// Mounted behind requirePermission('agent.manage') — Main Admin only.

// Bridge: only the MCP server (agent token) may report heartbeats or work tasks, so a
// browser session can never fake a "Connected" status. The agent token can reach
// nothing else under /agent (see agentService.AGENT_ROUTES).
const bridge = require('express').Router();
bridge.use((req, res, next) => next(req.agent ? undefined : ApiError.forbidden('Agent token required')));
bridge.post('/heartbeat', asyncHandler(ctrl.heartbeat));
bridge.post('/disconnect', asyncHandler(ctrl.disconnect));
bridge.get('/status', asyncHandler(ctrl.bridgeStatus));
bridge.post('/tasks/claim', asyncHandler(ctrl.claim));
bridge.post('/tasks/:id/complete', asyncHandler(ctrl.complete));
bridge.post('/tasks/:id/fail', asyncHandler(ctrl.fail));
bridge.post('/reports', asyncHandler(ctrl.saveReport));
bridge.get('/reports', asyncHandler(ctrl.bridgeReports));
bridge.post('/outreach', asyncHandler(ctrl.createDraft));
bridge.post('/proposals', asyncHandler(ctrl.propose));
bridge.post('/playbooks', asyncHandler(sales.savePlaybook));
bridge.get('/playbooks/:leadId', asyncHandler(sales.playbookContext));
bridge.get('/research/company/:id', asyncHandler(ctrl.researchCompany));
bridge.get('/research/lead/:id', asyncHandler(ctrl.researchLead));
bridge.get('/report-data', asyncHandler(ctrl.reportData));
router.use('/bridge', bridge);

router.get('/overview', asyncHandler(ctrl.overview));
router.post('/control', asyncHandler(ctrl.control));
router.post('/token', asyncHandler(ctrl.issueToken));
router.delete('/token', asyncHandler(ctrl.revokeToken));
router.get('/tasks', asyncHandler(ctrl.listTasks));
router.post('/tasks', asyncHandler(ctrl.createTask));
router.get('/tasks/:id', asyncHandler(ctrl.getTask));
router.post('/tasks/:id/:action(pause|resume|cancel|retry)', asyncHandler(ctrl.taskAction));
router.post('/tasks/:id/:decision(approve|reject)', asyncHandler(ctrl.decideProposal));
router.get('/activity', asyncHandler(ctrl.listActivity));
router.get('/reports', asyncHandler(ctrl.listReports));
router.get('/reports/:id', asyncHandler(ctrl.getReport));
router.get('/outreach', asyncHandler(ctrl.listDrafts));
router.put('/outreach/:id', asyncHandler(ctrl.editDraft));
router.post('/outreach/:id/:decision(approve|reject)', asyncHandler(ctrl.decideDraft));
router.get('/analytics', asyncHandler(ctrl.analytics));
router.get('/sales/overview', asyncHandler(sales.overview));
router.get('/sales/leads/:leadId', asyncHandler(sales.lead));
router.post('/sales/leads/:leadId/queue', asyncHandler(sales.queue));
router.put('/sales/playbooks/:id', asyncHandler(sales.editPlaybook));
router.post('/sales/playbooks/:id/follow-ups', asyncHandler(sales.scheduleFollowUps));
router.post('/outreach/:id/sent', asyncHandler(sales.markSent));
router.get('/config', asyncHandler(ctrl.getConfig));
router.put('/config', asyncHandler(ctrl.updateConfig));

module.exports = router;
