// srv/lib/fuzzy-engine.js — Enterprise Hybrid Fuzzy Matching & Deduplication Engine
'use strict';

const cds = require('@sap/cds');
const { getEntityDef, mapToEntityElements } = require('./db-dynamic');

// 1. Text Normalization: Cleans noise, corporate suffixes, punctuation, and repeated chars
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Strip common connector words
    .replace(/\b(and|the|of|for|in|on|at|to|a|an)\b/gi, ' ')
    // Strip common company/business entity suffixes and descriptors
    .replace(/\b(pvt|private|ltd|limited|inc|incorporated|corp|corporation|llp|llc|gmbh|ag|sa|co|company|holdings|group|services|service|enterprises|enterprise|solutions|solution|technologies|technology|tech|consultancy|consulting)\b/gi, ' ')
    // Replace non-alphanumeric with spaces
    .replace(/[^a-z0-9\s]/gi, ' ')
    // Collapse consecutive whitespace
    .replace(/\s+/g, ' ')
    // Collapse consecutive identical characters (e.g., 'raaaam' -> 'ram')
    .replace(/(.)\1{2,}/g, '$1')
    .trim();
}

// 2. Levenshtein Distance Matrix
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Normalized Levenshtein Similarity (0.0 to 1.0)
function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return Math.max(0, 1.0 - (dist / maxLen));
}

// 3. Sørensen-Dice Bigram Token Similarity
function getBigrams(str) {
  const s = str.toLowerCase();
  const bigrams = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.substring(i, i + 2));
  }
  return bigrams;
}

function diceSimilarity(a, b) {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return levenshteinSimilarity(a, b);

  const bgA = getBigrams(a);
  const bgB = getBigrams(b);

  let intersection = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++;
  }

  return (2.0 * intersection) / (bgA.size + bgB.size);
}

// 4. Soundex Phonetic Encoder
function soundex(str) {
  if (!str) return '0000';
  const clean = str.toUpperCase().replace(/[^A-Z]/g, '');
  if (!clean.length) return '0000';

  const map = {
    B: 1, F: 1, P: 1, V: 1,
    C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
    D: 3, T: 3,
    L: 4,
    M: 5, N: 5,
    R: 6
  };

  const firstLetter = clean[0];
  let res = firstLetter;
  let prevCode = map[firstLetter] || 0;

  for (let i = 1; i < clean.length; i++) {
    const char = clean[i];
    const code = map[char] || 0;

    if (code !== 0 && code !== prevCode) {
      res += code;
    }
    prevCode = code;
    if (res.length === 4) break;
  }

  return (res + '0000').slice(0, 4);
}

function soundexSimilarity(strA, strB) {
  const wordsA = strA.split(/\s+/).filter(Boolean);
  const wordsB = strB.split(/\s+/).filter(Boolean);
  if (!wordsA.length || !wordsB.length) return 0;

  let matches = 0;
  for (const wa of wordsA) {
    const codeA = soundex(wa);
    for (const wb of wordsB) {
      if (codeA === soundex(wb)) {
        matches++;
        break;
      }
    }
  }
  return matches / Math.max(wordsA.length, wordsB.length);
}

// 5. Multi-Factor Hybrid Similarity Score (0 to 100)
function calculateHybridScore(source, target) {
  const normA = normalizeText(source);
  const normB = normalizeText(target);

  if (!normA || !normB) return 0;
  if (normA === normB) return 100;

  // Component 1: Normalized Dice Token Similarity (40%)
  const dice = diceSimilarity(normA, normB);

  // Component 2: Levenshtein Edit Similarity (35%)
  const lev = levenshteinSimilarity(normA, normB);

  // Component 3: Soundex Phonetic Word Match (25%)
  const phonetic = soundexSimilarity(normA, normB);

  const rawScore = (0.40 * dice) + (0.35 * lev) + (0.25 * phonetic);
  return Math.round(rawScore * 100);
}

// 6. Generic DB Deduplication Query
// Accepts optional `keyFields` (array of column names from BulkItmConfig) for dynamic
// primary key resolution — no hardcoded property names.
async function findDuplicates(params) {
  const { tableName, fieldName, searchVal, excludeId, threshold = 50, keyFields } = params;
  if (!tableName || !fieldName || !searchVal || String(searchVal).trim().length < 3) {
    return [];
  }

  const db = await cds.connect.to('db');
  const entity = getEntityDef(tableName);
  let records = [];

  try {
    if (entity) {
      records = await db.run(SELECT.from(entity).limit(500));
    } else {
      records = await db.run(`SELECT * FROM "${tableName}" LIMIT 500`);
    }
  } catch (err) {
    console.warn(`[findDuplicates] Query on table ${tableName} failed:`, err.message);
    return [];
  }

  // ----------------------------------------------------------------
  // Resolve primary key column name(s) dynamically — no hardcoding
  // Priority: 1. CDS entity key elements  2. keyFields param  3. heuristic
  // ----------------------------------------------------------------
  let keyColNames = [];

  // 1. CDS entity keys
  if (entity && entity.elements) {
    keyColNames = Object.entries(entity.elements)
      .filter(([, def]) => def && def.key === true)
      .map(([name]) => name.toUpperCase());
  }

  // 2. Caller-supplied keyFields (from BulkItmConfig IsMatching='Y')
  if (!keyColNames.length && keyFields && keyFields.length) {
    keyColNames = keyFields.map(k => String(k).toUpperCase());
  }

  // 3. Heuristic: first property of the first record that looks like an ID
  if (!keyColNames.length && records.length > 0) {
    const firstRow = records[0];
    const heuristic = Object.keys(firstRow).find(k =>
      /^(ID|.*ID|.*NUM|.*CODE|.*KEY|.*NO)$/i.test(k)
    );
    if (heuristic) keyColNames = [heuristic.toUpperCase()];
  }

  const candidates = [];
  const searchClean = String(searchVal).trim();

  for (const row of records) {
    // Find target column value case-insensitively
    let targetVal = '';
    const fieldUpper = fieldName.toUpperCase();
    for (const [k, v] of Object.entries(row)) {
      if (k.toUpperCase() === fieldUpper) {
        targetVal = v;
        break;
      }
    }

    if (!targetVal) continue;

    // Dynamically resolve primary key value from the resolved key column names
    let rowId = '';
    for (const keyCol of keyColNames) {
      const found = Object.entries(row).find(([k]) => k.toUpperCase() === keyCol);
      if (found && found[1] != null && found[1] !== '') {
        rowId = String(found[1]);
        break;
      }
    }

    // Skip self if updating existing record
    if (excludeId && String(rowId).toUpperCase() === String(excludeId).toUpperCase()) {
      continue;
    }

    const score = calculateHybridScore(searchClean, String(targetVal));

    if (score >= threshold) {
      // Build extraInfo dynamically: take up to 2 non-key, non-target string columns
      const keyColSet = new Set(keyColNames);
      const extraValues = [];
      for (const [k, v] of Object.entries(row)) {
        const kUp = k.toUpperCase();
        if (keyColSet.has(kUp)) continue;
        if (kUp === fieldUpper) continue;
        if (v == null || v === '') continue;
        if (typeof v === 'string' && v.length > 0 && v.length <= 50) {
          extraValues.push(v);
          if (extraValues.length >= 2) break;
        }
      }

      candidates.push({
        id: rowId,
        name: String(targetVal),
        score: score,
        matchLevel: score >= 90 ? 'HIGH' : 'MEDIUM',
        extraInfo: extraValues.join(', ')
      });
    }
  }

  // Sort by highest score first and return top 5
  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

// 7. High-Performance In-Batch Inverted Token & Phonetic Index (Optimized for 10,000+ records)
class BatchFuzzyIndex {
  constructor() {
    this.items = [];
    this.tokenIndex = new Map();     // token -> Set of item indices
    this.soundexIndex = new Map();   // soundex code -> Set of item indices
    this.prefixIndex = new Map();    // 3-char prefix -> Set of item indices
  }

  // Extracts indexing keys from normalized text
  _extractKeys(norm) {
    if (!norm) return { tokens: [], soundexes: [], prefixes: [] };
    const words = norm.split(/\s+/).filter(w => w.length >= 2);
    const tokens = new Set();
    const soundexes = new Set();
    const prefixes = new Set();

    for (const w of words) {
      tokens.add(w);
      if (w.length >= 3) {
        prefixes.add(w.slice(0, 3));
      }
      soundexes.add(soundex(w));
    }

    if (norm.length >= 4) {
      prefixes.add(norm.slice(0, 4));
    }

    return {
      tokens: Array.from(tokens),
      soundexes: Array.from(soundexes),
      prefixes: Array.from(prefixes)
    };
  }

  // Adds an item into the index in O(1)
  add(item) {
    const idx = this.items.length;
    const norm = normalizeText(item.name || '');
    const entry = {
      index: idx,
      id: item.code || item.id || `Row${item.rownumber || idx + 1}`,
      code: item.code || item.id || '',
      name: item.name || '',
      normalized: norm,
      rownumber: item.rownumber || (idx + 1)
    };
    this.items.push(entry);

    if (norm.length < 2) return;

    const { tokens, soundexes, prefixes } = this._extractKeys(norm);

    for (const t of tokens) {
      if (!this.tokenIndex.has(t)) this.tokenIndex.set(t, new Set());
      this.tokenIndex.get(t).add(idx);
    }
    for (const sx of soundexes) {
      if (!this.soundexIndex.has(sx)) this.soundexIndex.set(sx, new Set());
      this.soundexIndex.get(sx).add(idx);
    }
    for (const p of prefixes) {
      if (!this.prefixIndex.has(p)) this.prefixIndex.set(p, new Set());
      this.prefixIndex.get(p).add(idx);
    }
  }

  // Searches for best duplicate candidate in O(K) where K << N
  findBestMatch(searchName, threshold = 50, excludeCode = null) {
    if (!searchName || this.items.length === 0) return null;
    const normSearch = normalizeText(searchName);
    if (normSearch.length < 2) return null;

    const { tokens, soundexes, prefixes } = this._extractKeys(normSearch);
    const candidateIndices = new Set();

    // Query inverted buckets
    for (const t of tokens) {
      const set = this.tokenIndex.get(t);
      if (set) {
        for (const idx of set) candidateIndices.add(idx);
      }
    }
    for (const sx of soundexes) {
      const set = this.soundexIndex.get(sx);
      if (set) {
        for (const idx of set) candidateIndices.add(idx);
      }
    }
    for (const p of prefixes) {
      const set = this.prefixIndex.get(p);
      if (set) {
        for (const idx of set) candidateIndices.add(idx);
      }
    }

    // Fallback for very small datasets (< 100 items) to guarantee 100% recall
    if (this.items.length <= 100 && candidateIndices.size === 0) {
      for (let i = 0; i < this.items.length; i++) candidateIndices.add(i);
    }

    let bestMatch = null;
    let highestScore = 0;

    for (const idx of candidateIndices) {
      const item = this.items[idx];
      if (excludeCode && String(item.code).toUpperCase() === String(excludeCode).toUpperCase()) {
        continue;
      }

      const score = calculateHybridScore(normSearch, item.normalized);
      if (score >= threshold && score > highestScore) {
        highestScore = score;
        bestMatch = {
          id: item.code,
          name: item.name,
          score: score,
          rownumber: item.rownumber,
          matchLevel: score >= 90 ? 'HIGH' : 'MEDIUM'
        };
      }
    }

    return bestMatch;
  }
}

/**
 * Unified, high-performance reusable fuzzy deduplication validator.
 * Takes a dataset array as input and provides duplicate validation array as output.
 * 
 * - When checking In-Batch (Excel): referenceItems is the batch array (or omitted).
 * - When checking Database: referenceItems is the array of DB records.
 *
 * @param {Object} params
 * @param {Array<{code?: string, id?: string, name: string, rownumber?: number}>} params.targetItems - Items to validate
 * @param {Array<{code?: string, id?: string, name: string, rownumber?: number}>} [params.referenceItems] - Reference items to compare against
 * @param {number} [params.threshold=50] - Similarity threshold (0-100)
 * @param {string} [params.scope='Database Match'] - 'In-Batch Fuzzy Match' | 'Database Match'
 * @param {string} [params.matchType='DB_FUZZY'] - 'BATCH_FUZZY' | 'DB_FUZZY'
 * @param {boolean} [params.isInBatch=false] - If true, evaluates sequentially within the batch
 * @returns {Array<Object>} Array of standardized duplicate results
 */
function validateFuzzyDuplicates({
  targetItems = [],
  referenceItems = null,
  threshold = 50,
  scope = 'Database Match',
  matchType = 'DB_FUZZY',
  isInBatch = false
}) {
  const duplicates = [];
  if (!targetItems || targetItems.length === 0) return duplicates;

  const isBatchMode = isInBatch || !referenceItems || referenceItems === targetItems;

  if (isBatchMode) {
    // In-Batch Mode: Compare each item with preceding items in the batch
    const batchIndex = new BatchFuzzyIndex();
    for (let i = 0; i < targetItems.length; i++) {
      const item = targetItems[i];
      const rowCode = item.code || item.id || `Row${item.rownumber || i + 1}`;
      const searchVal = item.name || '';
      const rowNum = item.rownumber || i + 1;

      if (searchVal && String(searchVal).trim().length >= 3) {
        const match = batchIndex.findBestMatch(String(searchVal).trim(), threshold, rowCode);
        if (match) {
          duplicates.push({
            code: rowCode,
            Code: rowCode,
            name: searchVal,
            Name: searchVal,
            matchedWith: `Row #${match.rownumber} - ${match.name}`,
            MatchedWith: `Row #${match.rownumber} - ${match.name}`,
            score: match.score,
            Score: match.score,
            matchType: 'BATCH_FUZZY',
            scope: 'In-Batch Fuzzy Match',
            Scope: 'In-Batch Fuzzy Match',
            rownumber: rowNum,
            Rownumber: rowNum,
            message: `Potential duplicate (${match.score}% match) with upload row #${match.rownumber} ${match.id} ("${match.name}")`,
            Message: `Potential duplicate (${match.score}% match) with upload row #${match.rownumber} ${match.id} ("${match.name}")`
          });
        }
      }

      if (searchVal) {
        batchIndex.add({
          code: rowCode,
          name: searchVal,
          rownumber: rowNum
        });
      }
    }
    return duplicates;
  }

  // Reference Dataset Mode: Compare targetItems against referenceItems (e.g. from Database)
  if (!referenceItems || referenceItems.length === 0) return duplicates;

  const refIndex = new BatchFuzzyIndex();
  for (let i = 0; i < referenceItems.length; i++) {
    const ref = referenceItems[i];
    if (ref && ref.name) {
      refIndex.add({
        code: ref.code || ref.id || `Ref${i + 1}`,
        name: ref.name,
        rownumber: ref.rownumber || i + 1
      });
    }
  }

  for (let i = 0; i < targetItems.length; i++) {
    const item = targetItems[i];
    const rowCode = item.code || item.id || `Row${item.rownumber || i + 1}`;
    const searchVal = item.name || '';
    const rowNum = item.rownumber || i + 1;

    if (!searchVal || String(searchVal).trim().length < 3) continue;

    const match = refIndex.findBestMatch(String(searchVal).trim(), threshold, rowCode);
    if (match) {
      duplicates.push({
        code: rowCode,
        Code: rowCode,
        name: searchVal,
        Name: searchVal,
        matchedWith: `[ID: ${match.id}] ${match.name}`,
        MatchedWith: `[ID: ${match.id}] ${match.name}`,
        score: match.score,
        Score: match.score,
        matchType: matchType,
        scope: scope,
        Scope: scope,
        rownumber: rowNum,
        Rownumber: rowNum,
        message: `Potential duplicate (${match.score}% match) with existing record ${match.id} ("${match.name}")`,
        Message: `Potential duplicate (${match.score}% match) with existing record ${match.id} ("${match.name}")`
      });
    }
  }

  return duplicates;
}

/**
 * Generic helper to fetch reference records from database table for fuzzy deduplication
 */
async function fetchDbReferenceRecords({ tableName, fieldName, keyFields = [], limit = 1000 }) {
  if (!tableName || !fieldName) return [];
  const db = await cds.connect.to('db');
  const entity = getEntityDef(tableName);
  let records = [];

  try {
    if (entity) {
      records = await db.run(SELECT.from(entity).limit(limit));
    } else {
      records = await db.run(`SELECT * FROM "${tableName}" LIMIT ${limit}`);
    }
  } catch (err) {
    console.warn(`[fetchDbReferenceRecords] Query on table ${tableName} failed:`, err.message);
    return [];
  }

  let keyColNames = [];
  if (entity && entity.elements) {
    keyColNames = Object.entries(entity.elements)
      .filter(([, def]) => def && def.key === true)
      .map(([name]) => name.toUpperCase());
  }
  if (!keyColNames.length && keyFields && keyFields.length) {
    keyColNames = keyFields.map(k => String(k).toUpperCase());
  }

  const results = [];
  const fieldUpper = fieldName.toUpperCase();

  for (const row of records) {
    let targetVal = '';
    for (const [k, v] of Object.entries(row)) {
      if (k.toUpperCase() === fieldUpper) {
        targetVal = v;
        break;
      }
    }
    if (!targetVal) continue;

    let rowId = '';
    for (const keyCol of keyColNames) {
      const found = Object.entries(row).find(([k]) => k.toUpperCase() === keyCol);
      if (found && found[1] != null && found[1] !== '') {
        rowId = String(found[1]);
        break;
      }
    }

    results.push({
      code: rowId,
      id: rowId,
      name: String(targetVal)
    });
  }

  return results;
}

module.exports = {
  normalizeText,
  levenshteinDistance,
  levenshteinSimilarity,
  diceSimilarity,
  soundex,
  calculateHybridScore,
  calculateHybridSimilarity: calculateHybridScore,
  findDuplicates,
  BatchFuzzyIndex,
  validateFuzzyDuplicates,
  fetchDbReferenceRecords
};


