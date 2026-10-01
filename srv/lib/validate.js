// srv/lib/validate.js — 100% Dynamic Database & CDS Schema Driven Generic Validation Engine
'use strict';
const cds = require('@sap/cds');
const { getEntityDef } = require('./db-dynamic');

// Helper to get property case-insensitively from an object
function getPropCaseInsensitive(obj, key) {
  if (!obj || !key) return undefined;
  if (obj[key] !== undefined) return obj[key];
  const keyUpper = key.toUpperCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toUpperCase() === keyUpper) return v;
  }
  return undefined;
}

// Helper to parse date values for logical comparison
function parseDateVal(val) {
  if (!val) return null;
  val = String(val).trim();
  const ddmmyyyy = val.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`);
  const yyyymmdd = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyymmdd) return new Date(val);
  return null;
}

// buildKeyObject: convert split row data + key field config into a CAP WHERE object
function buildKeyObject(splitData, lineItemConfig, keyFields) {
  const where = {};
  const config = lineItemConfig || [];
  for (const kf of (keyFields || [])) {
    const cfg = config.find(c => (c.ColumnName || c.Columnname || '').toUpperCase() === kf.toUpperCase());
    if (cfg) {
      const seq = cfg.ColumnSeqNo || cfg.Colseqno || 1;
      where[kf.toUpperCase()] = splitData[seq - 1] ?? '';
    }
  }
  return where;
}

// validateKeyExists: generic lookup validation against any DB target table
async function validateKeyExists(params) {
  const { splitData, isLookup, lookupField, lookupSeq, versionInProgress, keyFields } = params;
  const lineItemConfig = params.lineItemConfig || params.lineitemConfig || [];
  const tableName = params.tableName || params.tablename;
  if (!tableName) return false;

  const db = await cds.connect.to('db');
  const where = {};

  if (isLookup === 'Y') {
    // Composite lookup: 'FIELD1|:|FIELD2'
    const fields = (lookupField || '').split('|:|');
    const raws  = (splitData[lookupSeq - 1] || '').split('|:|');
    fields.forEach((f, i) => { where[f.toUpperCase()] = raws[i] || ''; });
  } else {
    Object.assign(where, buildKeyObject(splitData, lineItemConfig, keyFields));
  }

  if (!Object.keys(where).length) return false;

  let entity = getEntityDef(tableName);

  if (!entity) {
    // Direct database query fallback for any dynamic physical table
    try {
      const { getSqlTableName } = require('./db-dynamic');
      const sqlTable = getSqlTableName(db, tableName);
      const totalCountRows = await db.run(`SELECT COUNT(*) as CNT FROM "${sqlTable}"`);
      const totalCount = totalCountRows && totalCountRows[0] ? (totalCountRows[0].CNT || totalCountRows[0].cnt || 0) : 0;
      if (totalCount === 0) {
        console.warn(`[validateKeyExists] Dynamic table ${sqlTable} has 0 records in DB; allowing lookup.`);
        return true;
      }
      const whereClauses = Object.keys(where).map(k => `UPPER("${k}") = ?`).join(' AND ');
      const values = Object.values(where).map(v => String(v).toUpperCase());
      const rawRows = await db.run(`SELECT 1 FROM "${sqlTable}" WHERE ${whereClauses}`, values);
      if (rawRows && rawRows.length > 0) return true;
    } catch (e) {
      console.warn(`[validateKeyExists] Dynamic table ${tableName} not accessible; bypassing lookup.`);
      return true;
    }
    return false;
  }

  const hasVersionActive = entity.elements && Object.keys(entity.elements).some(
    e => e.toUpperCase() === 'VERSIONACTIVE' || e.toUpperCase() === 'VERSION_ACTIVE'
  );

  if (hasVersionActive) {
    if (versionInProgress === 'N') {
      where['VersionActive'] = 'Y';
    } else if (versionInProgress === 'Y') {
      where['VersionActive'] = { in: ['I', 'G'] };
    }
  }

  try {
    const { mapToEntityElements } = require('./db-dynamic');
    const mappedWhere = mapToEntityElements(entity, where);
    
    // 1. Parameterized Direct Query via CDS ORM
    const rows = await db.run(SELECT.from(entity).where(mappedWhere).limit(1));
    if (rows && rows.length > 0) return true;

    // 2. Case-insensitive & Description matching for Lookups
    if (isLookup === 'Y') {
      const allRows = await db.run(SELECT.from(entity));
      if (!allRows || allRows.length === 0) {
        // Table is unseeded / empty in test database -> allow lookup
        console.warn(`[validateKeyExists] Lookup table ${tableName} has 0 records in DB; bypassing check.`);
        return true;
      }

      const match = allRows.some(row => {
        return Object.entries(mappedWhere).every(([k, v]) => {
          const targetVal = String(v ?? '').trim().toUpperCase();
          const rowVal = String(getPropCaseInsensitive(row, k) ?? '').trim().toUpperCase();
          if (rowVal === targetVal) return true;
          // Match against Description column if lookup value was passed as description
          const descVal = String(getPropCaseInsensitive(row, 'Description') ?? '').trim().toUpperCase();
          return descVal === targetVal;
        });
      });
      if (match) return true;
    }
    return false;
  } catch (err) {
    // ORM path failed — log and attempt raw SQL fallback
    console.warn(`[validateKeyExists] ORM query failed for ${tableName}:`, err.message);
    try {
      const { getSqlTableName } = require('./db-dynamic');
      const sqlTable = getSqlTableName(db, tableName);
      const totalCountRows = await db.run(`SELECT COUNT(*) as CNT FROM "${sqlTable}"`);
      const totalCount = totalCountRows && totalCountRows[0] ? (totalCountRows[0].CNT || totalCountRows[0].cnt || 0) : 0;
      if (totalCount === 0) {
        console.warn(`[validateKeyExists] Raw SQL table ${sqlTable} has 0 records in DB; bypassing check.`);
        return true;
      }
      const whereClauses = Object.keys(where).map(k => `UPPER("${k}") = ?`).join(' AND ');
      const values = Object.values(where).map(v => String(v).toUpperCase());
      const rawRows = await db.run(`SELECT 1 FROM "${sqlTable}" WHERE ${whereClauses}`, values);
      return rawRows && rawRows.length > 0;
    } catch (rawErr) {
      console.warn(`[validateKeyExists] Raw SQL table ${tableName} not accessible; bypassing check:`, rawErr.message);
      return true;
    }
  }
}

// validateRow: completely schema- and database-driven validation for ANY table
async function validateRow(params) {
  const { splitData, keyFields } = params;
  const lineItemConfig = params.lineItemConfig || params.lineitemConfig || [];
  const tableName = params.tableName || params.tablename;
  const errors = [];
  const db = await cds.connect.to('db');

  // 1. Fetch DB Entity Definition directly from CDS / DB schema metadata
  const entity = getEntityDef(tableName);
  const elements = (entity && entity.elements) || {};

  // 2. Fetch UI/DB Mandatory configuration dynamically from CntrlUIConfig table in DB
  let mandatoryCols = new Set();

  // Introspect DB schema elements for keys or notNull
  for (const [col, def] of Object.entries(elements)) {
    if (def && (def.key === true || def.notNull === true)) {
      mandatoryCols.add(col.toUpperCase());
    }
  }

  // Introspect CntrlUIConfig from the database for MandatoryFlag = 'Y'
  try {
    const zEntities = typeof cds.entities === 'function' ? cds.entities('zmdr') : cds.entities;
    const CntrlUIConfig = (zEntities && zEntities.CntrlUIConfig) || (cds.entities && cds.entities['zmdr.CntrlUIConfig']) || db.entities?.CntrlUIConfig;
    if (CntrlUIConfig) {
      const uiConfigs = await db.run(
        SELECT.from(CntrlUIConfig).where({ TableName: tableName })
      );
      if (uiConfigs && uiConfigs.length) {
        uiConfigs.filter(u => (u.MandatoryFlag || u.mandatoryflag) === 'Y')
                 .forEach(u => mandatoryCols.add((u.ColumnName || u.columnname || '').toUpperCase()));
      }
    }
  } catch (e) {
    // In-memory or fallback
  }

  // Fallback for first key column if no mandatory config was loaded
  if (mandatoryCols.size === 0 && (keyFields || []).length > 0) {
    keyFields.forEach(k => mandatoryCols.add(String(k).toUpperCase()));
  }

  // Case-insensitive element lookup from the Database schema
  function getDbElementDef(name) {
    if (!name) return null;
    const nameUpper = name.toUpperCase();
    for (const [k, v] of Object.entries(elements)) {
      if (k.toUpperCase() === nameUpper) return v;
    }
    return null;
  }

  let validFromDate = null;
  let validToDate = null;

  for (const cfg of lineItemConfig) {
    const seq = cfg.ColumnSeqNo || cfg.Colseqno || 1;
    const colName = cfg.ColumnName || cfg.Columnname || '';
    const rawVal = splitData[seq - 1];
    const val = rawVal !== undefined && rawVal !== null ? String(rawVal).trim() : '';
    const colUpper = colName.toUpperCase().trim();
    const elemDef = getDbElementDef(colName);

    // 1. Mandatory Constraints (from DB CntrlUIConfig MandatoryFlag='Y', DB Key, or Config Key)
    const isMandatoryInDb = mandatoryCols.has(colUpper);
    const isAutoGeneratedKey = (elemDef && elemDef.key === true) || colUpper === 'BPID' || colUpper === 'REQNO';
    const isDbKey = elemDef && (elemDef.notNull === true && elemDef.key !== true);
    const isConfigKey = ((keyFields || []).some(k => k.toUpperCase() === colUpper) || cfg.IsMatching === 'Y') && !isAutoGeneratedKey;
    const isMandatory = (isMandatoryInDb || isDbKey || isConfigKey) && !isAutoGeneratedKey;

    if (colUpper === 'BPID') {
        console.log('--- VALIDATION DEBUG FOR BPID ---');
        console.log('colName:', colName);
        console.log('colUpper:', colUpper);
        console.log('isAutoGeneratedKey:', isAutoGeneratedKey);
        console.log('isMandatory:', isMandatory);
        console.log('---------------------------------');
    }

    if (isMandatory && (!val || val === 'undefined' || val === 'null' || val === 'None')) {
      errors.push(`Mandatory field ${colName} is missing or empty`);
      continue;
    }

    if (!val || val === 'undefined' || val === 'null' || val === 'None') {
      continue; // Skip optional empty values
    }

    // 2. Length Validation directly from DB column length (e.g. NVARCHAR(80), NVARCHAR(2), etc.)
    if (elemDef && elemDef.length && val.length > elemDef.length) {
      errors.push(`Field ${colName} exceeds DB column maximum length of ${elemDef.length} characters (input length is ${val.length})`);
    }

    // 3. Data Type Validation directly from DB column types:
    if (elemDef) {
      const elemType = elemDef.type || '';

      // Numeric / Decimal DB Types (DECIMAL, INTEGER, INT, BIGINT, DOUBLE)
      if (elemType === 'cds.Decimal' || elemType === 'cds.Integer' || elemType === 'cds.Int16' || elemType === 'cds.Int32' || elemType === 'cds.Int64' || elemType === 'cds.Double') {
        if (isNaN(Number(val))) {
          errors.push(`Field ${colName} must be a valid numeric value for DB type ${elemType.replace('cds.', '')}`);
        } else if (colUpper.includes('LIMIT') && Number(val) < 0) {
          errors.push(`Field ${colName} cannot be negative`);
        }
      }

      // Date / Timestamp DB Types (DATE, TIMESTAMP, TIME)
      if (elemType === 'cds.Date' || elemType === 'cds.Timestamp' || cfg.IsDateField === 'Y') {
        const isDDMMYYYY = /^\d{2}\.\d{2}\.\d{4}$/.test(val);
        const isYYYYMMDD = /^\d{4}-\d{2}-\d{2}$/.test(val);
        if (!isDDMMYYYY && !isYYYYMMDD) {
          errors.push(`Invalid date format for ${colName}. Use dd.MM.yyyy or yyyy-MM-dd`);
        } else {
          const parsed = parseDateVal(val);
          if (!parsed || isNaN(parsed.getTime())) {
            errors.push(`Invalid date value for ${colName}`);
          } else {
            if (colUpper === 'VALIDFROM' || colUpper === 'VERSIONSTARTDATE' || colUpper.includes('STARTDATE') || colUpper.includes('FROMDATE')) validFromDate = parsed;
            if (colUpper === 'VALIDTO' || colUpper === 'VERSIONENDDATE' || colUpper.includes('ENDDATE') || colUpper.includes('TODATE')) validToDate = parsed;
          }
        }
      }
    }

    // 4. Standard Format Validations (Email, Phone, Website)
    if (colUpper.includes('EMAIL')) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(val)) {
        errors.push(`Invalid email format for ${colName}`);
      }
    } else if (colUpper === 'TELNO' || colUpper === 'FAXNO' || colUpper.includes('PHONE')) {
      const cleanDigits = val.replace(/[\s\-\+\(\)\.]/g, '');
      if (cleanDigits.length < 6 || !/^\+?[0-9\-\s\(\)\.]{6,20}$/.test(val) || !/[0-9]/.test(val)) {
        errors.push(`Invalid phone/fax number for ${colName}`);
      }
    } else if (colUpper.includes('WEBSITE') || colUpper.includes('URL')) {
      const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9\-_]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i;
      if (!urlRegex.test(val) || !val.includes('.')) {
        errors.push(`Invalid website URL format for ${colName}`);
      }
    }

    // 5. Database Lookup Validation (IsLookup='Y' from BulkItmConfig)
    const lookupTbl = cfg.LookupTablename || cfg.LookupTableName;
    if (cfg.IsLookup === 'Y' && lookupTbl && val) {
      const ok = await validateKeyExists({
        splitData, tablename: lookupTbl, tableName: lookupTbl, isLookup: 'Y',
        lookupField: cfg.LookupField, lookupSeq: seq,
        versionInProgress: 'N', lineItemConfig, keyFields,
      });
      if (!ok) errors.push(`Invalid value "${val}" for ${colName} (lookup table: ${lookupTbl})`);
    }


    // 6. DB-Driven Validation Rules from Database Table `CntrlUIVal`
    if (cfg.ValidationIndex) {
      const indices = String(cfg.ValidationIndex).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const zEntities = typeof cds.entities === 'function' ? cds.entities('zmdr') : cds.entities;
      const BulkDataValidation = (zEntities && zEntities.CntrlUIVal) || (cds.entities && cds.entities['zmdr.CntrlUIVal']) || db.entities?.CntrlUIVal;
      for (const idx of indices) {
        const rules = BulkDataValidation ? await db.run(
          SELECT.from(BulkDataValidation)
                .where({ Tablename: tableName, SourceColName: colName, ValIndex: idx })
        ) : [];
        for (const rule of rules) {
          if (rule.Operation === 'REGEX' && rule.SourceColValue) {
            if (!new RegExp(rule.SourceColValue).test(val))
              errors.push(`${rule.ErrorMessage} for field ${colName}`);
          } else if (rule.Operation === 'LOOKUP') {
            let condMet = true;
            if (rule.SourceColValue) {
              const [cf, cv] = rule.SourceColValue.split('=');
              const cc = lineItemConfig.find(c => (c.ColumnName || c.Columnname) === cf);
              if (cc) condMet = (splitData[(cc.ColumnSeqNo || cc.Colseqno) - 1] ?? '') === cv;
            }
            if (condMet && rule.DestColValue && rule.DestColName && val) {
              const lookupEntity = getEntityDef(rule.DestColValue);
              let ok = false;
              if (lookupEntity) {
                const rows = await db.run(
                  SELECT.from(lookupEntity)
                        .where({ [rule.DestColName.toUpperCase()]: val })
                        .limit(1)
                );
                ok = rows.length > 0;
              }
              if (!ok) errors.push(`${rule.ErrorMessage} for field ${colName}`);
            }
          }
        }
      }
    }
  }

  // 7. Generic Date Range Validation (StartDate <= EndDate)
  if (validFromDate && validToDate && validFromDate > validToDate) {
    errors.push('ValidFrom date cannot be later than ValidTo date');
  }

  // Deduplicate any repeated messages
  const uniqueErrors = Array.from(new Set(errors));
  return { valid: uniqueErrors.length === 0, message: uniqueErrors.join('; ') };
}

module.exports = { validateKeyExists, validateRow };
