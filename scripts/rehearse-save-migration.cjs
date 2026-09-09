'use strict';

// Offline rehearsal only. Never starts a server or changes the source root.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const args = process.argv.slice(2);
let reuseSnapshot = false;
const positional = [], excludedModuleIds = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reuse-snapshot') reuseSnapshot = true;
    else if (args[i] === '--exclude-module-id') {
        const id = args[++i];
        if (!id || id.startsWith('--')) throw new Error('Missing confirmed module deletion ID');
        excludedModuleIds.push(id);
    } else if (args[i].startsWith('--')) throw new Error('Unknown rehearsal option');
    else positional.push(args[i]);
}
const [sourceArg, outputArg] = positional;
if (!sourceArg || !outputArg || positional.length !== 2) {
    throw new Error('Usage: node scripts/rehearse-save-migration.cjs [--reuse-snapshot] [--exclude-module-id ID] SOURCE NEW_OUTPUT_DIRECTORY');
}
const source = fs.realpathSync(sourceArg);
const requestedOutput = path.resolve(outputArg);
const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
const inside = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
if (inside(source, output) || inside(output, source)) throw new Error('Source and output must be separate trees');
fs.mkdirSync(output); // Must not already exist; never overwrite a previous rehearsal.
process.env.RISUBARD_DATA_ROOT = path.join(output, 'tool-runtime');
const { createFileKv } = require('../server/node/file-kv.cjs');
const { createUserDataRepository } = require('../server/node/user-data-repository.cjs');
const { decodeImportDatabase, assignImportIds, applyConfirmedModuleDeletions, ENTITY_ROOTS } = require('../server/node/canonical-import.cjs');
const { encodeRisuSaveLegacy } = require('../server/node/utils.cjs');
// --reuse-snapshot identifies an existing isolated rehearsal copy, never the
// active save. Its immutable KV objects may be linked into the new test tree.
const snapshot = reuseSnapshot ? source : path.join(output, 'snapshot');
const converted = path.join(output, 'converted');
if (!reuseSnapshot) fs.mkdirSync(snapshot);
fs.mkdirSync(converted);
const hashes = new Map();
const directoryEntries = new Map();
let copiedBytes = 0;
const auxiliary = ['inlays', 'risubard', 'model-jobs'];
function hash(file) {
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
        let length;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
    } finally { fs.closeSync(fd); }
    return digest.digest('hex');
}
function copy(relative) {
    const original = path.join(source, relative);
    const stat = fs.lstatSync(original);
    if (stat.isSymbolicLink()) throw new Error('Source contains a symbolic link; manual review required');
    if (stat.isDirectory()) {
        const names = fs.readdirSync(original).sort();
        directoryEntries.set(relative, names);
        if (!reuseSnapshot) fs.mkdirSync(path.join(snapshot, relative), { recursive: true });
        for (const name of names) copy(path.join(relative, name));
    } else if (stat.isFile()) {
        const destination = path.join(snapshot, relative);
        const before = hash(original);
        if (!reuseSnapshot) {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL);
            if (hash(destination) !== before) throw new Error('Source changed during snapshot copy');
            copiedBytes += stat.size;
        }
        hashes.set(relative, before);
        if (hashes.size % 10000 === 0) console.log(JSON.stringify({ phase: 'copy', files: hashes.size, MiB: Math.round(copiedBytes / 1048576) }));
    }
}
function verifySource() {
    for (const [relative, names] of directoryEntries) {
        if (!isDeepStrictEqual(fs.readdirSync(path.join(source, relative)).sort(), names)) {
            throw new Error('Source directory membership changed during rehearsal');
        }
    }
    for (const [relative, expected] of hashes) {
        if (hash(path.join(source, relative)) !== expected) throw new Error('Source changed during rehearsal; discard the test result and retry while idle');
    }
}

async function main() {
    directoryEntries.set('', fs.readdirSync(source).sort());
    for (const name of [...ENTITY_ROOTS, ...auxiliary]) if (fs.existsSync(path.join(source, name))) copy(name);
    const manifestPath = path.join(source, 'kv/manifest.json');
    if (fs.existsSync(manifestPath)) {
        copy('kv/manifest.json');
        if (fs.existsSync(`${manifestPath}.sha256`)) copy('kv/manifest.json.sha256');
        const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'kv/manifest.json'), 'utf8'));
        for (const object of new Set(Object.values(manifest.entries).map(entry => entry.object))) {
            if (!/^[a-f0-9]{64}$/.test(object)) throw new Error('Invalid KV object path');
            copy(path.join('kv/objects', object));
            if (hashes.get(path.join('kv/objects', object)) !== object) throw new Error('Source KV object checksum mismatch');
        }
    } else {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (entry.isFile() && /^[a-fA-F0-9]+$/.test(entry.name) && entry.name.length % 2 === 0) copy(entry.name);
        }
    }
    console.log(JSON.stringify({ phase: 'verify-source', files: hashes.size, MiB: Math.round(copiedBytes / 1048576) }));
    verifySource();
    // Seed the mutable test root before conversion so the repository can resolve
    // assets and carry drafts from the old ID tree into its named folders.
    for (const relative of directoryEntries.keys()) fs.mkdirSync(path.join(converted, relative), { recursive: true });
    for (const relative of hashes.keys()) {
        const original = path.join(snapshot, relative);
        const destination = path.join(converted, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (/^kv[/\\]objects[/\\][a-f0-9]{64}$/.test(relative)) {
            try { fs.linkSync(original, destination); }
            catch (error) {
                if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
                fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL);
                copiedBytes += fs.statSync(original).size;
            }
        } else {
            fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL);
            copiedBytes += fs.statSync(original).size;
        }
    }
    // This constructor may replay journals or write a legacy migration marker;
    // invoke it only on converted, never on either form of source snapshot.
    const store = createFileKv({ dataRoot: converted });
    const sourceKeys = store.kvList();
    const raw = store.kvGet('database/database.bin');
    if (!raw) throw new Error('No compatibility database found; canonical-only source needs separate review');
    const database = await decodeImportDatabase(raw, key => store.kvGet(key));
    const confirmedModuleDeletions = applyConfirmedModuleDeletions(database, excludedModuleIds);
    assignImportIds(database);
    console.log(JSON.stringify({ phase: 'convert', confirmedModuleDeletions: confirmedModuleDeletions.map(item => item.id) }));
    const repository = createUserDataRepository({ dataRoot: converted, formatVersion: 2 });
    const { normalizeOwnerAssetReferences, previousDatabaseOwners } = require('../server/node/owner-asset-references.cjs');
    const expected = normalizeOwnerAssetReferences(database, {
        previousIndex: require('../server/node/owned-assets.cjs').readOwnedAssetIndex(converted),
        previousOwners: previousDatabaseOwners(repository.loadSidebarIndex()), allAssetKeys: sourceKeys.filter(key => key.startsWith('assets/')),
    }).database;
    const imported = repository.importLegacyDatabase(database, {
        mode: 'sync', strictAssets: true, allAssetKeys: sourceKeys.filter(key => key.startsWith('assets/')),
    });
    const full = repository.exportLegacyDatabase();
    if (!isDeepStrictEqual(expected, full)) throw new Error('Import conversion did not preserve all database fields');
    // The repository has archived the previous ID tree and preserved its extra
    // files. Never copy the old tree back over the new canonical layout.
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(full)));
    store.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision()));
    const reopened = createUserDataRepository({ dataRoot: converted, formatVersion: 2 }).exportLegacyDatabase();
    if (!isDeepStrictEqual(full, reopened)) throw new Error('Converted save differs after reopening');
    // Validate the entire active object manifest, including assets and snapshots.
    for (const key of sourceKeys) {
        if (!store.kvGet(key)) throw new Error('Snapshot is missing a referenced object');
    }
    const detachedAssets = store.kvDetachOwnedAssets({ consumedAssetKeys: imported.consumedAssetKeys || [] });
    verifySource();
    const report = {
        source, snapshot, converted, reusedSnapshot: reuseSnapshot, sourceUnchanged: true, filesVerified: hashes.size,
        bytesCopied: copiedBytes, format: 'RisuBard named folders (schemaVersion 2)', formatVersion: 2,
        characters: full.characters.length,
        chats: full.characters.reduce((n, c) => n + c.chats.length, 0),
        messages: full.characters.reduce((n, c) => n + c.chats.reduce((m, chat) => m + chat.message.length, 0), 0),
        modules: full.modules.length, presets: full.botPresets.length,
        confirmedModuleDeletions, detachedAssets,
        wholeDatabaseRoundTrip: true, restartedRepository: true,
        originalNotActivatedOrModified: true,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
main().catch(error => {
    // No story text, credentials or database values in the report.
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ source, status: 'failed', reason: error.message }, null, 2));
    console.error(error.message);
    process.exitCode = 1;
});
