// srv/lib/wf-utilities.js  — Replaces ZCL_MDR_WF_UTILITIES
'use strict';
const cds = require('@sap/cds');

function getEntity(name) {
    const zEntities = cds.entities ? cds.entities('zmdr') : null;
    return (zEntities && zEntities[name]) || (cds.entities && cds.entities[name]) || (cds.entities && cds.entities[`zmdr.${name}`]);
}

async function insertWFAudit(d) {
    const db = await cds.connect.to('db');

    // Normalize all field name variants (BPA sends camelCase, CAP sends PascalCase, ABAP sends lowercase)
    const workflowid    = d.workflowid    || d.workflowId    || d.WorkflowId    || '';
    const entityid      = d.entityid      || d.entityId      || d.EntityId      || '';
    const operationtype = d.operationtype || d.operationType || d.OperationType || '';
    const entityname    = d.entityname    || d.entityName    || d.EntityName    || '';
    const wfstage       = d.wfstage       || d.wfStage       || d.WfStage       || '';
    const action        = d.action        || d.Action        || '';
    const userremarks   = d.userremarks   || d.userRemarks   || d.UserRemarks   || '';
    const actioninguser = d.actioninguser || d.actioningUser || d.ActioningUser || '';
    const now           = new Date().toISOString();

    if (!workflowid) {
        console.warn('[insertWFAudit] Called with no workflowid — skipping.');
        return { sequenceid: null, message: 'Missing workflowid', success: false };
    }

    // Deduplicate: If we are trying to insert REQUESTOR / INITIATED, check if one already exists.
    // This elegantly handles the merge of manual UI logging and the automated BPA Webhook.
    if (wfstage === 'REQUESTOR' && action === 'INITIATED') {
        try {
            const WFAudit = getEntity('WFAudit');
            if (WFAudit) {
                const existing = await db.run(SELECT.from(WFAudit).where({ WorkflowId: workflowid, WfStage: 'REQUESTOR', Action: 'INITIATED' }));
                if (existing && existing.length > 0) {
                    console.log(`[insertWFAudit] Skipping duplicate REQUESTOR INITIATED for wf=${workflowid}`);
                    return { sequenceid: existing[0].SequenceId, message: 'Skipped duplicate', success: true };
                }
            } else {
                const existingRows = await db.run(
                    `SELECT "SequenceId" FROM "ZMDR_WFAUDIT" WHERE "WorkflowId" = ? AND "WfStage" = 'REQUESTOR' AND "Action" = 'INITIATED'`,
                    [workflowid]
                );
                if (existingRows && existingRows.length > 0) {
                    console.log(`[insertWFAudit] Skipping duplicate REQUESTOR INITIATED for wf=${workflowid} (raw SQL)`);
                    return { sequenceid: existingRows[0].SequenceId || existingRows[0].SEQUENCEID, message: 'Skipped duplicate', success: true };
                }
            }
        } catch (e) {
            console.warn('[insertWFAudit] Deduplication check failed, proceeding to insert:', e.message);
        }
    }

    let finalEntityName = entityname;
    let finalEntityId = entityid;
    let finalOperationType = operationtype;

    // Inherit missing entity details from the first audit log for this workflow
    if (!finalEntityName || !finalOperationType) {
        try {
            const WFAudit = getEntity('WFAudit');
            let firstRow = null;
            if (WFAudit) {
                const existingRows = await db.run(SELECT.from(WFAudit).where({ WorkflowId: workflowid }).orderBy('SequenceId asc'));
                if (existingRows && existingRows.length > 0) firstRow = existingRows[0];
            } else {
                // Raw SQL fallback if ORM entity is undefined
                const existingRows = await db.run(
                    `SELECT "EntityName", "EntityId", "OperationType" FROM "ZMDR_WFAUDIT" WHERE "WorkflowId" = ? ORDER BY "SequenceId" ASC`,
                    [workflowid]
                );
                if (existingRows && existingRows.length > 0) firstRow = existingRows[0];
            }

            if (firstRow) {
                if (!finalEntityName) finalEntityName = firstRow.EntityName ?? firstRow.ENTITYNAME ?? firstRow.entityname ?? '';
                if (!finalEntityId) finalEntityId = firstRow.EntityId ?? firstRow.ENTITYID ?? firstRow.entityid ?? '';
                if (!finalOperationType) finalOperationType = firstRow.OperationType ?? firstRow.OPERATIONTYPE ?? firstRow.operationtype ?? '';
            }
        } catch (e) {
            console.warn('[insertWFAudit] Could not inherit missing fields from previous audit record:', e.message);
        }
    }

    // ── STEP 2: Determine next sequence number via raw SQL count ───────────────
    // Again, raw SQL is used instead of SELECT.from(entity) to avoid ORM entity
    // resolution failures in HANA production.
    let count = 0;
    try {
        const countRows = await db.run(
            `SELECT COUNT(*) AS "CNT" FROM "ZMDR_WFAUDIT" WHERE "WorkflowId" = ?`,
            [workflowid]
        );
        count = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);
    } catch (e) {
        console.warn('[insertWFAudit] Count query failed, defaulting sequence to 1:', e.message);
    }

    // ── STEP 3: Insert with auto-increment retry on HANA unique key collision ──
    // HANA unique constraint violation → error code 301 (integer).
    // We also check lowercase message strings because error formatting varies
    // across CAP versions and HANA driver versions.
    let sequenceid = `${workflowid}-${count + 1}`;
    const WFAudit  = getEntity('WFAudit');

    for (let attempt = 1; attempt <= 10; attempt++) {
        try {
            if (WFAudit) {
                // ORM path — used when entity is correctly resolved (local dev, SQLite)
                await db.run(INSERT.into(WFAudit).entries({
                    SequenceId:    sequenceid,
                    WorkflowId:    workflowid,
                    EntityId:      finalEntityId,
                    ActionTime:    now,
                    OperationType: finalOperationType,
                    EntityName:    finalEntityName,
                    WfStage:       wfstage,
                    Action:        action,
                    UserRemarks:   userremarks,
                    ActioningUser: actioninguser
                }));
            } else {
                // Raw SQL fallback — reliable in HANA when ORM entity ref is undefined
                await db.run(
                    `INSERT INTO "ZMDR_WFAUDIT" ("SequenceId","WorkflowId","EntityId","ActionTime","OperationType","EntityName","WfStage","Action","UserRemarks","ActioningUser") VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [sequenceid, workflowid, finalEntityId, now, finalOperationType, finalEntityName, wfstage, action, userremarks, actioninguser]
                );
            }
            console.log(`[insertWFAudit] Created: ${sequenceid} | wf=${workflowid} | action=${action}`);
            return { sequenceid, message: 'Audit created successfully', success: true };

        } catch (e) {
            // Detect HANA unique constraint violations across all known formats:
            // - HANA driver code 301
            // - CAP error message containing 'unique', 'exist', 'duplicate', 'constraint'
            const msg = (e.message || '').toLowerCase();
            const isKeyConflict =
                e.code   == 301        ||   // HANA: unique constraint violated
                e.cause?.code == 301   ||   // nested HANA cause
                msg.includes('unique')      ||
                msg.includes('exist')       ||
                msg.includes('duplicate')   ||
                msg.includes('constraint')  ||
                msg.includes('violation');

            if (isKeyConflict) {
                console.warn(`[insertWFAudit] Key conflict on ${sequenceid} (attempt ${attempt}/10), incrementing.`);
                count++;
                sequenceid = `${workflowid}-${count + 1}`;
            } else {
                // Non-constraint error (connection issue, schema mismatch, etc.) — escalate
                console.error(`[insertWFAudit] Non-constraint error on attempt ${attempt}:`, e.message);
                throw e;
            }
        }
    }

    console.error(`[insertWFAudit] Exhausted 10 retry attempts for wf=${workflowid}. Audit NOT written.`);
    return { sequenceid: null, message: 'Failed to create audit after 10 retries', success: false };
}

async function saveMDRWorkflowLink(mdrId, tablename, bpaId) {
    const db = await cds.connect.to('db');
    const MDRWorkflowLink = getEntity('MDRWorkflowLink') || db.entities?.MDRWorkflowLink;
    const ex = await db.run(
        SELECT.one.from(MDRWorkflowLink).where(`(MdrWorkflowId = '${mdrId}' or mdr_workflow_id = '${mdrId}') and (TableName = '${tablename}' or tablename = '${tablename}')`)
    ).catch(() => null);
    if (!ex) {
        await db.run(INSERT.into(MDRWorkflowLink).entries({
            MdrWorkflowId: mdrId,
            mdr_workflow_id: mdrId,
            TableName: tablename,
            tablename: tablename,
            BpaInstanceId: bpaId,
            bpa_instance_id: bpaId
        }));
    }
}

// Replaces ZCL_MDR_WF_UTILITIES.GET_APPROVERS
async function getApprovers(params) {
    const { appidentifier, system, subclass, hierarchy,
        requesterid, processid, tablename, saprole } = params;
    const db = await cds.connect.to('db');
    const BulkHdrConfig = getEntity('BulkHdrConfig') || db.entities?.BulkHdrConfig;
    const CntrlUIApprStage = getEntity('CntrlUIApprStage') || db.entities?.CntrlUIApprStage;

    let apprSystem = system, apprHierarchy = hierarchy, apprSubclass = subclass, nextstage = '';

    if (appidentifier === 'BULK' && BulkHdrConfig) {
        const hdr = await db.run(SELECT.one.from(BulkHdrConfig).where({ TableName: tablename, RequesterRole: saprole })).catch(() => null);
        if (hdr?.ApprClass) {
            const p = hdr.ApprClass.split(',');
            [apprSystem, apprHierarchy, apprSubclass] = p.map(x => x.trim());
        }
    }
    if (appidentifier === 'CENTRAL' && processid && subclass && CntrlUIApprStage) {
        const sr = await db.run(SELECT.one.from(CntrlUIApprStage).where({ ProcessNumber: processid, CurrentStage: subclass })).catch(() => null);
        nextstage = sr?.NextStage || sr?.nextstage || '';
    }

    // Use CAP ORM to avoid hardcoded table names (works on SQLite and HANA)
    const Approver = getEntity('Approver') || db.entities?.Approver;
    const ApproverClass = getEntity('ApproverClass') || db.entities?.ApproverClass;
    
    let rows = [];
    if (ApproverClass && Approver) {
        const classes = await db.run(
            SELECT.from(ApproverClass).where({
                System: apprSystem, Hierarchy: apprHierarchy,
                SubClass: apprSubclass, VersionActive: 'Y'
            })
        ).catch(() => []);
        const classIds = classes.map(c => c.ApproverClassLineId || c.approver_class_lineid || c.APPROVERCLASSLINEID);
        if (classIds.length > 0) {
            rows = await db.run(
                SELECT.from(Approver).where({
                    ApproverClassLineId: { in: classIds },
                    VersionActive: 'Y'
                })
            ).catch(() => []);
        }
    }

    const approvers = rows
        .filter(r => (r.approver_id || r.APPROVER_ID || r.ApproverId || r.APPROVERID) !== requesterid)
        .map(r => {
            const id = r.approver_id || r.APPROVER_ID || r.ApproverId || r.APPROVERID;
            const name = r.approver_name || r.APPROVER_NAME || r.ApproverName || r.APPROVERNAME || id;
            let email = r.email || r.EMAIL || r.Email || `${id}@company.com`;
            email = email.toLowerCase(); // BTP user IDs are usually lowercase emails
            return {
                approverid: id,
                approvername: name,
                approveremail: email,
            };
        });

    return { approvers, nextstage, agent: apprSubclass };
}

function isGuid(str) {
    if (!str || typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

function extractUserInfo(req, explicitData = {}) {
    let email = explicitData.requestorEmail || explicitData.requestoremail || explicitData.requesteremail || explicitData.requesterEmail || '';
    let name = explicitData.requestorName || explicitData.requestorname || explicitData.requesterName || explicitData.requestername || '';
    let id = explicitData.requestorId || explicitData.requestorid || explicitData.requesterid || explicitData.requesterId || '';

    // 1. Check JWT bearer token from authorization header
    if (req && req.headers && req.headers.authorization) {
        try {
            const authHeader = req.headers.authorization;
            if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
                const token = authHeader.split(' ')[1];
                const parts = token.split('.');
                if (parts.length >= 2) {
                    const payloadStr = Buffer.from(parts[1], 'base64').toString('utf8');
                    const jwtPayload = JSON.parse(payloadStr);
                    
                    if (!email) {
                        email = jwtPayload.email || jwtPayload.mail || (jwtPayload.user_name && jwtPayload.user_name.includes('@') ? jwtPayload.user_name : '');
                    }
                    
                    if (!name || isGuid(name)) {
                        const jwtFullName = [jwtPayload.given_name, jwtPayload.family_name].filter(Boolean).join(' ') || jwtPayload.name || '';
                        if (jwtFullName) {
                            name = jwtFullName;
                        }
                    }
                    
                    if (!id || isGuid(id)) {
                        id = jwtPayload.user_name || jwtPayload.ext_attr?.enhancement_user_id || (jwtPayload.email ? jwtPayload.email : id);
                    }
                }
            }
        } catch (e) {
            console.warn('[wf-utilities] Error decoding JWT token for user details:', e.message);
        }
    }

    // 2. Check req.user / req.authInfo (CAP attributes)
    if (req && req.user) {
        if (!email) {
            email = req.user.attr?.email || req.user.attr?.mail || req.user.email || '';
        }
        if (!name || isGuid(name)) {
            const capName = [req.user.attr?.givenName, req.user.attr?.familyName].filter(Boolean).join(' ') || req.user.attr?.name || '';
            if (capName) name = capName;
        }
        if (!id || isGuid(id)) {
            if (req.user.id && !isGuid(req.user.id)) {
                id = req.user.id;
            }
        }
    }

    // 3. Intelligent fallback parsing
    if (!name || isGuid(name)) {
        if (email) {
            const localPart = email.split('@')[0];
            name = localPart.split(/[\._\-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        } else if (id && !isGuid(id)) {
            name = id;
        }
    }

    if (!id || isGuid(id)) {
        if (email) {
            id = email;
        } else if (name && !isGuid(name)) {
            id = name;
        }
    }

    if (!email && id && id.includes('@')) {
        email = id;
    }

    return { id: id || 'MDR_REQUESTOR', name: name || id || 'MDR Requester', email: email || '' };
}

module.exports = { getEntity, insertWFAudit, saveMDRWorkflowLink, getApprovers, extractUserInfo, isGuid };
