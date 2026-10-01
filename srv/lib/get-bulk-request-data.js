// srv/lib/get-bulk-request-data.js
// Standalone logic for getBulkRequestData — called from both server.js REST route
// and bulk-handler.js OData action handler.
'use strict';
const cds = require('@sap/cds');

// Safe entity resolver — wraps cds.entities() in try-catch so it never crashes
function getEntity(name) {
    try {
        if (typeof cds.entities === 'function') {
            const zEntities = cds.entities('zmdr');
            if (zEntities && zEntities[name]) return zEntities[name];
        }
    } catch (e) {
        console.warn('[getEntity] cds.entities("zmdr") failed:', e.message);
    }
    try {
        if (cds.entities && cds.entities[name]) return cds.entities[name];
        if (cds.entities && cds.entities[`zmdr.${name}`]) return cds.entities[`zmdr.${name}`];
    } catch (e2) {
        console.warn('[getEntity] fallback lookup failed:', e2.message);
    }
    return null;
}

// Case-insensitive property getter — handles HANA (uppercase), SQLite (mixed), CDS (camelCase)
function getProp(obj, key) {
    if (!obj || !key) return undefined;
    if (obj[key] !== undefined) return obj[key];
    const keyUpper = key.toUpperCase();
    const keyLower = key.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
        if (k === key || k.toUpperCase() === keyUpper || k.toLowerCase() === keyLower) return v;
    }
    return undefined;
}

async function getBulkRequestDataLogic(d) {
    console.log('[getBulkRequestDataLogic] Called with:', JSON.stringify(d));

    const tableName = d.tableName || d.tablename || '';
    const workflowId = d.workflowId || d.workflowid || '';
    const versionActive = d.versionActive || d.versionactive || 'G';
    const uniqueWf = d.uniqueWf || d.uniquewf || 'N';
    const requesterRole = d.requesterRole || d.requesterrole || '';

    console.log(`[getBulkRequestDataLogic] tableName=${tableName}, workflowId=${workflowId}, versionActive=${versionActive}, uniqueWf=${uniqueWf}, requesterRole=${requesterRole}`);

    // 1. Connect to DB
    let db;
    try {
        db = await cds.connect.to('db');
        console.log('[getBulkRequestDataLogic] DB connected successfully');
    } catch (dbErr) {
        console.error('[getBulkRequestDataLogic] DB connection failed:', dbErr.message);
        return { data: [], olddata: [], wfids: [], message: 'DB connection failed: ' + dbErr.message, type: 'E' };
    }

    // 2. Resolve entities safely
    const BulkHdrConfig = getEntity('BulkHdrConfig') || (db.entities && db.entities.BulkHdrConfig);
    const BulkItmConfig = getEntity('BulkItmConfig') || (db.entities && db.entities.BulkItmConfig);
    const BulkTemp = getEntity('BulkTemp') || (db.entities && db.entities.BulkTemp);

    console.log(`[getBulkRequestDataLogic] Entities resolved: BulkHdrConfig=${!!BulkHdrConfig}, BulkItmConfig=${!!BulkItmConfig}, BulkTemp=${!!BulkTemp}`);

    // 3. uniqueWf = 'Y': just list all in-progress workflow IDs for this table
    if (uniqueWf === 'Y' && BulkTemp) {
        try {
            const rows = await db.run(SELECT.from(BulkTemp).where(`(Tablename = '${tableName}' or tablename = '${tableName}') and (RequestStatus = 'INPROGRESS' or requeststatus = 'INPROGRESS')`));
            const wfids = [...new Set(rows.map(r => r.workflowid || r.WorkflowId || getProp(r, 'WorkflowId')))].map(wf => ({ workflowid: wf, remarks: '' }));
            return { data: [], olddata: [], wfids, message: '', type: 'S' };
        } catch (wfErr) {
            console.error('[getBulkRequestDataLogic] uniqueWf query failed:', wfErr.message);
            return { data: [], olddata: [], wfids: [], message: 'Workflow query failed: ' + wfErr.message, type: 'E' };
        }
    }

    // 4. Read item config for column definitions
    let lineItemConfig = [];
    if (BulkItmConfig) {
        try {
            if (requesterRole) {
                try {
                    lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ TableName: tableName, RequesterRole: requesterRole }).orderBy('ColumnSeqNo'));
                } catch (e1) {
                    try {
                        lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ Tablename: tableName, RequesterRole: requesterRole }).orderBy('Colseqno'));
                    } catch (e2) {
                        console.warn('[getBulkRequestDataLogic] BulkItmConfig query with role failed:', e2.message);
                    }
                }
            }
            if (!lineItemConfig || lineItemConfig.length === 0) {
                try {
                    lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ TableName: tableName }).orderBy('ColumnSeqNo'));
                } catch (e3) {
                    try {
                        lineItemConfig = await db.run(SELECT.from(BulkItmConfig).where({ Tablename: tableName }).orderBy('Colseqno'));
                    } catch (e4) {
                        console.warn('[getBulkRequestDataLogic] BulkItmConfig query without role failed:', e4.message);
                    }
                }
            }
        } catch (cfgErr) {
            console.warn('[getBulkRequestDataLogic] BulkItmConfig resolution error:', cfgErr.message);
        }
    }
    console.log(`[getBulkRequestDataLogic] lineItemConfig loaded: ${(lineItemConfig || []).length} columns`);

    // 5. Normalise field names for cross-DB compatibility
    lineItemConfig = lineItemConfig || [];
    for (const c of lineItemConfig) {
        c.ColumnName = c.ColumnName || c.Columnname || c.COLUMNNAME || '';
        c.Columnname = c.ColumnName;
        c.Colseqno = (c.ColumnSeqNo !== undefined && c.ColumnSeqNo !== null) ? c.ColumnSeqNo : (c.Colseqno || c.columnseqno || 1);
        c.ColumnSeqNo = c.Colseqno;
        c.IsMatching = c.IsMatching || c.Ismatching || 'N';
    }
    lineItemConfig.sort((a, b) => a.Colseqno - b.Colseqno);

    // 6. Read header config to determine if table is versioned
    let hdr = null;
    if (BulkHdrConfig) {
        try {
            hdr = await db.run(SELECT.one.from(BulkHdrConfig).where({ TableName: tableName, RequesterRole: requesterRole }));
            if (!hdr) {
                hdr = await db.run(SELECT.one.from(BulkHdrConfig).where({ TableName: tableName }));
            }
        } catch (hdrErr) {
            console.warn('[getBulkRequestDataLogic] BulkHdrConfig query failed:', hdrErr.message);
        }
    }

    // Case-insensitive check for Versioned field — handles HANA uppercase, SQLite mixed, CDS camelCase
    const versionedVal = getProp(hdr, 'Versioned') || getProp(hdr, 'VERSIONED') || getProp(hdr, 'versioned') || getProp(hdr, 'isversioned') || '';
    const isVersioned = (versionedVal === 'Y');
    console.log(`[getBulkRequestDataLogic] hdr loaded: ${!!hdr}, isVersioned=${isVersioned}, versionedVal='${versionedVal}'`);

    // 7. Build diff data (Old/New comparison)
    try {
        if (isVersioned) {
            console.log(`[getBulkRequestDataLogic] Versioned path: reading rows with WORKFLOW_ID=${workflowId}, VERSION_ACTIVE=${versionActive}`);
            const { readRows } = require('./db-dynamic');
            let versionedRows = [];
            try {
                versionedRows = await readRows(db, tableName, 'WorkflowId = ? AND VersionActive IN (?, ?)', [workflowId, 'G', 'I']);
            } catch (e1) { /* fallback below */ }
            if (!versionedRows || versionedRows.length === 0) {
                try {
                    versionedRows = await readRows(db, tableName, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" IN (?, ?)', [workflowId, 'G', 'I']);
                } catch (e2) { /* fallback below */ }
            }
            console.log(`[getBulkRequestDataLogic] Versioned rows found: ${(versionedRows || []).length}`);

            if (versionedRows && versionedRows.length > 0 && lineItemConfig.length > 0) {
                const { buildDiffData } = require('./diff-builder');
                const diffResult = await buildDiffData({
                    tableName, bulkTempRecords: [], itemConfig: lineItemConfig,
                    isVersioned: true, versionedRows
                });
                return { data: diffResult, olddata: [], wfids: [], message: '', type: 'S' };
            }
            // Fallback: return raw data if no config
            return { data: (versionedRows || []).map(r => ({ data: Object.values(r).join('«') })), olddata: [], wfids: [], message: '', type: 'S' };

        } else if (BulkTemp) {
            console.log(`[getBulkRequestDataLogic] Non-versioned path: reading BulkTemp for workflowId=${workflowId}`);
            const rows = await db.run(SELECT.from(BulkTemp).where(`(WorkflowId = '${workflowId}' or workflowid = '${workflowId}') and (Tablename = '${tableName}' or tablename = '${tableName}') and (RequestStatus = 'INPROGRESS' or requeststatus = 'INPROGRESS')`));
            console.log(`[getBulkRequestDataLogic] BulkTemp rows found: ${(rows || []).length}`);

            if (rows && rows.length > 0 && lineItemConfig.length > 0) {
                const { buildDiffData } = require('./diff-builder');
                const diffResult = await buildDiffData({
                    tableName, bulkTempRecords: rows, itemConfig: lineItemConfig,
                    isVersioned: false, versionedRows: []
                });
                return { data: diffResult, olddata: [], wfids: [], message: '', type: 'S' };
            }
            // Fallback: return raw data if no config
            return { data: (rows || []).map(r => ({ data: r.bulkdata || r.BulkData || getProp(r, 'BulkData') || '' })), olddata: [], wfids: [], message: '', type: 'S' };

        } else {
            console.warn('[getBulkRequestDataLogic] Neither versioned table nor BulkTemp entity available');
        }
    } catch (diffErr) {
        console.error('[getBulkRequestDataLogic] Diff generation failed:', diffErr.message);
        console.error('[getBulkRequestDataLogic] Diff stack:', diffErr.stack);
        // Fallback to raw BulkTemp data on any error
        if (BulkTemp) {
            try {
                const rows = await db.run(SELECT.from(BulkTemp).where(`(WorkflowId = '${workflowId}' or workflowid = '${workflowId}') and (Tablename = '${tableName}' or tablename = '${tableName}') and (RequestStatus = 'INPROGRESS' or requeststatus = 'INPROGRESS')`));
                return { data: (rows || []).map(r => ({ data: r.bulkdata || r.BulkData || getProp(r, 'BulkData') || '' })), olddata: [], wfids: [], message: 'Diff failed: ' + diffErr.message, type: 'W' };
            } catch (fallbackErr) {
                console.error('[getBulkRequestDataLogic] BulkTemp fallback also failed:', fallbackErr.message);
            }
        }
        // Return error details instead of crashing
        return { data: [], olddata: [], wfids: [], message: 'Error: ' + diffErr.message, type: 'E' };
    }

    return { data: [], olddata: [], wfids: [], message: '', type: 'S' };
}

module.exports = { getBulkRequestDataLogic };
