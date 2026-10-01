// srv/lib/process-bulk.js  — Replaces ZMDR_FM_PROCESS_BULK_DATA
'use strict';
const cds = require('@sap/cds');
const { validateKeyExists, validateRow } = require('./validate');
const { insertVersionedRow, storeBulkTemp } = require('./insert');
const { buildKeyWhere, checkExists, getEntityDef } = require('./db-dynamic');
const { generateWorkflowId } = require('./wf-id');

function getEntity(name) {
    const zEntities = typeof cds.entities === 'function' ? cds.entities('zmdr') : cds.entities;
    return (zEntities && zEntities[name]) || (cds.entities && cds.entities[name]) || (cds.entities && cds.entities[`zmdr.${name}`]);
}

async function processBulkData(params) {
    let { tablename, requesterrole, dataload, overwriteWithNull,
        futureVersion, workflowid: inputWfId, rowData, userId } = params;

    // Strict mandatory enforcement — no silent fallback to any specific table
    if (!tablename || tablename === 'undefined') {
        throw new Error("'tablename' is a required parameter. Configure the target table in BulkHdrConfig.");
    }
    // If requesterrole is missing, attempt resolving the single configured role from BulkHdrConfig
    if (!requesterrole || requesterrole === 'undefined') {
        requesterrole = null; // will be resolved below from BulkHdrConfig
    }

    const db = await cds.connect.to('db');
    const BulkHdrConfig = getEntity('BulkHdrConfig') || db.entities?.BulkHdrConfig;
    const BulkItmConfig = getEntity('BulkItmConfig') || db.entities?.BulkItmConfig;

    // Config reads — use PascalCase element names that match the DB columns
    let hdrConfig = null;
    if (BulkHdrConfig && tablename) {
        if (requesterrole) {
            // Try exact role match first
            hdrConfig = await db.run(
                SELECT.one.from(BulkHdrConfig).where({ TableName: tablename, RequesterRole: requesterrole })
            );
        }
        if (!hdrConfig) {
            // Fallback: find any config row for this table (auto-resolve role if not provided)
            hdrConfig = await db.run(
                SELECT.one.from(BulkHdrConfig).where({ TableName: tablename })
            );
            if (hdrConfig) {
                requesterrole = hdrConfig.RequesterRole || hdrConfig.requesterrole || requesterrole;
            }
        }
    }
    if (!hdrConfig) throw new Error(`No config for ${tablename}/${requesterrole}`);

    let lineitemConfig = [];
    if (BulkItmConfig && tablename) {
        try {
            lineitemConfig = await db.run(
                SELECT.from(BulkItmConfig)
                      .where({ TableName: tablename, RequesterRole: requesterrole })
                      .orderBy('ColumnSeqNo')
            );
        } catch (e) {
            lineitemConfig = await db.run(
                SELECT.from(BulkItmConfig)
                      .where({ Tablename: tablename, RequesterRole: requesterrole })
                      .orderBy('Colseqno')
            );
        }
        if (!lineitemConfig || !lineitemConfig.length) {
            try {
                lineitemConfig = await db.run(
                    SELECT.from(BulkItmConfig)
                          .where({ TableName: tablename })
                          .orderBy('ColumnSeqNo')
                );
            } catch (e) {
                lineitemConfig = await db.run(
                    SELECT.from(BulkItmConfig)
                          .where({ Tablename: tablename })
                          .orderBy('Colseqno')
                );
            }
        }
    }
    if (!lineitemConfig || !lineitemConfig.length) throw new Error('No column config found');

    // Normalize property names across both camelCase/PascalCase
    lineitemConfig.forEach(c => {
        c.ColumnName = c.ColumnName || c.Columnname || c.COLUMNNAME || '';
        c.Columnname = c.ColumnName;
        c.Colseqno = (c.ColumnSeqNo !== undefined && c.ColumnSeqNo !== null) ? c.ColumnSeqNo : (c.Colseqno || c.columnseqno || 1);
        c.ColumnSeqNo = c.Colseqno;
        c.LookupTableName = c.LookupTableName || c.LookupTablename || c.LOOKUPTABLENAME || '';
        c.LookupTablename = c.LookupTableName;
    });
    lineitemConfig.sort((a, b) => (a.Colseqno || a.ColumnSeqNo) - (b.Colseqno || b.ColumnSeqNo));

    // hdrConfig.Versioned matches the DB column name
    const isVersioned = (hdrConfig.Versioned || hdrConfig.versioned) === 'Y';

    // lineitemConfig rows: use PascalCase properties
    let keyFields = lineitemConfig.filter(c => c.IsMatching === 'Y' || c.Ismatching === 'Y').map(c => (c.Columnname || c.ColumnName || '').toUpperCase());
    if (!keyFields.length) keyFields = [(lineitemConfig[0].Columnname || lineitemConfig[0].ColumnName || '').toUpperCase()];

    const fuzzy = require('./fuzzy-engine');

    // Find all columns configured for intelligent fuzzy duplicate detection (IsFuzzyCheck = 'Y')
    let fuzzyColCfgs = lineitemConfig.filter(c => {
        const flag = String(c.IsFuzzyCheck || c.Isfuzzycheck || c.ISFUZZYCHECK || '').trim().toUpperCase();
        return flag === 'Y';
    });

    if (fuzzyColCfgs.length === 0) {
        // Fallback for unconfigured tables: check descriptor names only if no explicit IsFuzzyCheck flag exists
        const hasExplicitConfig = lineitemConfig.some(x => {
            const f = String(x.IsFuzzyCheck || x.Isfuzzycheck || x.ISFUZZYCHECK || '').trim().toUpperCase();
            return f === 'Y' || f === 'N';
        });
        if (!hasExplicitConfig) {
            const fallbackCfg = lineitemConfig.find(c => {
                const n = (c.Columnname || c.ColumnName || '').toUpperCase();
                return n.includes('LEGALNAME') || n.includes('NAME') || n.includes('DESC') || n.includes('TEXT') || n.includes('CATALOG');
            });
            if (fallbackCfg) fuzzyColCfgs.push(fallbackCfg);
        }
    }

    const validData = [], invalidData = [], createData = [], updateData = [], duplicateData = [];
    const seenBatchKeys = new Map(); // batchKey -> { rownumber, code }
    const candidateFuzzyItemsByCol = {};
    fuzzyColCfgs.forEach(cfg => {
        const colName = cfg.Columnname || cfg.ColumnName;
        candidateFuzzyItemsByCol[colName] = [];
    });

    for (let i = 0; i < rowData.length; i++) {
        const rowStr = rowData[i];
        const splitData = rowStr.split('«');
        const rowCode = splitData[0] || `Row${i + 1}`;

        if (splitData.length !== lineitemConfig.length) {
            invalidData.push({
                code: rowCode, Code: rowCode,
                message: `Column count ${splitData.length} does not match config ${lineitemConfig.length}`,
                Message: `Column count ${splitData.length} does not match config ${lineitemConfig.length}`,
                rownumber: i + 1, Rownumber: i + 1
            });
            continue;
        }

        // Check for exact duplicate key within the same uploaded file
        const batchKeyParts = keyFields.map(kf => {
            const cfg = lineitemConfig.find(c => (c.Columnname || c.ColumnName || '').toUpperCase() === kf);
            const seq = cfg ? (cfg.Colseqno || cfg.ColumnSeqNo || 1) : 1;
            return splitData[seq - 1] || '';
        });
        const batchKey = batchKeyParts.join('|');

        if (batchKey.replace(/\|/g, '').trim() !== '' && seenBatchKeys.has(batchKey)) {
            const firstSeen = seenBatchKeys.get(batchKey);
            invalidData.push({
                code: rowCode,
                Code: rowCode,
                message: `Duplicate primary key "${batchKey}" within upload file (already present on row #${firstSeen.rownumber})`,
                Message: `Duplicate primary key "${batchKey}" within upload file (already present on row #${firstSeen.rownumber})`,
                rownumber: i + 1,
                Rownumber: i + 1
            });
            continue;
        }
        seenBatchKeys.set(batchKey, { rownumber: i + 1, code: rowCode });

        // Versioned: check no in-progress conflict in DB
        if (isVersioned && futureVersion !== 'Y') {
            const inProg = await validateKeyExists({
                splitData, tablename, tableName: tablename, isLookup: 'N', versionInProgress: 'Y',
                lineitemConfig, lineItemConfig: lineitemConfig, keyFields,
            });
            if (inProg) {
                invalidData.push({
                    code: rowCode, Code: rowCode,
                    message: 'In-progress records exist for this key',
                    Message: 'In-progress records exist for this key',
                    rownumber: i + 1, Rownumber: i + 1
                });
                continue;
            }
        }

        const { valid, message } = await validateRow({ splitData, lineitemConfig, lineItemConfig: lineitemConfig, keyFields, tablename, tableName: tablename });
        if (!valid) {
            invalidData.push({
                code: rowCode, Code: rowCode,
                message, Message: message,
                rownumber: i + 1, Rownumber: i + 1
            });
            continue;
        }

        // Determine create vs amend — use CAP ORM to avoid raw SQL table name issues
        const entity = getEntityDef(tablename);
        let exists = false;
        if (entity) {
            const keyWhere = {};
            for (const kf of keyFields) {
                const cfg = lineitemConfig.find(c => (c.Columnname || c.ColumnName || '').toUpperCase() === kf);
                if (cfg) {
                    const seq = cfg.Colseqno || cfg.ColumnSeqNo || 1;
                    keyWhere[kf.toUpperCase()] = splitData[seq - 1] ?? '';
                }
            }
            if (!isVersioned) keyWhere['VERSION_ACTIVE'] = 'Y';
            
            // Map the uppercase keys to the exact entity property names
            const { mapToEntityElements } = require('./db-dynamic');
            const mappedWhere = mapToEntityElements(entity, keyWhere);
            
            const rows = await db.run(SELECT.from(entity.name).where(mappedWhere).limit(1));
            exists = rows.length > 0;
        }
        validData.push({ data: rowStr });

        if (exists) {
            updateData.push({ data: rowStr });
        } else {
            createData.push({ data: rowStr });
            fuzzyColCfgs.forEach(cfg => {
                const colName = cfg.Columnname || cfg.ColumnName;
                const seq = cfg.Colseqno || cfg.ColumnSeqNo || 1;
                const fuzzyVal = splitData[seq - 1] || '';
                if (fuzzyVal.trim().length >= 3) {
                    candidateFuzzyItemsByCol[colName].push({
                        code: rowCode,
                        name: fuzzyVal.trim(),
                        rownumber: i + 1
                    });
                }
            });
        }
    }

    // Unified Fuzzy Deduplication: Reusable validateFuzzyDuplicates function for each fuzzy column
    for (const cfg of fuzzyColCfgs) {
        const colName = cfg.Columnname || cfg.ColumnName;
        const itemsForCol = candidateFuzzyItemsByCol[colName] || [];
        
        if (itemsForCol.length > 0) {
            // 1. In-Batch (Excel) Fuzzy Validation
            const batchDuplicates = fuzzy.validateFuzzyDuplicates({
                targetItems: itemsForCol,
                referenceItems: itemsForCol,
                threshold: 50,
                scope: `In-Batch Fuzzy Match (${colName})`,
                matchType: 'BATCH_FUZZY',
                isInBatch: true
            });
            batchDuplicates.forEach(d => {
                d.message = `[${colName}] Row #${d.rownumber}: ${d.message}`;
                d.Message = `[${colName}] Row #${d.Rownumber || d.rownumber}: ${d.Message}`;
                d.scope = `In-Batch Match (${colName})`;
                d.Scope = `In-Batch Match (${colName})`;
            });

            // 2. Database Fuzzy Validation
            const batchDupCodeSet = new Set(batchDuplicates.map(d => d.code));
            const dbCheckCandidates = itemsForCol.filter(item => !batchDupCodeSet.has(item.code));

            let dbDuplicates = [];
            if (dbCheckCandidates.length > 0) {
                const dbRecords = await fuzzy.fetchDbReferenceRecords({
                    tableName: tablename,
                    fieldName: colName,
                    keyFields
                });

                if (dbRecords.length > 0) {
                    dbDuplicates = fuzzy.validateFuzzyDuplicates({
                        targetItems: dbCheckCandidates,
                        referenceItems: dbRecords,
                        threshold: 50,
                        scope: `Database Match (${colName})`,
                        matchType: 'DB_FUZZY'
                    });
                    dbDuplicates.forEach(d => {
                        d.message = `[${colName}] Row #${d.rownumber}: ${d.message}`;
                        d.Message = `[${colName}] Row #${d.Rownumber || d.rownumber}: ${d.Message}`;
                        d.scope = `Database Match (${colName})`;
                        d.Scope = `Database Match (${colName})`;
                    });
                }
            }

            duplicateData.push(...batchDuplicates, ...dbDuplicates);
        }
    }

    if (dataload === 'N') {
        return {
            validCount: validData.length,
            invalidCount: invalidData.length,
            createCount: createData.length,
            updateCount: updateData.length,
            duplicateCount: duplicateData.length,
            workflowid: '',
            validData,
            invalidData,
            duplicateData
        };
    }

    // Submit — generate WF ID and write
    const workflowid = inputWfId || await generateWorkflowId('BULK');
    if (isVersioned) {
        // Duplicate workflow ID check via checkExists (which safely falls back to raw SQL if ORM fails)
        const dup = await checkExists(db, tablename, 'WORKFLOW_ID = ?', [workflowid]);
        if (dup) throw new Error(`Workflow ID ${workflowid} already in use`);
    }

    const version = futureVersion === 'Y' ? 'F' : 'G';
    let tmpIdCounter = 1;
    for (const { data: rowStr } of validData) {
        const sd = rowStr.split('«');
        
        // Ensure primary keys are populated (generate temporary IDs for blank keys)
        for (const kf of keyFields) {
            const cfg = lineitemConfig.find(c => (c.Columnname || c.ColumnName || '').toUpperCase() === kf);
            if (cfg) {
                const seq = (cfg.Colseqno || cfg.ColumnSeqNo || 1) - 1;
                if (!sd[seq] || sd[seq].trim() === '') {
                    sd[seq] = `TMP-${workflowid}-${tmpIdCounter++}`;
                }
            }
        }
        
        const generatedRowStr = sd.join('«');

        if (isVersioned) {
            await insertVersionedRow({
                splitData: sd, tablename, tableName: tablename, version, workflowid,
                lineitemConfig, lineItemConfig: lineitemConfig, keyFields, isOverwriteNull: overwriteWithNull, userId
            });
        } else {
            const { clause, values: kv } = buildKeyWhere(sd, lineitemConfig, keyFields);
            const ex = await checkExists(db, tablename, clause, kv);
            await storeBulkTemp({ tablename, tableName: tablename, rowString: generatedRowStr, workflowid, actiontype: ex ? 'Amend' : 'Create' });
        }
    }

    return {
        validCount: validData.length, invalidCount: invalidData.length,
        createCount: createData.length, updateCount: updateData.length,
        workflowid, validData, invalidData
    };
}

module.exports = { processBulkData };