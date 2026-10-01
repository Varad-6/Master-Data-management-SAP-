// srv/workflow-service.js
'use strict';
const cds = require('@sap/cds');
const bpa = require('./lib/bpa-client');
const { extractUserInfo } = require('./lib/wf-utilities');
const { generateWorkflowId } = require('./lib/wf-id');

module.exports = cds.service.impl(async function (srv) {

    srv.on('CREATE', 'TriggerWorkflowSet', async (req) => {
        console.log(`[Workflow Handler] CREATE triggered for TriggerWorkflowSet`);
        console.log("Payload:", JSON.stringify(req.data, null, 2));

        // Use supplied workflow ID or generate sequentially from MDR number ranges
        const workflowId = req.data.WorkflowId || (await generateWorkflowId(req.data.ProcessCode || 'CENTRAL'));
        
        try {
            const userInfo = extractUserInfo(req, {
                requestorId: req.data.RequestorId,
                requestorEmail: req.data.RequestorEmail,
                requestorName: req.data.RequestorName
            });
            const authUserId = userInfo.id;
            const authEmail = userInfo.email;
            const authName = userInfo.name;



            // Build the context object expected by BPA
            const ctx = {
                workflowid: workflowId,
                tablename: req.data.Tablename || '',
                entityid: req.data.EntityId || '',
                entityname: req.data.EntityName || '',
                operationtype: req.data.OperationType || '',
                requestorid: authUserId,
                requestoremail: authEmail,
                requestorname: authName,
                requesterrole: 'MDR_REQUESTOR',
                userremarks: req.data.UserRemarks || '',
                initialstage: 'LEVEL1', // Default for now
                currentstage: 'LEVEL1',
                processid: '',
                totalsteps: 1, 
                adminemail: authEmail, 
                capbaseurl: process.env.CAP_BASE_URL || ''
            };

            // Trigger the correct workflow based on the UI identifier
            if (req.data.WorkflowIdentifier === "CENTRAL") {
                console.log("[Workflow Handler] Triggering Central Approval Workflow");
                await bpa.startCentralApprovalWorkflow(ctx);
            } else if (req.data.WorkflowIdentifier === "BULK") {
                console.log("[Workflow Handler] Triggering Bulk Approval Workflow");
                await bpa.startBulkApprovalWorkflow(ctx);
            } else {
                console.warn("[Workflow Handler] Unknown WorkflowIdentifier, skipping BPA trigger:", req.data.WorkflowIdentifier);
            }
            
            // Return the payload back to UI upon success
            return {
                WorkflowId: workflowId,
                EntityName: req.data.EntityName,
                EntityId: req.data.EntityId,
                Tablename: req.data.Tablename,
                OperationType: req.data.OperationType,
                UserRemarks: req.data.UserRemarks,
                WorkflowIdentifier: req.data.WorkflowIdentifier
            };
        } catch (error) {
            console.error("[Workflow Handler] Failed to trigger BPA Workflow:", error);
            req.error(500, `Failed to trigger workflow in SAP Build: ${error.message}`);
        }
    });

    // ── READ UserRemarksSet ──────────────────────────────────────────────
    srv.on('READ', 'UserRemarksSet', async (req) => {
        const db = await cds.connect.to('db');
        const { WFAudit } = db.entities('zmdr');
        
        const workflowId = req.data?.WorkflowId || (req.params && req.params[0] && req.params[0].WorkflowId);
        if (!workflowId) {
            return [];
        }

        try {
            const auditRows = await db.run(
                SELECT.from(WFAudit).where(`WorkflowId = '${workflowId}' or workflowid = '${workflowId}'`)
            );

            const reqAudit = auditRows.find(r => (r.Action === 'INITIATED' || r.action === 'INITIATED')) || {};
            const appAudit = auditRows.find(r => (r.Action === 'APPROVED' || r.Action === 'REJECTED' || r.action === 'APPROVED' || r.action === 'REJECTED')) || {};

            const result = {
                WorkflowId: workflowId,
                EntityId: req.data?.EntityId || reqAudit.EntityId || reqAudit.entityid || '',
                EntityName: req.data?.EntityName || reqAudit.EntityName || reqAudit.entityname || '',
                CurrentStage: req.data?.CurrentStage || '',
                RequestorId: reqAudit.ActioningUser || reqAudit.actioninguser || '',
                RequestorName: reqAudit.ActioningUser || reqAudit.actioninguser || '',
                RequestorEmail: reqAudit.ActioningUser || reqAudit.actioninguser || '',
                RequestorRemarks: reqAudit.UserRemarks || reqAudit.userremarks || '',
                ApproverId: appAudit.ActioningUser || appAudit.actioninguser || '',
                ApproverName: appAudit.ActioningUser || appAudit.actioninguser || '',
                ApproverEmail: appAudit.ActioningUser || appAudit.actioninguser || '',
                ApproverRemarks: appAudit.UserRemarks || appAudit.userremarks || ''
            };

            return req.params && req.params.length ? result : [result];
        } catch (err) {
            console.error("Error reading UserRemarksSet:", err);
            return [];
        }
    });

    // ── resolveApprovers ─────────────────────────────────────────────────
    srv.on('resolveApprovers', async (req) => {
        console.log("[Workflow Handler] resolveApprovers called with:", req.data);
        const { tablename, currentStage, processId, requesterRole, requestorId, apprClass } = req.data;
        const { getApprovers } = require('./lib/wf-utilities');

        try {
            // Determine app identifier: bulk workflows usually pass apprClass directly, central pass processId
            const appidentifier = processId ? 'CENTRAL' : 'BULK';

            let system = '', hierarchy = '', subclass = currentStage;
            if (apprClass) {
                const parts = apprClass.split(',');
                if (parts.length >= 3) {
                    system = parts[0].trim();
                    hierarchy = parts[1].trim();
                    subclass = parts[2].trim();
                }
            }

            const result = await getApprovers({
                appidentifier,
                system,
                hierarchy,
                subclass,
                requesterid: requestorId,
                processid: processId,
                tablename,
                saprole: requesterRole
            });

            if (!result || !result.approvers || result.approvers.length === 0) {
                console.warn("[Workflow Handler] No approvers found for context:", req.data);
                return [];
            }

            return result.approvers.map(a => ({
                approverEmail: a.approveremail || a.approverid,
                approverId: a.approverid,
                nextStage: result.nextstage || ''
            }));
        } catch (err) {
            console.error("[Workflow Handler] resolveApprovers error:", err);
            return [];
        }
    });

    // ── insertWFAudit (generic audit writer) ─────────────────────────────
    srv.on('insertWFAudit', async (req) => {
        const actionStr = (req.data.action || req.data.Action || '').toUpperCase();
        console.log(`[Workflow Handler] insertWFAudit (${actionStr}) called for ${req.data.workflowId || req.data.workflowid}`);
        
        // Intercept approval/rejection to apply central data updates (I -> Y/N)
        if (actionStr === 'APPROVED' || actionStr === 'COMPLETE') {
            try {
                const { approveCentralRecord } = require('./lib/insert');
                const workflowId = req.data.workflowId || req.data.workflowid;
                const entityName = req.data.entityName || req.data.entityname || req.data.EntityName;
                const userId = req.data.actioningUser || req.data.actioninguser || 'MDR_SYSTEM';
                await approveCentralRecord({ workflowid: workflowId, tablename: entityName, userId: userId });
            } catch (e) {
                console.warn("[Workflow Service] Central promotion failed on APPROVED:", e.message);
            }
        } else if (actionStr === 'REJECTED') {
            try {
                const { rejectCentralRecord } = require('./lib/insert');
                const workflowId = req.data.workflowId || req.data.workflowid;
                const entityName = req.data.entityName || req.data.entityname || req.data.EntityName;
                const userId = req.data.actioningUser || req.data.actioninguser || 'MDR_SYSTEM';
                await rejectCentralRecord({ workflowid: workflowId, tablename: entityName, userId: userId });
            } catch (e) {
                console.warn("[Workflow Service] Central rejection failed on REJECTED:", e.message);
            }
        }

        // Skip inserting 'INPROGRESS' into audit log to prevent the 4th redundant record as per old behavior
        if (actionStr === 'INPROGRESS') {
            console.log(`[Workflow Handler] Skipping audit log insertion for action: ${actionStr}`);
            return { success: true };
        }

        const { insertWFAudit } = require('./lib/wf-utilities');
        return await insertWFAudit(req.data);
    });

    // Specific Audit Writers
    srv.on('pushInprogressAudit', async (req) => {
        const { workflowId, entityId, entityName, currentStage, approverId, tablename, userRemarks } = req.data;
        return srv.send('insertWFAudit', {
            workflowId,
            entityId,
            entityName: entityName || tablename,
            wfStage: currentStage,
            action: 'INPROGRESS',
            actioningUser: approverId,
            userRemarks: userRemarks || req.data.userremarks || req.data.UserRemarks || ''
        });
    });
    
    srv.on('pushApprovedAudit', async (req) => {
        let { workflowId, entityId, entityName, currentStage, approverId, approverRemarks, updatedData } = req.data;
        try {
            const db = await cds.connect.to('db');

            // Resolve entityName from MDRWorkflowLink if not provided in the request
            if (!entityName) {
                try {
                    const { MDRWorkflowLink } = db.entities('zmdr');
                    const link = await db.run(SELECT.one.from(MDRWorkflowLink).where({ MdrWorkflowId: workflowId }));
                    if (link) {
                        entityName = link.TableName || link.tablename || '';
                        console.log(`[Workflow Service] Resolved entityName='${entityName}' from MDRWorkflowLink for workflow ${workflowId}`);
                    }
                } catch (linkErr) {
                    console.warn("[Workflow Service] Could not resolve entityName from MDRWorkflowLink:", linkErr.message);
                }
            }

            if (updatedData) {
                try {
                    const parsedData = JSON.parse(updatedData);
                    const { resolveMasterTable } = require('./lib/insert');
                    const resolvedTable = await resolveMasterTable(entityName, workflowId, db);
                    if (resolvedTable && Object.keys(parsedData).length > 0) {
                        // Strip non-entity fields like __metadata which cause CAP UPDATE to fail
                        if (parsedData.__metadata) {
                            delete parsedData.__metadata;
                        }
                        
                        // Apply updates directly to the In Progress (I) draft before promotion
                        const { updateRow } = require('./lib/db-dynamic');
                        await updateRow(db, resolvedTable, parsedData, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowId, 'I']);
                        console.log(`[Workflow Service] Successfully applied Fiori UI edits to draft ${workflowId}`);
                    }
                } catch (parseError) {
                    console.warn("[Workflow Service] Failed to parse or apply updatedData from Fiori:", parseError.message);
                }
            }

            // Resolve entityId from the draft record if not provided
            if (!entityId && entityName) {
                try {
                    const { resolveMasterTable } = require('./lib/insert');
                    const resolvedTable = await resolveMasterTable(entityName, workflowId, db);
                    if (resolvedTable) {
                        const { readRows } = require('./lib/db-dynamic');
                        const draftRows = await readRows(db, resolvedTable, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowId, 'I']).catch(() => []);
                        if (draftRows && draftRows.length > 0) {
                            entityId = draftRows[0].BpId || draftRows[0].BP_ID || draftRows[0].BPID || Object.values(draftRows[0])[0] || '';
                        }
                    }
                } catch (idErr) {
                    console.warn("[Workflow Service] Could not resolve entityId:", idErr.message);
                }
            }

            const { approveCentralRecord } = require('./lib/insert');
            await approveCentralRecord({ workflowid: workflowId, tablename: entityName, userId: approverId || req.user?.id || 'MDR_APPROVER' });
        } catch (e) {
            console.warn("[Workflow Service] Note on Central promotion during pushApprovedAudit:", e.message);
        }
        return srv.send('insertWFAudit', {
            workflowId,
            entityId: entityId || '',
            entityName: entityName || '',
            wfStage: currentStage || 'APPROVER',
            action: 'APPROVED',
            actioningUser: approverId || req.user?.id || 'MDR_APPROVER',
            userRemarks: approverRemarks || req.data.userRemarks || req.data.userremarks || ''
        });
    });

    srv.on('pushRejectedAudit', async (req) => {
        const { workflowId, entityId, entityName, currentStage, approverId, approverRemarks, action } = req.data;
        try {
            const { rejectCentralRecord } = require('./lib/insert');
            await rejectCentralRecord({ workflowid: workflowId, tablename: entityName, userId: approverId });
        } catch (e) {
            console.warn("[Workflow Service] Note on Central rejection during pushRejectedAudit:", e.message);
        }
        return srv.send('insertWFAudit', {
            workflowId,
            entityId,
            entityName,
            wfStage: currentStage || 'APPROVER',
            action: 'REJECTED',
            actioningUser: approverId,
            userRemarks: approverRemarks || req.data.userRemarks || req.data.userremarks || ''
        });
    });

    srv.on('completeWFAudit', async (req) => {
        const { workflowId, entityId, entityName, userRemarks } = req.data;
        try {
            const { approveCentralRecord } = require('./lib/insert');
            await approveCentralRecord({ workflowid: workflowId, tablename: entityName, userId: 'MDR_SYSTEM' });
        } catch (e) {
            console.warn("[Workflow Service] Note on Central promotion during completeWFAudit:", e.message);
        }
        return srv.send('insertWFAudit', {
            workflowId,
            entityId,
            entityName,
            wfStage: 'COMPLETE',
            action: 'COMPLETE',
            actioningUser: 'MDR_SYSTEM',
            userRemarks: userRemarks || req.data.userremarks || req.data.UserRemarks || ''
        });
    });

    srv.on('initiatedWFAudit', async (req) => {
        const { workflowId, entityId, entityName, operationType, requestorId, userRemarks } = req.data;
        return srv.send('insertWFAudit', {
            workflowId,
            entityId,
            entityName,
            operationType,
            wfStage: 'INITIATED',
            action: 'INITIATED',
            actioningUser: requestorId,
            userRemarks: userRemarks || req.data.userremarks || req.data.UserRemarks || ''
        });
    });

    // ── saveBPALinkage ────────────────────────────────────────────────────
    srv.on('saveBPALinkage', async (req) => {
        console.log(`[Workflow Handler] saveBPALinkage called for ${req.data.mdrWorkflowId}`);
        const { mdrWorkflowId, bpaInstanceId, tablename } = req.data;
        const db = await cds.connect.to('db');
        const { MDRWorkflowLink } = db.entities('zmdr');
        
        try {
            const existing = await db.run(SELECT.one.from(MDRWorkflowLink).where({ MdrWorkflowId: mdrWorkflowId, TableName: tablename }));
            if (!existing) {
                await db.run(INSERT.into(MDRWorkflowLink).entries({ 
                    MdrWorkflowId: mdrWorkflowId, 
                    TableName: tablename, 
                    BpaInstanceId: bpaInstanceId 
                }));
            }
            return { success: true };
        } catch (err) {
            console.error("Error saving Linkage:", err.message);
            return { success: true };
        }
    });

    srv.on('syncToS4HANA', async (req) => {
        console.log(`[Workflow Handler] syncToS4HANA called for ${req.data.workflowId}. Mocking success.`);
        return { success: true };
    });

    // ── Email helpers ─────────────────────────────────────────────────────
    srv.on('sendEmailToApprover', async (req) => {
        console.log(`\n📧 [EMAIL SENT TO APPROVER]: ${req.data.approverEmail} | Subject: MDR Approval Required: ${req.data.entityName} — ${req.data.operationType}`);
        return { success: true };
    });

    srv.on('sendEmailToRequestor', async (req) => {
        console.log(`\n📧 [EMAIL SENT TO REQUESTOR]: ${req.data.requestorEmail} | Subject: MDR: Your ${req.data.operationType} request for ${req.data.entityName} has been processed`);
        return { success: true };
    });

    srv.on('sendEscalationEmail', async (req) => {
        console.log(`\n📧 [ESCALATION EMAIL]: Workflow ${req.data.workflowId} for ${req.data.entityName} at stage ${req.data.currentStage} escalated!`);
        return { success: true };
    });

    srv.on('sendReminderEmail', async (req) => {
        console.log(`\n📧 [REMINDER EMAIL]: Sent to approver ${req.data.approverEmail} for Workflow ${req.data.workflowId}`);
        return { success: true };
    });

    srv.on('sendReminderEmailRequester', async (req) => {
        console.log(`\n📧 [REMINDER EMAIL]: Sent to requester ${req.data.requestorEmail} for Workflow ${req.data.workflowId}`);
        return { success: true };
    });

});
