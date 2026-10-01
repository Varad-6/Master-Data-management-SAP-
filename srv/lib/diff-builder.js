// srv/lib/diff-builder.js
// Builds Old/New paired comparison data for the "See Changes" Excel download.
// Replaces the raw BulkTemp data dump with a proper diff format:
//   Operation | Key1 | Key2 | Old Field1 | New Field1 | Old Field2 | New Field2 | ...
//
// For Create:  Old columns are blank
// For Update:  Old columns have current DB values, New columns have proposed values
// For Close:   Old columns have current DB values
'use strict';

const { readRows, buildKeyWhere } = require('./db-dynamic');
const cds = require('@sap/cds');

/**
 * Normalise BulkItmConfig column accessors (handles casing variations from SQLite vs HANA).
 */
function norm(cfg) {
    return {
        colName:  (cfg.ColumnName || cfg.Columnname || cfg.COLUMNNAME || '').toUpperCase(),
        seqNo:    cfg.ColumnSeqNo ?? cfg.Colseqno ?? cfg.columnseqno ?? 1,
        isKey:    (cfg.IsMatching || cfg.Ismatching || '') === 'Y',
        isDate:   (cfg.IsDateField || cfg.Isdatefield || '') === 'Y',
    };
}

/**
 * Parse a «-delimited BulkData string into a { COLUMNNAME: value } object.
 */
function parseBulkData(bulkDataStr, itemConfig) {
    const parts = (bulkDataStr || '').split('«');
    const row = {};
    for (const cfg of itemConfig) {
        const n = norm(cfg);
        row[n.colName] = parts[n.seqNo - 1] ?? '';
    }
    return row;
}

/**
 * Fetch the existing (old/current) record from the main table by key values.
 * For versioned tables, looks for VERSION_ACTIVE = 'Y', with fallback to key-only lookup.
 */
async function fetchOldRecord(db, tableName, keyValues, isVersioned) {
    const whereParts = [];
    const whereVals = [];
    for (const [k, v] of Object.entries(keyValues)) {
        if (v !== undefined && v !== null && v !== '') {
            whereParts.push(`${k} = ?`);
            whereVals.push(v);
        }
    }
    if (whereParts.length === 0) return null;

    try {
        if (isVersioned) {
            // First try with VersionActive = 'Y'
            const vWhereParts = [...whereParts, `VersionActive = ?`];
            const vWhereVals = [...whereVals, 'Y'];
            const rows = await readRows(db, tableName, vWhereParts.join(' AND '), vWhereVals);
            if (rows && rows.length > 0) return rows[0];

            // Fallback 1: Try with VERSION_ACTIVE = 'Y'
            try {
                const v2WhereParts = [...whereParts, `VERSION_ACTIVE = ?`];
                const v2WhereVals = [...whereVals, 'Y'];
                const rows2 = await readRows(db, tableName, v2WhereParts.join(' AND '), v2WhereVals);
                if (rows2 && rows2.length > 0) return rows2[0];
            } catch (e2) { /* ignore fallback errors */ }

            // Fallback 2: Query by key alone and pick the active record (or any existing record not currently in progress)
            try {
                const keyOnlyRows = await readRows(db, tableName, whereParts.join(' AND '), whereVals);
                if (keyOnlyRows && keyOnlyRows.length > 0) {
                    const activeRow = keyOnlyRows.find(r => {
                        const v = r.VersionActive || r.VERSIONACTIVE || r.versionActive || r.VERSION_ACTIVE;
                        return v === 'Y';
                    });
                    // ONLY return an old row if it's NOT a draft (I=Insert Draft, G=Update Draft)
                    const validOldRow = keyOnlyRows.find(r => {
                        const v = r.VersionActive || r.VERSIONACTIVE || r.versionActive || r.VERSION_ACTIVE;
                        return v !== 'G' && v !== 'I';
                    });
                    return activeRow || validOldRow;
                }
            } catch (e3) { /* ignore fallback errors */ }

            return null;
        } else {
            // Non-versioned table lookup by key
            const rows = await readRows(db, tableName, whereParts.join(' AND '), whereVals);
            return (rows && rows.length > 0) ? rows[0] : null;
        }
    } catch (e) {
        console.warn(`[diff-builder] fetchOldRecord failed for ${tableName}:`, e.message);
        return null;
    }
}

/**
 * Build the diff data as an array of «-delimited strings.
 * First row is the header, subsequent rows are data.
 *
 * @param {Object} opts
 * @param {string} opts.tableName         - Entity name (e.g. 'ZMDR_ACCOUNT')
 * @param {Array}  opts.bulkTempRecords   - BulkTemp rows (each has .BulkData/.bulkdata and .ActionType/.actiontype)
 * @param {Array}  opts.itemConfig        - BulkItmConfig rows for this entity, sorted by ColumnSeqNo
 * @param {boolean} opts.isVersioned      - Whether the table is versioned
 * @param {Array}  [opts.versionedRows]   - For versioned tables: the raw row objects from the main table (VERSION_ACTIVE='G')
 * @returns {Promise<Array<{data: string}>>} Array of { data: '«-delimited string' }
 */
async function buildDiffData(opts) {
    const { tableName, bulkTempRecords, itemConfig, isVersioned, versionedRows } = opts;
    const db = await cds.connect.to('db');

    // Separate key fields from non-key fields, sorted by sequence
    const sorted = [...itemConfig].sort((a, b) => (norm(a).seqNo) - (norm(b).seqNo));
    const keyConfigs = sorted.filter(c => norm(c).isKey);
    const nonKeyConfigs = sorted.filter(c => !norm(c).isKey);

    // Build header row: Operation | key1 | key2 | Old nonKey1 | Old nonKey2 | New nonKey1 | New nonKey2
    const headerParts = ['Operation'];
    for (const kc of keyConfigs) {
        headerParts.push(norm(kc).colName);
    }
    for (const nkc of nonKeyConfigs) {
        const name = norm(nkc).colName;
        headerParts.push(`Old ${name}`);
    }
    for (const nkc of nonKeyConfigs) {
        const name = norm(nkc).colName;
        headerParts.push(`New ${name}`);
    }
    const headerRow = headerParts.join('«');

    // Process each record
    const dataRows = [];

    if (isVersioned && versionedRows) {
        // Versioned tables: records come as raw objects from the main table
        for (const newRow of versionedRows) {
            // Normalise keys to uppercase
            const normRow = {};
            for (const [k, v] of Object.entries(newRow)) {
                normRow[k.toUpperCase()] = v ?? '';
            }

            // Determine operation from VersionActive
            let operation = 'Update';
            if (normRow['VERSIONACTIVE'] === 'I' || normRow['VERSION_ACTIVE'] === 'I') {
                operation = 'Create';
            }

            // Get key values for old record lookup
            const keyValues = {};
            for (const kc of keyConfigs) {
                keyValues[norm(kc).colName] = normRow[norm(kc).colName] || '';
            }

            // Fetch old record (VERSION_ACTIVE = 'Y')
            const oldRow = await fetchOldRecord(db, tableName, keyValues, true);
            const normOld = {};
            if (oldRow) {
                for (const [k, v] of Object.entries(oldRow)) {
                    normOld[k.toUpperCase()] = v ?? '';
                }
            }

            // Build data row
            const rowParts = [operation];
            for (const kc of keyConfigs) {
                rowParts.push(normRow[norm(kc).colName] || '');
            }
            for (const nkc of nonKeyConfigs) {
                const name = norm(nkc).colName;
                rowParts.push(oldRow ? (normOld[name] ?? '') : '');
            }
            for (const nkc of nonKeyConfigs) {
                const name = norm(nkc).colName;
                rowParts.push(normRow[name] ?? '');
            }
            dataRows.push(rowParts.join('«'));
        }
    } else {
        // Non-versioned tables: records come from BulkTemp
        for (const rec of bulkTempRecords) {
            const bulkData = rec.BulkData || rec.bulkdata || rec.BULKDATA || '';
            const actionType = rec.ActionType || rec.actiontype || rec.ACTIONTYPE || 'Create';

            // Parse proposed (new) values
            const newValues = parseBulkData(bulkData, sorted);

            // Determine operation label
            let operation = 'Create';
            if (actionType.toUpperCase() === 'AMEND' || actionType.toUpperCase() === 'UPDATE') {
                operation = 'Update';
            } else if (actionType.toUpperCase() === 'CLOSE' || actionType.toUpperCase() === 'DELETE') {
                operation = 'Close';
            }

            // Get key values
            const keyValues = {};
            for (const kc of keyConfigs) {
                keyValues[norm(kc).colName] = newValues[norm(kc).colName] || '';
            }

            // Fetch old record for Update/Close
            let oldRow = null;
            let normOld = {};
            if (operation !== 'Create') {
                oldRow = await fetchOldRecord(db, tableName, keyValues, false);
                if (oldRow) {
                    for (const [k, v] of Object.entries(oldRow)) {
                        normOld[k.toUpperCase()] = v ?? '';
                    }
                }
            }

            // Build data row
            const rowParts = [operation];
            for (const kc of keyConfigs) {
                rowParts.push(newValues[norm(kc).colName] || '');
            }
            for (const nkc of nonKeyConfigs) {
                const name = norm(nkc).colName;
                rowParts.push(oldRow ? (normOld[name] ?? '') : '');
            }
            for (const nkc of nonKeyConfigs) {
                const name = norm(nkc).colName;
                rowParts.push(newValues[name] ?? '');
            }
            dataRows.push(rowParts.join('«'));
        }
    }

    // Return as array of { data: string } — same format frontend expects
    const result = [{ data: headerRow }];
    for (const row of dataRows) {
        result.push({ data: row });
    }
    return result;
}

module.exports = { buildDiffData, parseBulkData, fetchOldRecord };
