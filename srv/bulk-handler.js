// srv/bulk-handler.js
'use strict';
const cds = require('@sap/cds');
const { processBulkData } = require('./lib/process-bulk');
const { insertWFAudit, saveMDRWorkflowLink, getApprovers, extractUserInfo } = require('./lib/wf-utilities');
const { applyBulkTempApproved, approveVersionedTable, rejectVersionedTable } = require('./lib/insert');
const { generateWorkflowId } = require('./lib/wf-id');
const { startBulkApprovalWorkflow, completeBPATask } = require('./lib/bpa-client');
const { readRows } = require('./lib/db-dynamic');
const { buildDiffData } = require('./lib/diff-builder');
const fuzzy = require('./lib/fuzzy-engine');

module.exports = cds.service.impl(async function (srv) {

    srv.on('getCurrentUser', async req => {
        return extractUserInfo(req);
    });

    srv.on('findDuplicates', async req => {
        const { tablename, fieldname, searchval, excludeid } = req.data;
        try {
            return await fuzzy.findDuplicates({
                tableName: tablename,
                fieldName: fieldname,
                searchVal: searchval,
                excludeId: excludeid,
                threshold: 70
            });
        } catch (err) {
            console.error("[BulkService] findDuplicates Error:", err);
            return [];
        }
    });

    srv.on('validateBulkData', async req => {
        console.log("---- validateBulkData called ----");
        console.log("Payload:", JSON.stringify(req.data, null, 2));
        const { tableName, requesterRole, rowData, overwriteWithNull, futureVersion, workflowId } = req.data;
        const userInfo = extractUserInfo(req, req.data);
        return processBulkData({
            tableName, requesterRole, dataLoad: 'N',
            overwriteWithNull, futureVersion, workflowId, rowData: rowData || [], userId: userInfo.id
        });
    });

    srv.on('submitBulkData', async req => {
        const { tableName, requesterRole, validData,
            overwriteWithNull, futureVersion, workflowId, remarks, requesterid, requesteremail, requestername, userremarks } = req.data;
        const userInfo = extractUserInfo(req, {
            requestorId: requesterid,
            requestorEmail: requesteremail,
            requestorName: requestername
        });
        const result = await processBulkData({
            tableName, requesterRole, dataLoad: 'Y',
            overwriteWithNull, futureVersion, workflowId,
            rowData: validData.map(r => r.data), userId: userInfo.id,
        });
        const sRemarks = remarks || userremarks || '';
        await insertWFAudit({  // CAP ORM — WFAudit is config
            workflowId: result.workflowId, entityName: tableName, entityId: '',
            operationtype: 'BULK UPDATE', wfstage: 'REQUESTOR',
            action: 'INITIATED', userremarks: sRemarks, actioninguser: userInfo.email || userInfo.name || userInfo.id,
        });
        return { workflowId: result.workflowId, message: 'Submitted successfully', type: 'S' };
    });

    srv.on('triggerBulkWorkflow', async req => {
        const d = req.data || {};
        const workflowId = d.workflowId || d.workflowid || '';
        const tableName = d.tableName || d.tablename || '';
        const entityName = d.entityName || d.entityname || tableName;
        
        const userInfo = extractUserInfo(req, d);
        const requestorId = userInfo.id;
        const requestorEmail = userInfo.email;
        const requestorName = userInfo.name;
        
        const remarks = d.userRemarks || d.userremarks || d.remarks || d.Remarks || '';
        const operationType = d.operationType || d.operationtype || 'BULK UPDATE';
        const approverStage = d.approverStage || d.approverstage || 'APPROVER';
        const approverClass = d.approverClass || d.apprclass || '';
        const validRecordCount = d.validRecordCount || d.validrecordcount || 0;
        const requesterRole = d.requesterRole || d.requesterrole || '';
        const approvers = d.approvers || [{ approverEmail: requestorEmail, isCompleted: false, stage: approverStage }];

        const bpaContext = {
            sWorkflowID: workflowId,
            workflowid: workflowId,
            workflowId: workflowId,
            workflowID: workflowId,
            sTablename: tableName,
            tablename: tableName,
            tableName: tableName,
            entityName: entityName,
            sRequestorID: requestorId,
            sRequesterID: requestorId,
            requestorid: requestorId,
            requestorId: requestorId,
            requesterid: requestorId,
            requesterId: requestorId,
            sRequestorEmail: requestorEmail,
            sRequesterEmail: requestorEmail,
            requestoremail: requestorEmail,
            requestorEmail: requestorEmail,
            requesteremail: requestorEmail,
            requesterEmail: requestorEmail,
            sRequestorName: requestorName,
            sRequesterName: requestorName,
            requestorname: requestorName,
            requestorName: requestorName,
            requesterName: requestorName,
            requestername: requestorName,
            sRemarks: remarks,
            userremarks: remarks,
            userRemarks: remarks,
            remarks: remarks,
            Remarks: remarks,
            operationtype: operationType,
            operationType: operationType,
            approverstage: approverStage,
            approverStage: approverStage,
            apprclass: approverClass,
            approverClass: approverClass,
            validrecordcount: validRecordCount,
            validRecordCount: validRecordCount,
            requesterrole: requesterRole,
            requesterRole: requesterRole,
            approvers: approvers
        };

        const bpaInstanceId = await startBulkApprovalWorkflow(bpaContext);
        await saveMDRWorkflowLink(workflowId, tableName, bpaInstanceId);  // CAP ORM
        return { bpaInstanceId, message: 'Workflow triggered' };
    });

function getEntity(name) {
    const zEntities = cds.entities ? cds.entities('zmdr') : null;
    return (zEntities && zEntities[name]) || (cds.entities && cds.entities[name]) || (cds.entities && cds.entities[`zmdr.${name}`]);
}

    srv.on('getBulkRequestData', async req => {
        const { getBulkRequestDataLogic } = require('./lib/get-bulk-request-data');
        return await getBulkRequestDataLogic(req.data || {});
    });


    srv.on('takeActionBulk', async req => {
        const d = req.data || {};
        const tablename = d.tablename || d.tableName || '';
        const workflowid = d.workflowid || d.workflowId || '';
        const wfstage = d.wfstage || d.wfStage || 'APPROVER';
        const action = d.action || d.Action || '';
        const requesterrole = d.requesterrole || d.requesterRole || '';
        const bpaInstanceId = d.bpaInstanceId || d.bpainstanceid || '';
        const approverremarks = d.approverremarks || d.approverRemarks || '';
        const isOverwriteNull = d.isOverwriteNull || d.isoverwritenull || 'N';

        const db = await cds.connect.to('db');
        const BulkHdrConfig = getEntity('BulkHdrConfig') || db.entities?.BulkHdrConfig;
        const BulkItmConfig = getEntity('BulkItmConfig') || db.entities?.BulkItmConfig;
        const BulkTemp = getEntity('BulkTemp') || db.entities?.BulkTemp;
        const userId = req.user?.id || 'ANONYMOUS';

        // Config reads — CAP ORM
        const hdr = BulkHdrConfig ? await db.run(SELECT.one.from(BulkHdrConfig).where({ TableName: tablename, RequesterRole: requesterrole })) : null;
        let lineItemConfig = [];
        if (BulkItmConfig) {
            try {
                lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ TableName: tablename, RequesterRole: requesterrole }).orderBy('ColumnSeqNo'));
            } catch (e) {
                lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ Tablename: tablename, RequesterRole: requesterrole }).orderBy('Colseqno'));
            }
        }
        const keyFields = lineItemConfig.filter(c => c.IsMatching === 'Y').map(c => c.ColumnName || c.Columnname);

        if (action === 'APPROVED') {
            if (hdr?.Versioned === 'Y')
                await approveVersionedTable({ tablename, workflowid, keyFields, lineItemConfig, userId });  // raw SQL
            else
                await applyBulkTempApproved({
                    tablename, workflowid, lineItemConfig, keyFields,
                    isOverwriteNull: hdr?.IsOverwrireWithNull || isOverwriteNull, userId
                });  // mixed
        } else if (action === 'REJECTED') {
            if (hdr?.Versioned === 'Y')
                await rejectVersionedTable({ tablename, workflowid });  // raw SQL
            else
                await db.run(UPDATE(BulkTemp).set({ RequestStatus: 'REJECTED' }).where(`(WorkflowId = '${workflowid}' or workflowid = '${workflowid}') and (Tablename = '${tablename}' or tablename = '${tablename}')`));  // CAP ORM
        }

        await insertWFAudit({
            workflowid, entityname: tablename, entityid: '',
            operationtype: 'BULK UPDATE', wfstage, action,
            userremarks: approverremarks, actioninguser: userId
        });  // CAP ORM

        if (bpaInstanceId) await completeBPATask(bpaInstanceId, action, approverremarks);

        return { message: action === 'APPROVED' ? 'Approved Successfully' : 'Rejected Successfully', type: 'S' };
    });

    srv.on('insertWFAudit', async req => insertWFAudit(req.data.audit));
    srv.on('generateWorkflowId', async req => ({ workflowid: await generateWorkflowId(req.data.appname) }));
    srv.on('getApprovers', async req => getApprovers(req.data));
});