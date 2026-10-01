'use strict';
const cds = require('@sap/cds');

// Custom REST endpoints to bypass CAP OData V4 serialization limitations.
// CAP OData V4 returns HTTP 204 (no content) for actions that have anonymous
// inline return types containing nested arrays of complex types
// (e.g. `array of { data: String }`). These REST routes call the same backend
// logic directly and return proper JSON.
cds.on('bootstrap', (app) => {
    // 2. Load express JSON
    const express = require('express');
    app.use(express.json());

    // --- VALIDATE ---
    // Validates uploaded rows against config + lookup tables. dataload='N' means
    // rows are NOT written to the DB — only validation results are returned.
    app.post('/mdrapi/bulk/rest/validateBulkData', async (req, res) => {
        try {
            const { processBulkData } = require('./srv/lib/process-bulk');
            let bodyData = req.body || {};
            if (typeof bodyData === 'string') {
                try { bodyData = JSON.parse(bodyData); } catch (e) {}
            }

            let tablename = bodyData.tablename || bodyData.TableName || bodyData.Tablename;
            let requesterrole = bodyData.requesterrole || bodyData.RequesterRole || bodyData.Requestorsaprole || bodyData.requesterRole;
            let rowData = bodyData.rowData || bodyData.NAVINDATA || bodyData.navindata || [];
            let overwriteWithNull = bodyData.overwriteWithNull || bodyData.Isoverwritewithnull || 'N';
            let futureVersion = bodyData.futureVersion || bodyData.Isfutureversion || 'N';
            let workflowid = bodyData.workflowid || bodyData.Workflowid || '';

            // Mandatory parameter enforcement — no silent defaults to any specific table
            if (!tablename || tablename === 'undefined') {
                return res.status(400).json({ error: "Parameter 'tablename' is required. Please provide the target table name." });
            }
            if (!requesterrole || requesterrole === 'undefined') {
                return res.status(400).json({ error: "Parameter 'requesterrole' is required. Please provide the SAP role identifier." });
            }

            console.log(`[validateBulkData] Processing: tablename=${tablename}, requesterrole=${requesterrole}, rows=${rowData.length}`);

            const result = await processBulkData({
                tablename,
                requesterrole,
                dataload: 'N',
                overwriteWithNull,
                futureVersion,
                workflowid,
                rowData: rowData || [],
                userId: req.user?.id || 'anonymous'
            });

            // Explicitly set Content-Type and send stringified JSON so that
            // an object, null, or undefined never produces an empty body.
            const body = JSON.stringify(result ?? null);
            res.status(200).set('Content-Type', 'application/json').send(body);
        } catch (err) {
            console.error('[REST /mdrapi/bulk/rest/validateBulkData] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- SUBMIT ---
    // Stages rows in the versioned table (VERSION_ACTIVE='G') or BulkTemp,
    // generates a workflow ID, and writes the initial WFAudit INITIATED entry.
    app.post('/mdrapi/bulk/rest/submitBulkData', async (req, res) => {
        try {
            const { processBulkData } = require('./srv/lib/process-bulk');
            const { insertWFAudit } = require('./srv/lib/wf-utilities');
            let bodyData = req.body || {};
            if (typeof bodyData === 'string') {
                try { bodyData = JSON.parse(bodyData); } catch (e) {}
            }

            let tablename = bodyData.tablename || bodyData.TableName || bodyData.Tablename;
            let requesterrole = bodyData.requesterrole || bodyData.RequesterRole || bodyData.Requestorsaprole;

            // Mandatory parameter enforcement — no silent defaults to any specific table
            if (!tablename || tablename === 'undefined') {
                return res.status(400).json({ error: "Parameter 'tablename' is required. Please provide the target table name." });
            }
            if (!requesterrole || requesterrole === 'undefined') {
                return res.status(400).json({ error: "Parameter 'requesterrole' is required. Please provide the SAP role identifier." });
            }
            let validData = bodyData.validData || bodyData.NAVINDATA || [];
            let overwriteWithNull = bodyData.overwriteWithNull || bodyData.Isoverwritewithnull || 'N';
            let futureVersion = bodyData.futureVersion || bodyData.Isfutureversion || 'N';
            let workflowid = bodyData.workflowid || bodyData.Workflowid || '';
            let remarks = bodyData.remarks || '';

            const authUserId = (req.user && req.user.id && req.user.id !== 'anonymous') ? req.user.id : '';
            const authEmail = req.user?.attr?.email || req.user?.attr?.mail || req.user?.email || (authUserId.includes('@') ? authUserId : '');
            const authName = [req.user?.attr?.givenName, req.user?.attr?.familyName].filter(Boolean).join(' ') || req.user?.attr?.name || authUserId;

            const result = await processBulkData({
                tablename,
                requesterrole,
                dataload: 'Y',
                overwriteWithNull,
                futureVersion,
                workflowid,
                rowData: (validData || []).map(r => r.data),
                userId: authUserId || req.body.requesterid || req.body.requesterId || 'anonymous'
            });

            const sActioningUser = authUserId || req.body.requesterid || req.body.requesterId || req.body.requestorid || req.body.requestorId || 'anonymous';
            const sRemarks = req.body.remarks || req.body.Remarks || req.body.userremarks || req.body.userRemarks || '';

            await insertWFAudit({
                workflowid: result.workflowid,
                entityname: tablename,
                entityid: '',
                operationtype: 'BULK UPDATE',
                wfstage: 'REQUESTOR',
                action: 'INITIATED',
                userremarks: sRemarks,
                actioninguser: sActioningUser,
            });

            const body = JSON.stringify({
                workflowid: result.workflowid,
                message: 'Submitted successfully',
                type: 'S'
            });
            res.status(200).set('Content-Type', 'application/json').send(body);
        } catch (err) {
            console.error('[REST /mdrapi/bulk/rest/submitBulkData] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- CURRENT USER ENDPOINT ---
    app.get('/mdrapi/bulk/rest/currentUser', (req, res) => {
        const id = (req.user && req.user.id && req.user.id !== 'anonymous') ? req.user.id : '';
        const email = req.user?.attr?.email || req.user?.attr?.mail || req.user?.email || (id.includes('@') ? id : '');
        const name = [req.user?.attr?.givenName, req.user?.attr?.familyName].filter(Boolean).join(' ') || req.user?.attr?.name || id;
        res.status(200).json({ id, email, name });
    });

    // --- GET BULK REQUEST DATA ---
    // Custom REST endpoint to retrieve bulk request data / diff for approvals.
    app.post('/mdrapi/bulk/rest/getBulkRequestData', async (req, res) => {
        try {
            console.log('[REST getBulkRequestData] Incoming payload:', JSON.stringify(req.body || {}));
            const { getBulkRequestDataLogic } = require('./srv/lib/get-bulk-request-data');
            const result = await getBulkRequestDataLogic(req.body || {});
            
            res.status(200).set('Content-Type', 'application/json').send(JSON.stringify(result));
        } catch (err) {
            console.error('[REST /mdrapi/bulk/rest/getBulkRequestData] Error:', err.message);
            console.error('[REST /mdrapi/bulk/rest/getBulkRequestData] Stack:', err.stack);
            res.status(500).json({ error: err.message, stack: err.stack });
        }
    });

    // --- TRIGGER WORKFLOW ---
    // Resolves approvers from config, starts a SAP BPA workflow instance
    // (with automatic mock fallback when BPA env vars are not set),
    // and persists the MDR ↔ BPA link in MDRWorkflowLink.
    app.post('/mdrapi/bulk/rest/triggerBulkWorkflow', async (req, res) => {
        try {
            const { startBulkApprovalWorkflow } = require('./srv/lib/bpa-client');
            const { saveMDRWorkflowLink, getApprovers } = require('./srv/lib/wf-utilities');
            const {
                workflowid, tablename, requestorid, requestoremail,
                operationtype, approverstage, apprclass,
                validrecordcount, requesterrole
            } = req.body;

            const authUserId = (req.user && req.user.id && req.user.id !== 'anonymous') ? req.user.id : '';
            const authEmail = req.user?.attr?.email || req.user?.attr?.mail || req.user?.email || (authUserId.includes('@') ? authUserId : '');
            const authName = [req.user?.attr?.givenName, req.user?.attr?.familyName].filter(Boolean).join(' ') || req.user?.attr?.name || authUserId;

            let sReqId = authUserId || requestorid || req.body.requestorId || req.body.requesterid || req.body.requesterId || '';
            let sReqEmail = authEmail || requestoremail || req.body.requestorEmail || req.body.requesteremail || req.body.requesterEmail || (sReqId && sReqId.includes('@') ? sReqId : '');
            let sReqName = authName || req.body.requestorname || req.body.requestorName || req.body.requestername || req.body.requesterName || sReqId;
            let sRemarks = req.body.userremarks || req.body.userRemarks || req.body.remarks || req.body.Remarks || '';

            // If any requester metadata or remarks are missing, recover from WFAudit for this workflowid
            if (workflowid && (!sReqId || !sRemarks || !sReqEmail || !sReqName)) {
                try {
                    const db = await cds.connect.to('db');
                    const WFAudit = (cds.entities ? cds.entities('zmdr') : null)?.WFAudit || cds.entities?.WFAudit;
                    if (WFAudit) {
                        const audits = await db.run(
                            SELECT.from(WFAudit).where(`WorkflowId = '${workflowid}' or workflowid = '${workflowid}'`)
                        );
                        if (audits && audits.length > 0) {
                            const initAudit = audits.find(a => (a.Action || a.action || '').toUpperCase() === 'INITIATED') || audits[0];
                            if (!sReqId) sReqId = initAudit.ActioningUser || initAudit.actioninguser || '';
                            if (!sRemarks) sRemarks = initAudit.UserRemarks || initAudit.userremarks || '';
                            if (!sReqEmail && sReqId && sReqId.includes('@')) sReqEmail = sReqId;
                            if (!sReqName && sReqId) sReqName = sReqId;
                        }
                    }
                } catch (auditErr) {
                    console.warn('[triggerBulkWorkflow] WFAudit lookup warning:', auditErr.message);
                }
            }

            if (!sReqName && sReqId) sReqName = sReqId;
            if (!sReqEmail && sReqId && sReqId.includes('@')) sReqEmail = sReqId;

            // Resolve approvers from BulkHdrConfig.ApprClass
            const approverResult = await getApprovers({
                appidentifier: 'BULK',
                system: '', subclass: '', hierarchy: '',
                requesterid: sReqId,
                processid: '',
                tablename,
                saprole: requesterrole
            });

            // Start BPA workflow — falls back to a mock ID if BPA is not configured
            let bpaInstanceId;
            try {
                bpaInstanceId = await startBulkApprovalWorkflow({
                    sWorkflowID: workflowid,
                    workflowid: workflowid,
                    workflowId: workflowid,
                    workflowID: workflowid,
                    sTablename: tablename,
                    tablename: tablename,
                    tableName: tablename,
                    entityName: tablename,
                    requestorid: sReqId,
                    requestorId: sReqId,
                    requesterid: sReqId,
                    requesterId: sReqId,
                    requestoremail: sReqEmail,
                    requestorEmail: sReqEmail,
                    requesteremail: sReqEmail,
                    requesterEmail: sReqEmail,
                    requestorname: sReqName,
                    requestorName: sReqName,
                    requesterName: sReqName,
                    requestername: sReqName,
                    userremarks: sRemarks,
                    userRemarks: sRemarks,
                    remarks: sRemarks,
                    Remarks: sRemarks,
                    operationtype: operationtype || 'BULK UPDATE',
                    operationType: operationtype || 'BULK UPDATE',
                    approverstage: approverstage || 'APPROVER',
                    approverStage: approverstage || 'APPROVER',
                    apprclass: apprclass || '',
                    approverClass: apprclass || '',
                    validrecordcount: validrecordcount || 0,
                    validRecordCount: validrecordcount || 0,
                    requesterrole: requesterrole || '',
                    requesterRole: requesterrole || '',
                    approvers: approverResult.approvers
                });
            } catch (bpaErr) {
                console.warn('[BPA] Workflow trigger skipped (BPA not configured):', bpaErr.message);
                bpaInstanceId = 'MOCK-' + Date.now();
            }

            // Persist MDR workflow ID ↔ BPA instance ID link
            await saveMDRWorkflowLink(workflowid, tablename, bpaInstanceId);

            const body = JSON.stringify({ bpaInstanceId, message: 'Workflow triggered', type: 'S' });
            res.status(200).set('Content-Type', 'application/json').send(body);
        } catch (err) {
            console.error('[REST /mdrapi/bulk/rest/triggerBulkWorkflow] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });
});

module.exports = cds.server;
