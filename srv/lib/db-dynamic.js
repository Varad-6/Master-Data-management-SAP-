// srv/lib/db-dynamic.js
// Replaces: ZMDR_FM_INSERT_BULK_DATA, ZMDR_FM_VALIDATE_BULK_DATA,
//           ZCL_MDR_BULK_PROCESS dynamic table operations
//
// RULE: This file ONLY touches DYNAMIC tables (tablename is a runtime param).
//       Config tables always go through CAP ORM in other files.
'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql || cds;

// parseDate: dd.MM.yyyy -> yyyy-MM-dd for HANA DATE columns
// Replaces ABAP CONVERT_DATE_TO_INTERN_FORMAT
function parseDate(val) {
  if (!val || typeof val !== 'string') return null;
  const m = val.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return val;
}

// buildRowFromSplit: builds { COLUMNNAME: value } from «-split data + BulkItmConfig
// Replaces ABAP: DO gv_count TIMES + ASSIGN COMPONENT columnname OF STRUCTURE
// Keys are UPPERCASE to match hdbtable column names
function buildRowFromSplit(splitData, lineItemConfig, extraFields = {}) {
  const row = {};
  for (const cfg of lineItemConfig) {
    const raw = splitData[cfg.Colseqno - 1] ?? '';
    const val = cfg.IsDateField === 'Y' ? parseDate(raw) : raw;
    row[cfg.Columnname.toUpperCase()] = val || null;
  }
  for (const [k, v] of Object.entries(extraFields)) {
    row[k.toUpperCase()] = v;
  }
  return row;
}

// buildKeyWhere: parameterised WHERE clause from key fields
// Replaces ABAP out_cust_where string building loop
// Returns: { clause: 'COL1 = ? AND COL2 = ?', values: ['v1','v2'] }
// NOTE: uses unquoted column names so the clause works with both
//       CAP ORM SELECT.from().where(rawStr, ...vals) and raw SQL.
function buildKeyWhere(splitData, lineItemConfig, keyFields) {
  const parts = [], values = [];
  for (const kf of keyFields) {
    const cfg = lineItemConfig.find(c => c.Columnname === kf);
    if (!cfg) continue;
    parts.push(`${kf.toUpperCase()} = ?`);
    values.push(splitData[cfg.Colseqno - 1] ?? '');
  }
  return { clause: parts.join(' AND '), values };
}

// getEntityDef: resolve a CDS entity definition by short name or alias.
// Works even when the entity is in the zmdr namespace or any other namespace.
function getEntityDef(tableName) {
  if (!cds.model) return null;
  const defs = cds.model.definitions || {};
  const cleanName = tableName.replace(/^zmdr[._]/i, '');

  let entityKey = Object.keys(defs).find(k => k === tableName || k === `zmdr.${tableName}` || k === `zmdr.${cleanName}` || k === `BulkService.${tableName}`)
    || Object.keys(defs).find(k => {
      const d = defs[k];
      return d && (d.kind === 'entity' || d.kind === 'type') && (
        k.split('.').pop().toUpperCase() === tableName.toUpperCase() ||
        k.split('.').pop().toUpperCase() === cleanName.toUpperCase()
      );
    });

  let entity = entityKey ? defs[entityKey] : null;
  if (entity && !entity.name) entity.name = entityKey;

  // Follow projections (CDS 7/8 CSN format) to base DB entity
  while (entity) {
    let targetName = entity.target;
    if (!targetName && entity.projection && entity.projection.from && entity.projection.from.ref) {
      targetName = entity.projection.from.ref[0];
    }
    if (!targetName && entity.query && entity.query.SELECT && entity.query.SELECT.from && entity.query.SELECT.from.ref) {
      targetName = entity.query.SELECT.from.ref[0];
    }
    if (targetName && defs[targetName]) {
      entity = defs[targetName];
      if (!entity.name) entity.name = targetName;
    } else {
      break;
    }
  }

  // Also check cds.entities
  if (!entity && cds.entities) {
    const z = cds.entities('zmdr');
    entity = (z && (z[tableName] || z[cleanName])) || cds.entities[tableName] || cds.entities[cleanName];
  }

  return entity;
}

// getSqlTableName: resolve the physical SQL table name for raw DDL/DML.
function getSqlTableName(db, tableName) {
  const entity = getEntityDef(tableName);
  if (entity && entity.name) {
    // Both SQLite and HANA CAP views use underscored namespace mapping
    const name = entity.name.replace(/\./g, '_');
    return (db && db.kind === 'hana') ? name.toUpperCase() : name;
  }
  return tableName;
}

// checkExists: returns true if at least one row matches the WHERE clause.
async function checkExists(db, tableName, whereClause, values) {
  const entity = getEntityDef(tableName);
  if (entity) {
    try {
      const whereObj = sqlToObject(entity, whereClause, values);
      const rows = await db.run(
        SELECT.from(entity.name).where(whereObj).limit(1)
      );
      return rows.length > 0;
    } catch (e) {
      console.warn(`[checkExists] ORM path failed for ${tableName}, trying raw SQL:`, e.message);
    }
  }
  // Raw SQL fallback (HANA, or entity not in CDS model)
  const sqlTablename = getSqlTableName(db, tableName);
  let finalWhere = whereClause;
  if (entity) {
    const whereObj = sqlToObject(entity, whereClause, values);
    finalWhere = Object.keys(whereObj).map(c => `"${c.toUpperCase()}" = ?`).join(' AND ');
  } else {
    finalWhere = finalWhere.replace(/"([A-Z0-9_]+)"/gi, (m, c1) => `"${c1.replace(/_/g, '').toUpperCase()}"`);
  }
  const sql = `SELECT COUNT(*) AS CNT FROM "${sqlTablename}" WHERE ${finalWhere}`;
  const r = await db.run(sql, values);
  return (r[0]?.CNT || r[0]?.cnt || 0) > 0;
}

// Convert an object with uppercase keys into the exact keys defined in the CDS entity
function mapToEntityElements(entity, obj) {
  if (!entity || !entity.elements) return obj;
  const mapped = {};
  for (const [k, v] of Object.entries(obj)) {
    const cleanKey = k.replace(/_/g, '').toUpperCase();
    const elName = Object.keys(entity.elements).find(
      e => e.toUpperCase() === k.toUpperCase() || e.replace(/_/g, '').toUpperCase() === cleanKey
    );
    if (elName) {
      mapped[elName] = v;
    } else {
      mapped[k] = v;
    }
  }
  return mapped;
}

// Convert simple parameterised WHERE clause to an object for CAP ORM
function sqlToObject(entity, whereClause, values) {
  const obj = {};
  const regex = /"?([a-zA-Z0-9_]+)"?\s*=\s*\?/g;
  let match;
  let i = 0;
  while ((match = regex.exec(whereClause)) !== null) {
    if (i < values.length) {
      obj[match[1]] = values[i++];
    }
  }
  return mapToEntityElements(entity, obj);
}

// readRows: SELECT * FROM <tablename> WHERE <parameterised>
// Replaces ABAP: SELECT * FROM (im_tablename) WHERE (out_cust_where)
async function readRows(db, tableName, whereClause, values) {
  const entity = getEntityDef(tableName);
  if (entity) {
    try {
      const whereObj = sqlToObject(entity, whereClause, values);
      return await db.run(SELECT.from(entity.name).where(whereObj));
    } catch (e) {
      console.warn(`[readRows] ORM failed for ${tableName}, fallback to raw:`, e.message);
    }
  }
  const sqlTablename = getSqlTableName(db, tableName);
  let finalWhere = whereClause;
  if (entity) {
    const whereObj = sqlToObject(entity, whereClause, values);
    finalWhere = Object.keys(whereObj).map(c => `"${c.toUpperCase()}" = ?`).join(' AND ');
  } else {
    finalWhere = finalWhere.replace(/"([A-Z0-9_]+)"/gi, (m, c1) => `"${c1.replace(/_/g, '').toUpperCase()}"`);
  }
  return await db.run(`SELECT * FROM "${sqlTablename}" WHERE ${finalWhere}`, values);
}

// insertRow: parameterised INSERT INTO <tablename>
async function insertRow(db, tableName, rowObject) {
  const entity = getEntityDef(tableName);
  let mappedRow = rowObject;
  if (entity) {
    mappedRow = mapToEntityElements(entity, rowObject);
    try {
      if (entity.elements) {
        for (const k of Object.keys(mappedRow)) {
          if (!entity.elements[k]) delete mappedRow[k];
        }
      }
      await db.run(INSERT.into(entity.name).entries(mappedRow));
      return;
    } catch (e) {
      console.warn(`[insertRow] ORM failed for ${tableName}, fallback to raw:`, e.message);
    }
  }
  const sqlTablename = getSqlTableName(db, tableName);
  const cols = Object.keys(mappedRow).filter(k => mappedRow[k] !== undefined);
  const vals = cols.map(k => mappedRow[k]);
  const ph = cols.map(() => '?').join(', ');
  const cl = cols.map(c => `"${c.toUpperCase()}"`).join(', ');
  await db.run(`INSERT INTO "${sqlTablename}" (${cl}) VALUES (${ph})`, vals);
}

// updateRow: parameterised UPDATE <tablename> SET ... WHERE ...
async function updateRow(db, tableName, setObject, whereClause, whereValues) {
  const entity = getEntityDef(tableName);
  let mappedSet = setObject;
  let finalWhere = whereClause;
  if (entity) {
    mappedSet = mapToEntityElements(entity, setObject);
    try {
      const whereObj = sqlToObject(entity, whereClause, whereValues);
      await db.run(UPDATE(entity.name).set(mappedSet).where(whereObj));
      return;
    } catch (e) {
      console.warn(`[updateRow] ORM failed for ${tableName}, fallback to raw:`, e.message);
    }
    const whereObj = sqlToObject(entity, whereClause, whereValues);
    finalWhere = Object.keys(whereObj).map(c => `"${c.toUpperCase()}" = ?`).join(' AND ');
  } else {
    finalWhere = finalWhere.replace(/"([A-Z0-9_]+)"/gi, (m, c1) => `"${c1.replace(/_/g, '').toUpperCase()}"`);
  }
  const sqlTablename = getSqlTableName(db, tableName);
  const cols = Object.keys(mappedSet);
  const vals = cols.map(k => mappedSet[k]);
  const setCl = cols.map(c => `"${c.toUpperCase()}" = ?`).join(', ');
  await db.run(`UPDATE "${sqlTablename}" SET ${setCl} WHERE ${finalWhere}`, [...vals, ...whereValues]);
}

// deleteRows: parameterised DELETE FROM <tablename> WHERE ...
async function deleteRows(db, tableName, whereClause, values) {
  const entity = getEntityDef(tableName);
  let finalWhere = whereClause;
  if (entity) {
    try {
      const whereObj = sqlToObject(entity, whereClause, values);
      await db.run(DELETE.from(entity.name).where(whereObj));
      return;
    } catch (e) {
      console.warn(`[deleteRows] ORM failed for ${tableName}, fallback to raw:`, e.message);
    }
    const whereObj = sqlToObject(entity, whereClause, values);
    finalWhere = Object.keys(whereObj).map(c => `"${c.toUpperCase()}" = ?`).join(' AND ');
  } else {
    finalWhere = finalWhere.replace(/"([A-Z0-9_]+)"/gi, (m, c1) => `"${c1.replace(/_/g, '').toUpperCase()}"`);
  }
  const sqlTablename = getSqlTableName(db, tableName);
  await db.run(`DELETE FROM "${sqlTablename}" WHERE ${finalWhere}`, values);
}

module.exports = {
  parseDate, buildRowFromSplit, buildKeyWhere, getEntityDef, getSqlTableName,
  checkExists, readRows, insertRow, updateRow, deleteRows, mapToEntityElements
};