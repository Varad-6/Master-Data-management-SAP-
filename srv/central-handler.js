// srv/central-handler.js
'use strict';
const cds = require('@sap/cds');
const bpa = require('./lib/bpa-client');
const wfUtils = require('./lib/wf-utilities');
const dynDb = require('./lib/db-dynamic');
const { generateWorkflowId } = require('./lib/wf-id');

const { approveCentralRecord, rejectCentralRecord } = require('./lib/insert');

module.exports = cds.service.impl(async function (srv) {

    srv.on('validateCentralData', async req => {
        console.log("---- validateCentralData called ----");
        console.log("Payload:", JSON.stringify(req.data, null, 2));
        // TODO: Implement validation logic
        return { message: 'Validation successful', type: 'S' };
    });

    srv.on('submitCentralData', async req => {
        console.log("---- submitCentralData called ----");
        console.log("Payload:", JSON.stringify(req.data, null, 2));
        const wfid = req.data.workflowid || (await generateWorkflowId('CENTRAL'));
        return { workflowid: wfid, message: 'Submitted successfully', type: 'S' };
    });

    srv.on('triggerCentralWorkflow', async req => {
        console.log("---- triggerCentralWorkflow called ----");
        const { workflowid, tablename } = req.data;
        
        try {
            // 1. Build BPA Context
            const ctx = {
                workflowid,
                tablename,
                requestorid: req.user.id || 'anonymous',
                operationtype: 'CREATE',
                validrecordcount: 1
            };
            
            // 2. Start BPA Workflow
            const bpaInstanceId = await bpa.startCentralApprovalWorkflow(ctx);
            
            // 3. Link workflow ID to BPA ID in database
            await wfUtils.saveMDRWorkflowLink(workflowid, tablename, bpaInstanceId);
            
            return { bpaInstanceId, message: 'Workflow triggered successfully' };
        } catch (err) {
            console.error("BPA Trigger Error:", err);
            req.error(500, `Failed to trigger workflow: ${err.message}`);
        }
    });

    srv.on('getCentralRequestData', async req => {
        console.log("---- getCentralRequestData called ----");
        console.log("Payload:", JSON.stringify(req.data, null, 2));
        // TODO: Implement fetching draft data from in-flight tables
        return { data: [], olddata: [], wfids: [], message: '', type: 'S' };
    });

    srv.on('takeActionCentral', async req => {
        console.log("---- takeActionCentral called ----");
        const { workflowid, action, remarks, bpaInstanceId, tablename } = req.data;
        const userId = req.user?.id || 'bpa-system';
        
        try {
            // 1. Log Audit
            await wfUtils.insertWFAudit({
                workflowid,
                action,
                userremarks: remarks,
                actioninguser: userId,
                operationtype: 'APPROVAL_DECISION'
            });
            
            // 2. Database Update Logic using Central Lifecycle Helper
            if (action && action.toUpperCase().includes('APPROV')) {
                console.log(`[Central] Decision APPROVED. Promoting draft and closing old active record for workflow: ${workflowid}`);
                await approveCentralRecord({ workflowid, tablename, userId });
            } else {
                console.log(`[Central] Decision REJECTED for workflow: ${workflowid}`);
                await rejectCentralRecord({ workflowid, tablename, userId });
            }
            
            return { message: `Action ${action} recorded in CAP successfully`, type: 'S' };
        } catch (err) {
            console.error("Action Plugin Error:", err);
            req.error(500, `Failed to process action in CAP: ${err.message}`);
        }
    });

    // Mock Custom Validations to prevent 404 in UI
    srv.on('READ', 'ZMDGCPCNTRLVAL01', () => []);
    srv.on('READ', 'ZMDGCPCNTRLVAL01Set', () => []);

    // Standard hooks for dynamic endpoints (if the UI uses generic CRUD)
    srv.before('READ', '*', async (req) => {
        console.log(`[Central Handler] BEFORE READ triggered for entity: ${req.target.name}`);
    });

    srv.before('CREATE', '*', async (req) => {
        try {
            console.log(`[Central Handler] BEFORE CREATE triggered for entity: ${req.target.name}`);
            console.log("Payload before:", JSON.stringify(req.data, null, 2));
            
            // Auto-assign In-flight status for new drafts/amendments
            if (req.target.elements?.VersionActive) {
                req.data.VersionActive = 'I';
            }
            
            // Auto-assign In-Progress status (520) for drafts
            if (req.target.elements?.Status) {
                req.data.Status = '520';
            }

            // Always generate a fresh dynamic workflow ID for every new draft or amendment
            if (req.target.elements?.WorkflowId) {
                req.data.WorkflowId = await generateWorkflowId('CENTRAL');
            }

            if (req.target.elements?.VersionStartDate) {
                req.data.VersionStartDate = req.data.VersionStartDate || new Date().toISOString();
            }

            // Auto-assign default ID for the primary key if it is empty
            const keyNames = Object.keys(req.target.elements || {}).filter(k => 
                req.target.elements[k].key && 
                k.toUpperCase() !== 'VERSIONSTARTDATE' && 
                k.toUpperCase() !== 'VERSION_START_DATE'
            );
            
            for (const key of keyNames) {
                if (!req.data[key]) {
                    // Generate a prefix from the entity name (e.g. ZMDR_MATERIAL -> MAT)
                    const entityName = req.target.name ? req.target.name.split('.').pop() : 'ID';
                    let prefix = entityName.replace(/ZMDR_/i, '').substring(0, 3).toUpperCase();
                    if (!prefix) prefix = 'ID';
                    req.data[key] = prefix + Date.now().toString().slice(-8);
                }
            }

            // Record workflow link if workflow ID and table name are available
            const entityShortName = req.target.name ? req.target.name.split('.').pop() : '';
            if (req.data.WorkflowId && entityShortName) {
                await wfUtils.saveMDRWorkflowLink(req.data.WorkflowId, entityShortName, '').catch(() => {});
            }
        } catch (err) {
            console.error("[Central Handler] Error in BEFORE CREATE hook:", err);
        }
    });

    srv.before('UPDATE', '*', async (req) => {
        console.log(`[Central Handler] BEFORE UPDATE triggered for entity: ${req.target.name}`);
        console.log("Payload:", JSON.stringify(req.data, null, 2));
    });

    srv.before('DELETE', '*', async (req) => {
        console.log(`[Central Handler] BEFORE DELETE triggered for entity: ${req.target.name}`);
    });

});
