const cds = require('@sap/cds');
const LOG = cds.log('admin-handler');

module.exports = cds.service.impl(async function () {

    this.on('adminApproveRejectWorkflow', async (req) => {
        const { applicationType, entityType, entityNumber, workflowId, remarks, action } = req.data;

        // ── Validate inputs ────────────────────────────────────────────────
        if (!workflowId || !workflowId.trim()) {
            return req.error(400, 'Workflow ID is required.');
        }
        if (!remarks || !remarks.trim()) {
            return req.error(400, 'Remarks are required.');
        }
        if (action !== 'APPROVE' && action !== 'REJECT') {
            return req.error(400, `Invalid action: ${action}. Must be APPROVE or REJECT.`);
        }

        const workflowSrv = await cds.connect.to('WorkflowService');
        const db = await cds.connect.to('db');
        const adminUser = req.user?.id || 'ADMIN';

        LOG.info(`[Admin Console] User '${adminUser}' performing ${action} on Workflow '${workflowId}'`);

        try {
            // ── 1. Find the workflow linkage ───────────────────────────────
            const wfLink = await db.run(
                SELECT.one.from('zmdr.MDRWorkflowLink').where({ MdrWorkflowId: workflowId })
            );

            if (!wfLink) {
                LOG.warn(`[Admin Console] Workflow ID ${workflowId} not found in MDRWorkflowLink.`);
                return { success: false, message: `Workflow ID ${workflowId} not found in the system.` };
            }

            LOG.info(`[Admin Console] Found BPA Instance: ${wfLink.BpaInstanceId} for Workflow: ${workflowId}`);

            // ── 2. Attempt to cancel the BPA workflow ──────────────────────
            try {
                if (wfLink.BpaInstanceId) {
                    const bpaClient = require('./lib/bpa-client');
                    await bpaClient.cancelBPAWorkflow(wfLink.BpaInstanceId);
                    LOG.info(`[Admin Console] BPA Workflow ${wfLink.BpaInstanceId} cancelled successfully.`);
                }
            } catch (bpaError) {
                // BPA might already be completed/cancelled — log and continue
                LOG.warn(`[Admin Console] BPA cancellation failed (may already be completed): ${bpaError.message}`);
            }

            // ── 3. Resolve entity details ──────────────────────────────────
            const resolvedEntityName = entityType || wfLink.TableName || 'UNKNOWN';
            const resolvedEntityId = entityNumber || 'UNKNOWN';
            const adminRemarks = `[Admin ${action} by ${adminUser}]: ${remarks}`;

            // ── 4. Perform the approve or reject ───────────────────────────
            if (action === 'APPROVE') {
                await workflowSrv.send('completeWFAudit', {
                    workflowId: workflowId,
                    entityId: resolvedEntityId,
                    entityName: resolvedEntityName,
                    userRemarks: adminRemarks
                });
                LOG.info(`[Admin Console] Workflow ${workflowId} APPROVED by admin '${adminUser}'.`);
            } else {
                await workflowSrv.send('pushRejectedAudit', {
                    workflowId: workflowId,
                    entityId: resolvedEntityId,
                    entityName: resolvedEntityName,
                    currentStage: 'ADMIN',
                    approverId: adminUser,
                    approverRemarks: adminRemarks,
                    action: 'REJECTED'
                });
                LOG.info(`[Admin Console] Workflow ${workflowId} REJECTED by admin '${adminUser}'.`);
            }

            return { success: true, message: `Workflow ${workflowId} successfully ${action === 'APPROVE' ? 'approved' : 'rejected'} by admin.` };

        } catch (error) {
            LOG.error(`[Admin Console] Critical error during ${action} on Workflow ${workflowId}:`, error);
            return { success: false, message: `Error processing request: ${error.message}` };
        }
    });
});
