// srv/lib/wf-id.js
'use strict';
const cds = require('@sap/cds');
const PREFIXES = { BULK: 'BLK', CENTRAL: 'CTR', ORG: 'ORG' };

const memoryCounters = {
    CENTRAL: 750030,
    BULK: 0,
    ORG: 0
};

async function generateWorkflowId(appname) {
    const key = (appname || 'CENTRAL').toUpperCase();
    const prefix = PREFIXES[key] !== undefined ? PREFIXES[key] : 'CTR';
    
    memoryCounters[key] = (memoryCounters[key] || (key === 'CENTRAL' ? 750030 : 0)) + 1;

    try {
        const db = await cds.connect.to('db');
        let WFSequence = null;
        if (cds.entities) {
            if (typeof cds.entities === 'function') {
                try {
                    const z = cds.entities('zmdr');
                    WFSequence = z?.WFSequence;
                } catch (_) {}
            }
            if (!WFSequence) {
                WFSequence = cds.entities.WFSequence || cds.entities['zmdr.WFSequence'];
            }
        }
        if (!WFSequence && db && db.entities) {
            WFSequence = db.entities.WFSequence || db.entities['zmdr.WFSequence'];
        }
        if (!WFSequence && cds.model && cds.model.definitions) {
            WFSequence = cds.model.definitions['zmdr.WFSequence'] || cds.model.definitions.WFSequence;
        }

        if (!WFSequence) {
            console.warn('[wf-id] WFSequence entity not found, using memory sequence counter');
            if (key === 'CENTRAL') return String(memoryCounters[key]);
            return `${prefix}${String(memoryCounters[key]).padStart(7, '0')}`;
        }

        let row = await db.run(
            SELECT.one.from(WFSequence).where({ AppName: key })
        ).catch(() => null);

        let nextNum = key === 'CENTRAL' ? 750030 : 1;
        if (!row) {
            nextNum = Math.max(key === 'CENTRAL' ? 750031 : 1, memoryCounters[key]);
            memoryCounters[key] = nextNum;
            await db.run(INSERT.into(WFSequence).entries({
                AppName: key,
                LastNum: nextNum,
                Prefix: prefix
            })).catch(err => console.warn('[wf-id] INSERT WFSequence warning:', err.message));
        } else {
            const currentNum = row.LastNum || row.LASTNUM || row.lastnum || (key === 'CENTRAL' ? 750030 : 0);
            nextNum = Math.max(currentNum, key === 'CENTRAL' ? 750030 : 0, memoryCounters[key] - 1) + 1;
            memoryCounters[key] = nextNum;
            await db.run(
                UPDATE(WFSequence)
                    .set({ LastNum: nextNum })
                    .where({ AppName: key })
            ).catch(err => console.warn('[wf-id] UPDATE WFSequence warning:', err.message));
        }

        if (key === 'CENTRAL') {
            return String(nextNum);
        }
        return `${prefix}${String(nextNum).padStart(7, '0')}`;
    } catch (err) {
        console.error('[wf-id] Error during sequence generation, using memory counter:', err.message);
        if (key === 'CENTRAL') return String(memoryCounters[key]);
        return `${prefix}${String(memoryCounters[key]).padStart(7, '0')}`;
    }
}

module.exports = { generateWorkflowId };