'use strict';

// Compatibility facade for the legacy server routes. Canonical bytes live in
// the file-native KV manifest/object store; no database is opened at runtime.
const { createFileKv } = require('./file-kv.cjs');
const { resolveDataRoot } = require('./data-root.cjs');
const { createUserDataRepository } = require('./user-data-repository.cjs');
const { encodeRisuSaveLegacy } = require('./utils.cjs');
const { migrateLegacySqlite } = require('./legacy-sqlite-import.cjs');
const fs = require('fs');
const path = require('path');

const dataRoot = resolveDataRoot();
const store = createFileKv({ dataRoot });
if (!fs.existsSync(path.join(dataRoot, 'index/sidebar.json')) &&
    fs.existsSync(path.join(dataRoot, 'risuai.db')) && !store.kvSize('database/database.bin')) {
    migrateLegacySqlite({ dataRoot, store, sqlitePath: path.join(dataRoot, 'risuai.db') });
}
const repository = createUserDataRepository({ dataRoot, formatVersion: 2 });
const originalGet = store.kvGet;

// database.bin is a compatibility cache only. If it is lost, reconstruct it
// from canonical entity files; normal startup still reads the small KV manifest
// and the cache, not every character/chat body.
store.kvGet = key => {
    // Native runtime never consumes or persists the compatibility blob. Old
    // endpoints explicitly asking for it receive a fresh export of disk files.
    if (key === 'database/database.bin' && fs.existsSync(path.join(dataRoot, 'settings/native-runtime.json'))) {
        return Buffer.from(encodeRisuSaveLegacy(repository.exportLegacyDatabase({ acceptExternalChanges: true })));
    }
    const value = originalGet(key);
    if (value || key !== 'database/database.bin') return value;
    if (!fs.existsSync(path.join(dataRoot, 'index', 'sidebar.json'))) return null;
    const rebuilt = Buffer.from(encodeRisuSaveLegacy(repository.exportLegacyDatabase()));
    store.kvSet(key, rebuilt);
    return rebuilt;
};

module.exports = { ...store, repository };
