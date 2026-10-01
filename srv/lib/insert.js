// srv/lib/insert.js
// Replaces: ZMDR_FM_INSERT_BULK_DATA + ZCL_MDR_BULK_PROCESS.TAKE_ACTION_REQUEST (approval)
'use strict';
const cds = require('@sap/cds');
const { SELECT } = cds.ql || cds;
const { buildRowFromSplit, buildKeyWhere,
  checkExists, readRows, insertRow, updateRow, deleteRows } = require('./db-dynamic');

// insertVersionedRow: insert one row into a versioned dynamic table
// version = 'G' for in-progress staging, 'F' for future
// Replaces ZMDR_FM_INSERT_BULK_DATA with IM_ISINSERT='Y' + IM_ISWORKFLOW='Y'
async function insertVersionedRow(params) {
  const { splitData, version, workflowid,
    lineitemConfig, keyFields, isOverwriteNull, userId } = params;
  const tablename = params.tablename || params.tableName;
  const db = await cds.connect.to('db');
  const now = new Date().toISOString();

  const row = buildRowFromSplit(splitData, lineitemConfig, {
    VERSION_START_DATE: now,
    VERSION_END_DATE: '9999-12-31T23:59:59.999Z',
    VERSION_ACTIVE: version,
    WORKFLOW_ID: workflowid,
    CREATED_ON: now, CREATED_BY: userId, UPDATED_ON: now, UPDATED_BY: userId,
  });
  // isOverwriteNull='N': fill blank fields from current active record
  // Replaces ABAP im_isoverwritenull='N' block
  if (isOverwriteNull === 'N') {
    const { clause, values } = buildKeyWhere(splitData, lineitemConfig, keyFields);
    const active = await readRows(db, tablename, `${clause} AND "VERSION_ACTIVE" = ?`, [...values, 'Y']);
    if (active.length > 0) {
      for (const cfg of lineitemConfig) {
        const key = cfg.Columnname.toUpperCase();
        if (row[key] === null || row[key] === '') row[key] = active[0][key] ?? null;
      }
    }
  }
  await insertRow(db, tablename, row);
}

function getEntity(name) {
  const zEntities = cds.entities ? cds.entities('zmdr') : null;
  return (zEntities && zEntities[name]) || (cds.entities && cds.entities[name]) || (cds.entities && cds.entities[`zmdr.${name}`]);
}

// storeBulkTemp: for non-versioned tables, store row in BulkTemp holding area
// Replaces ABAP INSERT INTO ZMDR_BULKTEMP in ZMDR_FM_PROCESS_BULK_DATA
async function storeBulkTemp(params) {
  const { rowString, workflowid, actiontype } = params;
  const tablename = params.tablename || params.tableName;
  const db = await cds.connect.to('db');
  const BulkTemp = getEntity('BulkTemp') || db.entities?.BulkTemp;
  if (BulkTemp) {
    await db.run(INSERT.into(BulkTemp.name).entries({
      Tablename: tablename, tablename,
      BulkData: rowString, bulkdata: rowString,
      WorkflowId: workflowid, workflowid,
      ActionType: actiontype, actiontype,
      InitiationDate: new Date().toISOString(), initiationdate: new Date().toISOString(),
      RequestStatus: 'INPROGRESS', requeststatus: 'INPROGRESS',
    }));
  }
}

// applyBulkTempApproved: on APPROVE of non-versioned table, apply BulkTemp to real table
// Replaces ZCL_MDR_BULK_PROCESS.TAKE_ACTION_REQUEST for non-versioned APPROVED
async function applyBulkTempApproved(params) {
  const { workflowid, lineitemConfig, keyFields, isOverwriteNull, userId } = params;
  const tablename = params.tablename || params.tableName;
  const db = await cds.connect.to('db');
  const BulkTemp = getEntity('BulkTemp') || db.entities?.BulkTemp;
  const now = new Date().toISOString();

  const tempRows = BulkTemp ? await db.run(  // CAP ORM — BulkTemp is config table
    SELECT.from(BulkTemp.name).where(`(WorkflowId = '${workflowid}' or workflowid = '${workflowid}') and (Tablename = '${tablename}' or tablename = '${tablename}') and (RequestStatus = 'INPROGRESS' or requeststatus = 'INPROGRESS')`)
  ) : [];
  for (const tr of tempRows) {
    const splitData = tr.BulkData.split('«');
    const { clause, values: kv } = buildKeyWhere(splitData, lineitemConfig, keyFields);
    const existing = await readRows(db, tablename, clause, kv);  // dynamic raw SQL
    const rowToWrite = buildRowFromSplit(splitData, lineitemConfig, { UPDATED_ON: now, UPDATED_BY: userId });

    if (existing.length > 0) {
      if (isOverwriteNull === 'N') {
        for (const cfg of lineitemConfig) {
          const k = cfg.Columnname.toUpperCase();
          if (rowToWrite[k] === null || rowToWrite[k] === '') rowToWrite[k] = existing[0][k] ?? null;
        }
      }
      const setObj = { ...rowToWrite };
      keyFields.forEach(kf => delete setObj[kf.toUpperCase()]);
      await updateRow(db, tablename, setObj, clause, kv);  // dynamic raw SQL
    } else {
      rowToWrite.CREATED_ON = now; rowToWrite.CREATED_BY = userId;
      await insertRow(db, tablename, rowToWrite);  // dynamic raw SQL
    }
  }
  // Mark APPROVED — CAP ORM
  await db.run(UPDATE(BulkTemp.name).set({ RequestStatus: 'APPROVED' }).where({ WorkflowId: workflowid, Tablename: tablename }));
}

// approveVersionedTable: on APPROVE of versioned table, promote G->Y and deactivate old Y
// Replaces ZCL_MDR_BULK_PROCESS.TAKE_ACTION_REQUEST for versioned APPROVED
async function approveVersionedTable(params) {
  const { workflowid, keyFields, lineitemConfig, userId } = params;
  const tablename = params.tablename || params.tableName;
  const db = await cds.connect.to('db');
  const now = new Date().toISOString();

  const gRows = await readRows(db, tablename, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, 'G']);
  for (const gRow of gRows) {
    const kp = [], kv = [];
    keyFields.forEach(kf => { kp.push(`"${kf.toUpperCase()}" = ?`); kv.push(gRow[kf.toUpperCase()]); });
    const keyWhere = kp.join(' AND ');
    // Step 1: deactivate existing Y record -> N, Status 590 (Closed)
    const yWhere = `${keyWhere} AND "VERSION_ACTIVE" = ?`;
    if (await checkExists(db, tablename, yWhere, [...kv, 'Y']))
      await updateRow(db, tablename, { VERSION_ACTIVE: 'N', STATUS: '590', VERSION_END_DATE: now, UPDATED_ON: now, UPDATED_BY: userId }, yWhere, [...kv, 'Y']);
    // Step 2: promote G to Y -> Y, Status 510 (Approved)
    await updateRow(db, tablename, { VERSION_ACTIVE: 'Y', STATUS: '510', UPDATED_ON: now, UPDATED_BY: userId },
      `${keyWhere} AND "VERSION_ACTIVE" = ? AND "WORKFLOW_ID" = ?`, [...kv, 'G', workflowid]);
  }
}

// rejectVersionedTable: on REJECT, delete G-version rows (as if never submitted)
// Replaces ABAP DELETE FROM (im_tablename) WHERE workflow_id=... AND version_active='G'
async function rejectVersionedTable(params) {
  const { workflowid } = params;
  const tablename = params.tablename || params.tableName;
  const db = await cds.connect.to('db');
  await deleteRows(db, tablename, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, 'G']);
}

/**
 * Intelligently resolve the target master data entity name.
 * Handles display names ("Amend Business Partner", "GL Account"),
 * legacy ABAP table names ("ZMDR_BUSINESSPARTNER", "ZMDR_GLACCOUNT"),
 * CDS entity names ("BPMaster", "GLAccount", "BPRoleRef"),
 * and resolves via MDRWorkflowLink or dynamic scan by workflowId.
 */
async function resolveMasterTable(tableName, workflowId, db) {
  // 1. Try resolving via MDRWorkflowLink if workflowId is provided
  if (workflowId) {
    try {
      const { getEntity } = require('./wf-utilities');
      const MDRWorkflowLink = getEntity('MDRWorkflowLink') || (db && db.entities && db.entities.MDRWorkflowLink);
      if (MDRWorkflowLink && db) {
        const link = await db.run(
          SELECT.one.from(MDRWorkflowLink).where(`MdrWorkflowId = '${workflowId}' or mdr_workflow_id = '${workflowId}'`)
        ).catch(() => null);
        if (link && (link.TableName || link.tablename)) {
          const resolved = link.TableName || link.tablename;
          const { getEntityDef } = require('./db-dynamic');
          const entity = getEntityDef(resolved);
          if (entity && entity.name) {
            return entity.name.split('.').pop();
          }
          return resolved;
        }
      }
    } catch (e) {
      console.warn(`[resolveMasterTable] Error reading MDRWorkflowLink:`, e.message);
    }
  }

  // 2. Intelligent Semantic Alias Normalization
  if (tableName && typeof tableName === 'string') {
    const raw = tableName.trim().toUpperCase().replace(/[\s_\-]+/g, '');
    if (raw.includes('BP') || raw.includes('BUSINESSPARTNER') || raw.includes('CUSTOMER') || raw.includes('VENDOR')) {
      if (raw.includes('ROLE')) return 'BPRoleRef';
      if (raw.includes('STATUS')) return 'BPStatus';
      return 'BPMaster';
    }
    if (raw.includes('GL') || raw.includes('ACCOUNT') || raw.includes('GENERALLEDGER')) {
      return 'GLAccount';
    }
    if (raw.includes('ROLE')) {
      return 'BPRoleRef';
    }
    if (raw.includes('MATERIAL')) {
      return 'ZMDR_MATERIAL';
    }
    if (raw.includes('SERVICE') || raw.includes('CATALOG')) {
      return 'ZMDR_SERVCATALOG';
    }
    const { getEntityDef } = require('./db-dynamic');
    const directDef = getEntityDef(tableName);
    if (directDef && directDef.name) return directDef.name.split('.').pop();
  }

  return null;
}

// approveCentralRecord: on APPROVE of Central Amend/Create record (version_active 'I' -> 'Y', old 'Y' -> 'N'/'590')
async function approveCentralRecord(params) {
  const { workflowid, userId } = params;
  let tablename = params.tablename || params.tableName;
  const db = params.db || await cds.connect.to('db');
  const now = new Date().toISOString();

  // Resolve the target table intelligently
  const resolvedTable = await resolveMasterTable(tablename, workflowid, db);
  
  // Search resolved table first, or fall back to scanning all versionable master data tables
  const defs = (cds.model && cds.model.definitions) || cds.entities || {};
  const allMasterTables = Object.entries(defs)
      .filter(([name, e]) => e && e.elements && e.elements.WorkflowId && e.elements.VersionActive)
      .map(([name, e]) => name.split('.').pop());
      
  const candidateTables = resolvedTable 
    ? [resolvedTable, ...allMasterTables.filter(t => t !== resolvedTable)]
    : allMasterTables;

  let matched = false;

  for (const tName of candidateTables) {
    const iRows = await readRows(db, tName, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, 'I']).catch(() => []);
    if (!iRows || iRows.length === 0) continue;

    matched = true;
    console.log(`[approveCentralRecord] Found ${iRows.length} draft record(s) in entity '${tName}' for workflow '${workflowid}'. Promoting to Active.`);

    const { getEntityDef } = require('./db-dynamic');
    const entity = getEntityDef(tName);
    let keyFields = [];
    if (entity && entity.elements) {
      keyFields = Object.keys(entity.elements).filter(k =>
        entity.elements[k].key &&
        k.toUpperCase() !== 'VERSIONSTARTDATE' &&
        k.toUpperCase() !== 'VERSION_START_DATE'
      );
    }
    if (keyFields.length === 0) {
      const defs = (cds.model && cds.model.definitions) || cds.entities || {};
      const entEntry = Object.entries(defs).find(([name, e]) => name.toUpperCase().endsWith(tName.toUpperCase()));
      const ent = entEntry ? entEntry[1] : null;
      if (ent && ent.elements) {
          keyFields = Object.keys(ent.elements).filter(k => 
              ent.elements[k].key &&
              k.toUpperCase() !== 'VERSIONSTARTDATE' &&
              k.toUpperCase() !== 'VERSION_START_DATE'
          );
      }
      // If still no key, fallback to the first element
      if (keyFields.length === 0 && ent && ent.elements) {
          keyFields = [Object.keys(ent.elements)[0]];
      }
    }

    for (const iRow of iRows) {
      const kp = [], kv = [];
      keyFields.forEach(kf => {
        const cleanK = kf.replace(/_/g, '').toUpperCase();
        const foundKey = Object.keys(iRow).find(
          rk => rk.toUpperCase() === kf.toUpperCase() || rk.replace(/_/g, '').toUpperCase() === cleanK
        );
        const val = foundKey ? iRow[foundKey] : undefined;
        if (val !== undefined && val !== null) {
          kp.push(`"${(foundKey || kf).toUpperCase()}" = ?`);
          kv.push(val);
        }
      });

      if (kp.length > 0) {
        const keyWhere = kp.join(' AND ');
        // Step 1: Deactivate existing live (Y) record -> N, Status 590 (Closed)
        const yWhere = `${keyWhere} AND "VERSION_ACTIVE" = ?`;
        if (await checkExists(db, tName, yWhere, [...kv, 'Y'])) {
          await updateRow(db, tName, {
            VERSION_ACTIVE: 'N',
            STATUS: '590',
            VERSION_END_DATE: now,
            UPDATED_ON: now,
            UPDATED_BY: userId || 'MDR_APPROVER'
          }, yWhere, [...kv, 'Y']);
          console.log(`[approveCentralRecord] Deactivated existing live 'Y' record in '${tName}' with keys:`, kv);
        }

        // Step 2: Promote draft (I) to live (Y) -> Y, Status 510 (Approved)
        await updateRow(db, tName, {
          VERSION_ACTIVE: 'Y',
          STATUS: '510',
          VERSION_END_DATE: '9999-12-31T23:59:59.999Z',
          UPDATED_ON: now,
          UPDATED_BY: userId || 'MDR_APPROVER'
        }, `${keyWhere} AND "VERSION_ACTIVE" = ? AND "WORKFLOW_ID" = ?`, [...kv, 'I', workflowid]);
        console.log(`[approveCentralRecord] Successfully promoted draft 'I' to live 'Y' (510) in '${tName}'.`);
      } else {
        await updateRow(db, tName, {
          VERSION_ACTIVE: 'Y',
          STATUS: '510',
          VERSION_END_DATE: '9999-12-31T23:59:59.999Z',
          UPDATED_ON: now,
          UPDATED_BY: userId || 'MDR_APPROVER'
        }, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, 'I']);
      }
    }
    break; // Promotion complete for matching table
  }

  if (!matched) {
    console.warn(`[approveCentralRecord] Note: No draft row ('I') found across candidate tables for workflow: ${workflowid}`);
  }
}

// rejectCentralRecord: on REJECT, mark draft as 'R' and status '530'
async function rejectCentralRecord(params) {
  const { workflowid, userId } = params;
  let tablename = params.tablename || params.tableName;
  const db = params.db || await cds.connect.to('db');
  const now = new Date().toISOString();

  // Also update BulkTemp if it exists for this workflow (for non-versioned bulk loads)
  try {
      const BulkTemp = (cds.entities && cds.entities.BulkTemp) || (db.entities && db.entities.BulkTemp) || (cds.model && cds.model.definitions['zmdr.BulkTemp']);
      if (BulkTemp) {
          await db.run(UPDATE(BulkTemp).set({ RequestStatus: 'REJECTED' }).where(`WorkflowId = '${workflowid}' or workflowid = '${workflowid}'`));
      }
  } catch (e) {
      console.warn("[rejectCentralRecord] Note: Could not update BulkTemp", e.message);
  }

  const resolvedTable = await resolveMasterTable(tablename, workflowid, db);
  const defs = (cds.model && cds.model.definitions) || cds.entities || {};
  const allMasterTables = Object.entries(defs)
      .filter(([name, e]) => e && e.elements && e.elements.WorkflowId && e.elements.VersionActive)
      .map(([name, e]) => name.split('.').pop());
      
  const candidateTables = resolvedTable 
    ? [resolvedTable, ...allMasterTables.filter(t => t !== resolvedTable)]
    : allMasterTables;

  for (const tName of candidateTables) {
    let found = false;
    for (const versionToCheck of ['I', 'G', 'F']) {
        const rows = await readRows(db, tName, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, versionToCheck]).catch(() => []);
        if (rows && rows.length > 0) {
            await updateRow(db, tName, {
              VERSION_ACTIVE: 'R',
              STATUS: '530',
              UPDATED_ON: now,
              UPDATED_BY: userId || 'MDR_APPROVER'
            }, '"WORKFLOW_ID" = ? AND "VERSION_ACTIVE" = ?', [workflowid, versionToCheck]);
            console.log(`[rejectCentralRecord] Successfully marked draft (${versionToCheck}) as 'R' (530) in '${tName}' for workflow '${workflowid}'.`);
            found = true;
        }
    }
    if (found) break;
  }
}

module.exports = {
  insertVersionedRow, storeBulkTemp,
  applyBulkTempApproved, approveVersionedTable, rejectVersionedTable,
  approveCentralRecord, rejectCentralRecord, resolveMasterTable
};
