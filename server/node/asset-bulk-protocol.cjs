'use strict';

function decodeAssetBulkWrite(value, options = {}) {
    const body = Buffer.from(value || []);
    const maxEntries = options.maxEntries ?? 200;
    if (body.length < 4) throw new Error('Truncated binary bulk-write body');
    let offset = 0;
    const count = body.readUInt32BE(offset); offset += 4;
    if (count > maxEntries) throw new Error('Binary bulk-write batch is too large');
    const entries = [];
    for (let index = 0; index < count; index++) {
        if (offset + 4 > body.length) throw new Error('Truncated binary bulk-write key length');
        const keyLength = body.readUInt32BE(offset); offset += 4;
        if (offset + keyLength + 4 > body.length) throw new Error('Truncated binary bulk-write key');
        const key = body.subarray(offset, offset + keyLength).toString('utf8'); offset += keyLength;
        const valueLength = body.readUInt32BE(offset); offset += 4;
        if (offset + valueLength > body.length) throw new Error('Truncated binary bulk-write value');
        entries.push({ key, value: body.subarray(offset, offset + valueLength) });
        offset += valueLength;
    }
    if (offset !== body.length) throw new Error('Unexpected trailing binary bulk-write data');
    return entries;
}

module.exports = { decodeAssetBulkWrite };
