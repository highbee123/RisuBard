'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inventory } = require('./v2-migration-gate.cjs');
const { readVerifiedJson, checksumFile, resolveInside } = require('./file-store.cjs');

// No mutable storage constructor is ever opened against the source.
function openSource(root, workspace) {
    const entries = new Map();
    const manifestPath = path.join(root, 'kv/manifest.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = readVerifiedJson(root, 'kv/manifest.json');
        if (manifest?.schemaVersion !== 1 || !manifest.entries || Array.isArray(manifest.entries)) throw new Error('Invalid source KV manifest');
        for (const [key, entry] of Object.entries(manifest.entries)) {
            if (!/^[a-f0-9]{64}$/.test(entry.object)) throw new Error('Invalid source object hash');
            entries.set(key, { sourcePath: resolveInside(root, `kv/objects/${entry.object}`), sourceRoot: root, checksum: entry.object });
        }
    }
    if (!fs.existsSync(path.join(root, 'migration/legacy-hex-save-folder.json'))) {
        for (const name of fs.readdirSync(root)) {
            if (!/^(?:[a-fA-F0-9]{2})+$/.test(name) || !fs.statSync(path.join(root, name)).isFile()) continue;
            const key = Buffer.from(name, 'hex').toString('utf8');
            if (!entries.has(key)) entries.set(key, { sourcePath: path.join(root, name), sourceRoot: root });
        }
    }
    let sqlite, scratchBytes = 0;
    if (!entries.has('database/database.bin') && fs.existsSync(path.join(root, 'risuai.db'))) {
        // SQLite can create/change WAL sidecars even for a read-only connection.
        // Isolate only the database and its sidecars, never the entire save tree.
        const sqliteRoot = path.join(workspace, 'sqlite');
        fs.mkdirSync(sqliteRoot);
        for (const suffix of ['', '-wal', '-shm']) {
            const file = path.join(root, `risuai.db${suffix}`);
            if (!fs.existsSync(file)) continue;
            const copy = path.join(sqliteRoot, `risuai.db${suffix}`);
            fs.copyFileSync(file, copy);
            if (checksumFile(file) !== checksumFile(copy)) throw new Error('SQLite snapshot verification failed');
            scratchBytes += fs.statSync(file).size;
        }
        const { DatabaseSync } = require('node:sqlite');
        sqlite = new DatabaseSync(path.join(sqliteRoot, 'risuai.db'), { readOnly: true });
        entries.clear();
        for (const { key } of sqlite.prepare('SELECT key FROM kv').all()) entries.set(key, null);
        if (!entries.has('database/database.bin')) { sqlite.close(); throw new Error('Legacy SQLite has no database/database.bin'); }
    }
    const verified = new Set();
    function source(key) {
        if (!entries.has(key)) return null;
        if (sqlite) {
            let bytes = Buffer.from(sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key).value);
            if (bytes.equals(Buffer.from('\0RISUCHUNKED\0', 'binary'))) {
                const chunks = sqlite.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(key);
                if (!chunks.length) throw new Error('Empty SQLite chunk manifest');
                bytes = Buffer.concat(chunks.map(({ hash }) => {
                    const row = sqlite.prepare('SELECT data FROM chunks WHERE hash = ?').get(hash);
                    if (!row) throw new Error('Missing SQLite chunk');
                    return Buffer.from(row.data);
                }));
            }
            return bytes;
        }
        const entry = entries.get(key);
        if (!verified.has(entry.sourcePath)) {
            if (entry.checksum && checksumFile(entry.sourcePath) !== entry.checksum) throw new Error('Source KV checksum mismatch');
            verified.add(entry.sourcePath);
        }
        return entry;
    }
    return { keys: [...entries.keys()], scratchBytes, source,
        read(key) { const value = source(key); return value?.sourcePath ? fs.readFileSync(value.sourcePath) : value; },
        close() { sqlite?.close(); } };
}

async function planMigration(root, workspace) {
    const before = inventory(root, true);
    if (fs.existsSync(path.join(root, '.journal')) && fs.readdirSync(path.join(root, '.journal')).some(name => name.endsWith('.json'))) {
        throw new Error('기존 버전에서 완료되지 않은 저장 작업을 복구한 뒤 이관하세요.');
    }
    const destination = `${workspace}-output`;
    process.env.RISUBARD_DATA_ROOT = path.join(workspace, 'runtime');
    const { createUserDataRepository } = require('./user-data-repository.cjs');
    const { createNamedUserDataRepository } = require('./named-user-data-repository.cjs');
    const { decodeImportDatabase, assignImportIds } = require('./canonical-import.cjs');
    const source = openSource(root, workspace);
    try {
        const legacy = createUserDataRepository({ dataRoot: root, readOnly: true });
        const raw = source.read('database/database.bin');
        const database = raw ? await decodeImportDatabase(raw, key => source.read(key)) : legacy.exportLegacyDatabase();
        assignImportIds(database);
        const plan = createNamedUserDataRepository({ dataRoot: destination, readOnly: true, legacyFactory: () => legacy,
            readAsset: source.source, assetSourceRoot: root }).importLegacyDatabase(database, {
            mode: 'sync', planOnly: true, migrationSourceRoot: root,
            allAssetKeys: source.keys.filter(key => key.startsWith('assets/')), strictAssets: true,
        });
        const operations = new Map();
        const excluded = new Set(['kv', '.journal', 'trash', 'migration-backups', 'characters', 'presets', 'prompts', 'modules', 'personas', 'lorebooks', 'index']);
        for (const [relative, size] of before) {
            if (typeof size !== 'number') continue;
            const top = relative.split(path.sep)[0];
            if (excluded.has(top) || /^risuai\.db(?:-wal|-shm)?$/.test(top) || /^(?:[a-fA-F0-9]{2})+$/.test(top)) continue;
            operations.set(path.normalize(relative), { path: relative, sourcePath: path.join(root, relative), sourceRoot: root });
        }
        // Preserve plugin KV, remote payloads, snapshots and other non-asset keys.
        // Asset keys (including unowned ones) are all covered by the V2 plan.
        const manifest = { schemaVersion: 1, updatedAt: Date.now(), entries: Object.create(null) };
        for (const key of source.keys) {
            if (key.startsWith('assets/') || ['database/database.bin', 'database/canonical-projection-revision'].includes(key)) continue;
            const value = source.source(key);
            const hash = value.sourcePath ? checksumFile(value.sourcePath) : crypto.createHash('sha256').update(value).digest('hex');
            const size = value.sourcePath ? fs.statSync(value.sourcePath).size : value.length;
            const relative = path.join('kv/objects', hash);
            operations.set(relative, { path: relative, ...(value.sourcePath ? value : { data: value }), checksumSidecar: false });
            manifest.entries[key] = { object: hash, size, updatedAt: Date.now() };
        }
        operations.set(path.normalize('kv/manifest.json'), { path: 'kv/manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
        for (const op of plan.operations) operations.set(path.normalize(op.path), op);
        // Do not copy an old checksum over regenerated metadata.
        for (const name of [...operations.keys()]) if (name.endsWith('.sha256') && operations.has(name.slice(0, -7))) operations.delete(name);
        const result = [...operations.values()];
        const stats = fs.statfsSync(workspace);
        const blockSize = Math.max(4096, Number(stats.bsize));
        let outputBytes = 0, allocatedBytes = 0;
        for (const op of result) {
            const bytes = op.sourcePath ? fs.statSync(op.sourcePath).size : op.data.length;
            outputBytes += bytes;
            allocatedBytes += Math.ceil(bytes / blockSize) * blockSize + blockSize * 2;
        }
        const reserveBytes = Math.max(64 * 1024 * 1024, Math.ceil(allocatedBytes * 0.05));
        return { destination, before, operations: result, database: plan.database, outputBytes,
            requiredBytes: allocatedBytes + reserveBytes + source.scratchBytes, remainingBytes: allocatedBytes + reserveBytes };
    } finally { source.close(); }
}

module.exports = { planMigration };
