'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteJson, readVerifiedJson, recoverTransactions, commitTransaction, checksumFile } = require('./file-store.cjs');
const { ASSET_INDEX_PATH, readOwnedAssetIndex, readOwnedAssetIndexForLookup, readOwnedAsset, getOwnedAssetSource, ownedAssetOperationsForWrite, planOwnedAssets } = require('./owned-assets.cjs');

const MANIFEST_PATH = 'kv/manifest.json';
const HEX_MIGRATION_MARKER = 'migration/legacy-hex-save-folder.json';

function digest(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function digestAsync(data) {
    return Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', data)).toString('hex');
}

async function inspectFileAsync(filePath) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { hash: hash.digest('hex'), size };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function writeObject(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (digest(fs.readFileSync(temp)) !== hash) {
        fs.unlinkSync(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        fs.renameSync(temp, target);
    } catch (error) {
        if (fs.existsSync(target)) fs.unlinkSync(temp);
        else throw error;
    }
}

async function writeObjectAsync(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    try {
        await fsp.access(target);
        return;
    } catch {}
    await fsp.mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (await digestAsync(await fsp.readFile(temp)) !== hash) {
        await fsp.unlink(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        await fsp.rename(temp, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(temp);
        } catch {
            throw error;
        }
    }
}

async function writeObjectFromFileAsync(dataRoot, sourcePath) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    await fsp.mkdir(directory, { recursive: true });
    const handle = await fsp.open(sourcePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }

    const inspected = await inspectFileAsync(sourcePath);
    const target = path.join(directory, inspected.hash);
    try {
        await fsp.access(target);
        await fsp.unlink(sourcePath);
        return inspected;
    } catch {}

    try {
        await fsp.rename(sourcePath, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(sourcePath);
        } catch {
            throw error;
        }
    }
    return inspected;
}

function createFileKv(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    fs.mkdirSync(dataRoot, { recursive: true });
    recoverTransactions(dataRoot);

    let manifest = fs.existsSync(path.join(dataRoot, MANIFEST_PATH))
        ? readVerifiedJson(dataRoot, MANIFEST_PATH)
        : { schemaVersion: 1, updatedAt: 0, entries: {} };
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.entries !== 'object') {
        throw new Error('Unsupported or corrupt file KV manifest');
    }
    const objectWriteConcurrency = options.objectWriteConcurrency
        ?? Math.min(8, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));

    function saveManifest() {
        manifest.updatedAt = Date.now();
        atomicWriteJson(dataRoot, MANIFEST_PATH, manifest, {
            validate: value => value?.schemaVersion === 1 && typeof value?.entries === 'object',
        });
    }

    let ownedCache = null;
    let ownedStamp = null;
    let ownedCacheStrict = false;
    function currentOwnedStamp() {
        try {
            const stat = fs.statSync(path.join(dataRoot, ASSET_INDEX_PATH), { bigint: true });
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return '';
    }
    function ownedIndex() {
        const stamp = currentOwnedStamp();
        if (!ownedCache || stamp !== ownedStamp) {
            ownedCache = readOwnedAssetIndexForLookup(dataRoot);
            ownedStamp = stamp;
            ownedCacheStrict = false;
        }
        return ownedCache;
    }

    function strictOwnedIndex() {
        const stamp = currentOwnedStamp();
        if (ownedCache && ownedCacheStrict && stamp === ownedStamp) return ownedCache;
        const index = readOwnedAssetIndex(dataRoot);
        ownedCache = index;
        ownedStamp = currentOwnedStamp();
        ownedCacheStrict = true;
        return index;
    }

    function isFileAsset(key) {
        return key.startsWith('assets/') && (fs.existsSync(path.join(dataRoot, 'settings/layout.json'))
            || Object.hasOwn(ownedIndex().entries, key));
    }

    function publishEntries(entries, prepared) {
        const current = entries.some(entry => entry.key.startsWith('assets/')) ? strictOwnedIndex() : { schemaVersion: 2, entries: {} };
        const assets = [...new Map(entries.filter(entry => isFileAsset(entry.key)).map(entry => [entry.key,
            { ...entry, value: Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value) }])).values()];
        const nextManifest = { schemaVersion: 1, updatedAt: Date.now(), entries: { ...manifest.entries } };
        for (const [key, entry] of prepared) nextManifest.entries[key] = entry;
        if (!assets.length) {
            if (!entries.length) return;
            manifest = nextManifest;
            saveManifest();
            return;
        }
        const next = structuredClone(current);
        const operations = [];
        const newAssets = new Map(assets.filter(entry => !Object.hasOwn(current.entries, entry.key)).map(entry => [entry.key, entry.value]));
        if (newAssets.size) {
            const plan = planOwnedAssets({ dataRoot, previousIndex: current, allAssetKeys: [...newAssets.keys()],
                strict: true, readAsset: key => newAssets.get(key) });
            Object.assign(next.entries, plan.index.entries);
            operations.push(...plan.operations);
        }
        for (const { key, value } of assets) {
            delete nextManifest.entries[key];
            if (newAssets.has(key)) continue;
            const writes = ownedAssetOperationsForWrite(dataRoot, key, value, next);
            if (!writes.length) continue;
            operations.push(...writes);
            next.entries[key].checksum = digest(value);
        }
        operations.push({ path: ASSET_INDEX_PATH, data: Buffer.from(JSON.stringify(next)) },
            { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(nextManifest)) });
        commitTransaction(dataRoot, operations);
        manifest = nextManifest;
        ownedCache = next;
        ownedStamp = currentOwnedStamp();
        ownedCacheStrict = true;
    }

    function kvGetSourcePath(key) {
        const source = key.startsWith('assets/') && ownedIndex().entries[key] ? getOwnedAssetSource(dataRoot, key, ownedIndex()) : null;
        if (source) return source;
        const entry = manifest.entries[key];
        if (!entry) return null;
        if (!/^[a-f0-9]{64}$/.test(entry.object)) throw new Error('Invalid content object hash');
        const target = path.join(dataRoot, 'kv/objects', entry.object);
        if (checksumFile(target) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return target;
    }

    function kvGet(key) {
        const owned = key.startsWith('assets/') && ownedIndex().entries[key] ? readOwnedAsset(dataRoot, key, ownedIndex()) : null;
        if (owned !== null) return owned;
        const entry = manifest.entries[key];
        if (!entry) return null;
        const objectPath = path.join(dataRoot, 'kv', 'objects', entry.object);
        let value;
        try { value = fs.readFileSync(objectPath); } catch { return null; }
        if (digest(value) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return value;
    }

    function kvSet(key, value) {
        kvSetMany([{ key, value }]);
    }

    function prepareEntries(entries) {
        return entries.map(({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = await digestAsync(data);
            await writeObjectAsync(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareFileEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, sourcePath }) => {
            const prepared = await writeObjectFromFileAsync(dataRoot, sourcePath);
            return [key, { object: prepared.hash, size: prepared.size, updatedAt: Date.now() }];
        });
    }

    function kvSetMany(entries) {
        publishEntries(entries, prepareEntries(entries.filter(entry => !isFileAsset(entry.key))));
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries.filter(entry => !isFileAsset(entry.key)));
        publishEntries(entries, prepared);
    }

    function assertLegacyReplacement(entries, prefixes = null) {
        if (!fs.existsSync(path.join(dataRoot, 'settings/layout.json'))) return;
        if (entries.some(entry => entry.key.startsWith('assets/'))
            || Object.keys(strictOwnedIndex().entries).some(key => !prefixes || prefixes.some(prefix => key.startsWith(prefix)))) {
            throw new Error('Use canonical snapshot import to replace V2 assets');
        }
    }

    function kvReplacePrefixes(entries, prefixes) {
        assertLegacyReplacement(entries, prefixes);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepareEntries(entries)) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    function kvReplaceAll(entries) {
        assertLegacyReplacement(entries);
        manifest.entries = Object.fromEntries(prepareEntries(entries));
        saveManifest();
    }

    async function kvReplacePrefixesAsync(entries, prefixes) {
        assertLegacyReplacement(entries, prefixes);
        const prepared = await prepareEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    async function kvReplacePrefixesFromFilesAsync(entries, prefixes) {
        assertLegacyReplacement(entries, prefixes);
        const prepared = await prepareFileEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    async function kvReplaceAllAsync(entries) {
        assertLegacyReplacement(entries);
        const prepared = await prepareEntriesAsync(entries);
        manifest.entries = Object.fromEntries(prepared);
        saveManifest();
    }

    function kvDel(key) {
        kvDelMany([key]);
    }

    // Detach only the duplicate active KV references. Old bytes remain pinned
    // by a recovery manifest; this operation never deletes object files.
    function kvDetachOwnedAssets(options = {}) {
        const index = strictOwnedIndex();
        const consumed = new Set(options.consumedAssetKeys || []);
        if ([...consumed].some(key => typeof key !== 'string' || !key.startsWith('assets/'))) throw new Error('Invalid consumed asset key');
        const keys = Object.keys(manifest.entries).filter(key => Object.hasOwn(index.entries, key) || consumed.has(key));
        const validationKeys = keys.some(key => consumed.has(key) && !Object.hasOwn(index.entries, key))
            ? Object.keys(index.entries) : keys;
        if (keys.length && !validationKeys.length) throw new Error('No canonical owner assets for consumed keys');
        for (const key of validationKeys) getOwnedAssetSource(dataRoot, key, index);
        const bytes = [...new Map(keys.map(key => [manifest.entries[key].object, manifest.entries[key].size])).values()]
            .reduce((total, size) => total + size, 0);
        const result = { detached: keys.length, bytes, objectsDeleted: 0, recoveryPreserved: true };
        if (options.dryRun || !keys.length) return result;
        const next = { schemaVersion: 1, updatedAt: Date.now(), entries: { ...manifest.entries } };
        for (const key of keys) delete next.entries[key];
        commitTransaction(dataRoot, [
            { path: `trash/import-detach-${crypto.randomUUID()}/kv-manifest.json`, data: Buffer.from(JSON.stringify(manifest)) },
            { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(next)) },
        ]);
        manifest = next;
        return result;
    }

    async function kvPublishImportAsync(entries, options) {
        const fileAssets = new Set(options.ownedAssetKeys || []);
        const archivedAssets = options.archivedAssetKeys || {};
        const portable = value => value.split(path.sep).join('/');
        const published = new Map(options.operations.filter(operation => !operation.archiveTo).map(operation => [portable(operation.path), operation]));
        for (const [key, relative] of Object.entries(archivedAssets)) {
            const prefix = `trash/${options.importId}/incoming-assets/`;
            const operation = published.get(relative);
            if (!key.startsWith('assets/') || typeof relative !== 'string' || !relative.startsWith(prefix)
                || !/^[a-f0-9]{64}$/.test(relative.slice(prefix.length)) || !operation) {
                throw new Error('Missing canonical asset recovery publication for import');
            }
            const incoming = entries.find(entry => entry.key === key);
            if (!incoming) throw new Error('Missing incoming asset for recovery publication');
            const inputHash = incoming.sourcePath ? checksumFile(incoming.sourcePath) : digest(incoming.value);
            const archivedHash = operation.sourcePath ? checksumFile(operation.sourcePath) : digest(operation.data);
            if (inputHash !== archivedHash) throw new Error('Canonical asset recovery checksum mismatch');
        }
        if (fileAssets.size) {
            const mapping = options.operations.find(operation => portable(operation.path) === ASSET_INDEX_PATH);
            if (!mapping) throw new Error('Missing canonical asset mapping for import');
            const index = JSON.parse(mapping.sourcePath ? fs.readFileSync(mapping.sourcePath, 'utf8') : Buffer.from(mapping.data).toString('utf8'));
            for (const key of fileAssets) {
                const paths = index.entries?.[key]?.paths;
                if (!key.startsWith('assets/') || index.schemaVersion !== 2 || !Array.isArray(paths) || !paths.length
                    || paths.some(relative => !published.has(relative))) {
                    throw new Error('Missing canonical asset file publication for import');
                }
            }
        }
        const prepared = await mapWithConcurrency(entries.filter(entry => !fileAssets.has(entry.key) && !Object.hasOwn(archivedAssets, entry.key)), objectWriteConcurrency, async entry => {
            const result = entry.sourcePath
                ? await prepareFileEntriesAsync([entry]) : await prepareEntriesAsync([entry]);
            return result[0];
        });
        const next = options.prefixes ? { ...manifest.entries } : {};
        for (const key of Object.keys(next)) {
            if (options.prefixes.some(prefix => key.startsWith(prefix))) delete next[key];
        }
        for (const key of fileAssets) delete next[key];
        for (const key of Object.keys(archivedAssets)) delete next[key];
        for (const [key, entry] of prepared) next[key] = entry;
        const updated = { schemaVersion: 1, updatedAt: Date.now(), entries: next };
        // Pin the old manifest before publishing anything. GC honours these
        // recovery manifests, so rollback assets survive subsequent saves.
        commitTransaction(dataRoot, [
            { path: `trash/${options.importId}/kv-manifest.json`, data: Buffer.from(JSON.stringify(manifest)) },
            ...options.operations,
            { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(updated)) },
        ], options.transactionOptions);
        manifest = updated;
        ownedCache = null;
    }

    function kvDelMany(keys) {
        let count = 0;
        let bytes = 0;
        const currentOwned = [...keys].some(key => key.startsWith('assets/')) ? strictOwnedIndex() : { schemaVersion: 2, entries: {} };
        let nextOwned;
        const nextEntries = { ...manifest.entries };
        const operations = [];
        const archive = `trash/asset-delete-${crypto.randomUUID()}`;
        for (const key of new Set(keys)) {
            const entry = manifest.entries[key];
            const owned = currentOwned.entries[key];
            if (!entry && !owned) continue;
            bytes += kvSize(key);
            delete nextEntries[key];
            if (owned) {
                nextOwned ||= structuredClone(currentOwned);
                delete nextOwned.entries[key];
                for (const relative of owned.paths) {
                    for (const suffix of ['', '.sha256', '.bak', '.bak.sha256']) {
                        if (!fs.existsSync(path.join(dataRoot, relative + suffix))) continue;
                        operations.push({ path: relative + suffix, archiveTo: `${archive}/${relative}${suffix}` });
                    }
                }
            }
            count += 1;
        }
        if (count > 0) {
            const nextManifest = { schemaVersion: 1, updatedAt: Date.now(), entries: nextEntries };
            if (nextOwned) {
                operations.push({ path: `${archive}/asset-files.json`, data: Buffer.from(JSON.stringify(currentOwned)) },
                    { path: ASSET_INDEX_PATH, data: Buffer.from(JSON.stringify(nextOwned)) },
                    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(nextManifest)) });
                commitTransaction(dataRoot, operations);
                ownedCache = null;
                manifest = nextManifest;
            } else {
                manifest = nextManifest;
                saveManifest();
            }
        }
        return { count, bytes };
    }

    function kvSize(key) {
        const source = key.startsWith('assets/') && ownedIndex().entries[key] ? getOwnedAssetSource(dataRoot, key, ownedIndex()) : null;
        if (source) return fs.statSync(source).size;
        return manifest.entries[key]?.size ?? 0;
    }

    function kvGetUpdatedAt(key) {
        const source = key.startsWith('assets/') && ownedIndex().entries[key] ? getOwnedAssetSource(dataRoot, key, ownedIndex()) : null;
        if (source) {
            const stat = fs.statSync(source, { bigint: true });
            return `${stat.mtimeNs}-${stat.size}`;
        }
        return manifest.entries[key]?.updatedAt ?? null;
    }

    function kvCopyValue(source, destination) {
        if (source.startsWith('assets/') || destination.startsWith('assets/')) {
            const value = kvGet(source);
            if (value !== null) kvSet(destination, value);
            return;
        }
        const entry = manifest.entries[source];
        if (!entry) return;
        manifest.entries[destination] = { ...entry, updatedAt: Date.now() };
        saveManifest();
    }

    function kvDelPrefix(prefix) {
        kvDelMany(kvList(prefix));
    }

    function kvList(prefix = '') {
        const assets = 'assets/'.startsWith(prefix) || prefix.startsWith('assets/') ? Object.keys(ownedIndex().entries) : [];
        return [...new Set([...Object.keys(manifest.entries), ...assets])].filter(key => key.startsWith(prefix)).sort();
    }

    function kvListWithSizes(prefix = '') {
        return kvList(prefix).map(key => ({ key, size: kvSize(key) }));
    }

    function archivedObjects() {
        const objects = new Set();
        const trash = path.join(dataRoot, 'trash');
        if (fs.existsSync(trash)) {
            for (const entry of fs.readdirSync(trash, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.startsWith('import-')) continue;
                const relative = path.join('trash', entry.name, 'kv-manifest.json');
                if (!fs.existsSync(path.join(dataRoot, relative))) continue;
                const previous = readVerifiedJson(dataRoot, relative);
                for (const value of Object.values(previous.entries)) objects.add(value.object);
            }
        }
        return objects;
    }

    function referencedObjects() {
        return new Set([...Object.values(manifest.entries).map(entry => entry.object), ...archivedObjects()]);
    }

    function kvListRecoveryObjects() {
        return [...archivedObjects()].map(object => {
            if (!/^[a-f0-9]{64}$/.test(object)) throw new Error('Invalid recovery object hash');
            const sourcePath = path.join(dataRoot, 'kv/objects', object);
            return { object, sourcePath, size: fs.statSync(sourcePath).size };
        });
    }

    function reclaimableObjects() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return [];
        const referenced = referencedObjects();
        return fs.readdirSync(directory)
            .filter(name => /^[a-f0-9]{64}$/.test(name) && !referenced.has(name));
    }

    function reclaimableChunkBytes() {
        return reclaimableObjects().reduce((total, name) => {
            try { return total + fs.statSync(path.join(dataRoot, 'kv', 'objects', name)).size; }
            catch { return total; }
        }, 0);
    }

    function objectStoreBytes() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return 0;
        return fs.readdirSync(directory).reduce((total, name) => {
            if (!/^[a-f0-9]{64}$/.test(name)) return total;
            try { return total + fs.statSync(path.join(directory, name)).size; }
            catch { return total; }
        }, 0);
    }

    function gcChunks(options = {}) {
        const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 0;
        const maxDeletes = Number.isFinite(options.maxDeletes)
            ? Math.max(0, Math.floor(options.maxDeletes))
            : Number.POSITIVE_INFINITY;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const objects = reclaimableObjects();
        let count = 0;
        let bytes = 0;
        for (const name of objects) {
            if (count >= maxDeletes) break;
            const objectPath = path.join(dataRoot, 'kv', 'objects', name);
            try {
                const stat = fs.statSync(objectPath);
                if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue;
                fs.unlinkSync(objectPath);
                count += 1;
                bytes += stat.size;
            } catch {}
        }
        return { count, bytes };
    }

    function snapshotFootprint(key) {
        const entry = manifest.entries[key];
        if (!entry) return 0;
        const live = manifest.entries['database/database.bin'];
        return live && live.object === entry.object ? 0 : entry.size;
    }

    function migrateLegacyHexFiles() {
        if (fs.existsSync(path.join(dataRoot, HEX_MIGRATION_MARKER))) return;
        const files = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^[a-fA-F0-9]+$/.test(entry.name) && entry.name.length % 2 === 0);
        let imported = 0;
        for (const entry of files) {
            const key = Buffer.from(entry.name, 'hex').toString('utf8');
            if (!key || key in manifest.entries) continue;
            const data = fs.readFileSync(path.join(dataRoot, entry.name));
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            manifest.entries[key] = { object: hash, size: data.length, updatedAt: fs.statSync(path.join(dataRoot, entry.name)).mtimeMs };
            imported += 1;
        }
        if (imported) saveManifest();
        atomicWriteJson(dataRoot, HEX_MIGRATION_MARKER, { schemaVersion: 1, imported, completedAt: Date.now() });
    }

    migrateLegacyHexFiles();

    return {
        kvGet,
        kvGetSourcePath,
        kvSet,
        kvSetMany,
        kvSetManyAsync,
        kvReplacePrefixes,
        kvReplacePrefixesAsync,
        kvReplacePrefixesFromFilesAsync,
        kvReplaceAll,
        kvReplaceAllAsync,
        kvPublishImportAsync,
        kvDetachOwnedAssets,
        kvListRecoveryObjects,
        kvDel,
        kvDelMany,
        kvSize,
        kvGetUpdatedAt,
        kvCopyValue,
        kvDelPrefix,
        kvList,
        kvListWithSizes,
        gcChunks,
        reclaimableChunkBytes,
        objectStoreBytes,
        snapshotFootprint,
    };
}

module.exports = { createFileKv };
