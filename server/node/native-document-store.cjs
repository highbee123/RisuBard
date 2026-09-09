'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checksum, checksumFile, commitTransaction, recoverTransactions, resolveInside } = require('./file-store.cjs');
const { encodeEntity, decodeEntity } = require('./named-entity-codec.cjs');
const { splitSecrets, deepMerge } = require('./user-data-repository.cjs');
const { collectReferences, getOwnedAssetSource } = require('./owned-assets.cjs');
const { rewriteReferences } = require('./owner-asset-references.cjs');
const ORDER = 'settings/entity-order.json';
const ASSETS = 'settings/asset-files.json';
const GROUPS = { prompt: ['botPresets', 'prompts'], module: ['modules', 'modules'], persona: ['personas', 'personas'], lorebook: ['loreBook', 'lorebooks'] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const normalized = value => value.replace(/\\/g, '/');
const keyOf = target => JSON.stringify([target.kind, target.parentId || '', target.id]);
function fail(message, statusCode = 400) {
    throw Object.assign(new Error(message), { statusCode, code: statusCode === 409 ? 'STORAGE_CONFLICT' : statusCode === 404 ? 'NATIVE_DOCUMENT_NOT_FOUND' : 'INVALID_NATIVE_DOCUMENT' });
}
function id(value) {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f]/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('Invalid native document ID');
    return value;
}
function targetOf(target) {
    if (!object(target) || !['settings', 'character', 'chat', ...Object.keys(GROUPS)].includes(target.kind)) fail('Invalid native document target');
    const result = { kind: target.kind, id: id(target.id) };
    if (target.kind === 'chat') result.parentId = id(target.parentId);
    else if (target.parentId !== undefined) fail('Unexpected parent ID');
    if (target.kind === 'settings' && target.id !== 'global') fail('Settings ID must be global');
    return result;
}
function label(value, kind) { return value.name || value.title || (kind === 'chat' ? 'Chat' : 'Untitled'); }
function folderName(value) {
    let result = [...String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '')].slice(0, 40).join('').replace(/[. ]+$/g, '') || 'Untitled';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(result)) result = `_${result}`;
    return result;
}

function createNativeDocumentStore({ dataRoot }) {
    const root = path.resolve(dataRoot);
    // Recovery is the only constructor mutation. No legacy import/export or
    // projection is opened on the ordinary document path.
    recoverTransactions(root);
    function safe(relative) {
        const value = normalized(relative);
        if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]|[. ]$/.test(part))) fail('Unsafe native document path');
        let current = root;
        for (const part of [null, ...value.split('/')]) {
            if (part !== null) current = path.join(current, part);
            try { if (fs.lstatSync(current).isSymbolicLink()) fail('Native document path contains a symbolic link'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return resolveInside(root, value);
    }
    function bytes(relative) { return fs.readFileSync(safe(relative)); }
    function validateCatalog(value) {
        if (!object(value) || value.schemaVersion !== 2 || !Array.isArray(value.characters) || !object(value.collections) || !object(value.paths)) fail('Invalid native catalog');
        const targets = new Map(), locations = new Set();
        function register(target, folder, parent, summary) {
            target = targetOf(target);
            if (typeof folder !== 'string') fail('Invalid catalog path');
            folder = normalized(folder);
            if (!folder.startsWith(parent + '/') || folder.slice(parent.length + 1).includes('/') || /[:\x00-\x1f]/.test(folder) || folder.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('Invalid catalog path');
            if (locations.has(folder.toLowerCase()) || targets.has(keyOf(target))) fail('Duplicate native catalog ID or path');
            locations.add(folder.toLowerCase()); targets.set(keyOf(target), { target, folder, summary });
        }
        for (const character of value.characters) {
            if (!object(character) || !Array.isArray(character.chats)) fail('Invalid character catalog');
            register({ kind: 'character', id: character.id }, character.path, 'characters', character);
            for (const chat of character.chats) register({ kind: 'chat', id: chat.id, parentId: character.id }, chat.path, normalized(character.path) + '/chats', chat);
        }
        for (const [kind, [field, directory]] of Object.entries(GROUPS)) {
            if (!Array.isArray(value.collections[field]) || !object(value.paths[field])) fail('Invalid collection catalog');
            for (const entityId of value.collections[field]) register({ kind, id: entityId }, value.paths[field][entityId], directory, { name: value.names?.[field]?.[entityId] });
        }
        return targets;
    }
    function catalogState() {
        const data = bytes(ORDER), value = JSON.parse(data.toString('utf8'));
        return { value, revision: checksum(data), targets: validateCatalog(value) };
    }
    function catalog() { const { value, revision } = catalogState(); return { value, revision }; }
    function validateValue(target, value, metadataOnly = false) {
        if (!object(value)) fail('Native document must be a JSON object');
        if (target.kind === 'settings') {
            if (Object.hasOwn(value, 'schemaVersion')) fail('Settings schemaVersion is managed by storage');
            if (['characters', ...Object.values(GROUPS).map(([field]) => field)].some(field => Object.hasOwn(value, field))) fail('Settings cannot contain entity collections');
        } else {
            if (value[target.kind === 'character' ? 'chaId' : 'id'] !== target.id) fail('Native document ID does not match target ID');
            if (target.kind === 'character' && Object.hasOwn(value, 'chats')) fail('Character document cannot contain chats');
            if (target.kind === 'chat' && !metadataOnly && (!Array.isArray(value.message) || value.message.some(message => !object(message)))) fail('Chat messages must be JSON objects');
        }
    }
    function readState(target, state, options = {}) {
        const files = new Map();
        const readBytes = relative => { const data = bytes(relative); files.set(normalized(relative), data); return data; };
        const readJson = (_, relative) => JSON.parse(readBytes(relative).toString('utf8'));
        let value;
        if (target.kind === 'settings') {
            const settings = readJson(root, 'settings/app.json'), secrets = readJson(root, 'secrets/credentials.json');
            if (!object(settings) || !object(secrets) || settings.schemaVersion !== 1 || secrets.schemaVersion !== 1) fail('Invalid settings document');
            const { schemaVersion: _s, ...plain } = settings, { schemaVersion: _k, ...credentials } = secrets;
            value = deepMerge(plain, credentials);
        } else {
            const entry = state.targets.get(keyOf(target));
            if (!entry) fail('Native document is absent from catalog', 404);
            value = decodeEntity(root, target.kind, entry.folder, { readJson, readText: (_, relative) => readBytes(relative).toString('utf8') });
            if (target.kind === 'chat' && !options.metadataOnly) value.message = readBytes(entry.folder + '/messages.jsonl').toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        }
        validateValue(target, value, options.metadataOnly);
        const digest = crypto.createHash('sha256');
        for (const [relative, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) digest.update(JSON.stringify([relative, data.length])).update(data);
        return { target, value, revision: digest.digest('hex'), ...(target.kind === 'chat' && options.metadataOnly ? { metadataOnly: true } : {}), files };
    }
    function envelope(state) { const { files, ...result } = state; return result; }
    function read(target, options = {}) { target = targetOf(target); return envelope(readState(target, target.kind === 'settings' ? null : catalogState(), options)); }

    function commit(request, options = {}) {
        if (!object(request) || !Array.isArray(request.writes)) fail('Native commit requires writes');
        const state = catalogState(), next = structuredClone(state.value), writes = [], unique = new Set(), operations = new Map(), archive = [], moves = [];
        let catalogChanged = false;
        function put(operation) { operations.set(normalized(operation.path), { ...operation, path: normalized(operation.path) }); }
        function cas(expected, actual, target) {
            if (expected !== actual) throw Object.assign(new Error('Native document revision conflict'), {
                statusCode: 409, code: 'STORAGE_CONFLICT', target, currentRevision: actual,
            });
        }
        if (request.catalog !== undefined) {
            if (!object(request.catalog) || !object(request.catalog.value)) fail('Invalid catalog update');
            cas(request.catalog.expectedRevision, state.revision);
        }
        for (const input of request.writes) {
            const target = targetOf(input.target), key = keyOf(target);
            if (unique.has(key)) fail('Duplicate write target'); unique.add(key);
            if (input.expectedRevision !== null && typeof input.expectedRevision !== 'string') fail('Expected document revision is required');
            const exists = target.kind === 'settings' || state.targets.has(key);
            const prior = exists ? readState(target, state, { metadataOnly: input.metadataOnly === true }) : null;
            cas(input.expectedRevision, prior?.revision ?? null, target);
            if (input.value === null && (!prior || target.kind === 'settings')) fail('Cannot delete missing document or global settings');
            if (input.metadataOnly && target.kind !== 'chat') fail('metadataOnly applies only to chats');
            if (input.metadataOnly && !prior) fail('Metadata-only cannot create a chat');
            if (input.metadataOnly && Object.hasOwn(input.value || {}, 'message')) fail('Metadata-only writes cannot include messages');
            // metadataOnly replaces the complete metadata snapshot, not a patch.
            // Otherwise omitted folder/module/note fields can never be cleared.
            const value = input.value === null ? null : structuredClone(input.value);
            if (value !== null) validateValue(target, value, input.metadataOnly === true);
            writes.push({ target, key, prior, value, metadataOnly: input.metadataOnly === true });
        }
        const deleted = new Set(writes.filter(write => write.value === null).map(write => write.key));
        for (const write of writes) if (write.target.kind === 'chat' && deleted.has(keyOf({ kind: 'character', id: write.target.parentId }))) fail('Cannot write a chat while deleting its character');
        const allocation = new Map();
        function allocate(directory, name, siblings = []) {
            if (!allocation.has(directory)) {
                let names = []; try { names = fs.readdirSync(safe(directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                names.push(...siblings.map(sibling => path.posix.basename(normalized(sibling.path))));
                allocation.set(directory, new Set(names.map(name => name.toLowerCase())));
            }
            const used = allocation.get(directory), base = folderName(name);
            let result = base;
            for (let suffix = 2; used.has(result.toLowerCase()); suffix++) result = `${base} (${suffix})`;
            used.add(result.toLowerCase()); return directory + '/' + result;
        }
        // Parents establish destinations before chat writes, regardless of input order.
        const ordered = [...writes].sort((a, b) => Number(a.target.kind === 'chat') - Number(b.target.kind === 'chat'));
        const characterMap = new Map(next.characters.map(character => [character.id, character]));
        for (const write of ordered) {
            const { target, value, key } = write;
            if (target.kind === 'settings') continue;
            const old = state.targets.get(key), group = GROUPS[target.kind];
            let summary = target.kind === 'character' ? characterMap.get(target.id) : target.kind === 'chat' ? characterMap.get(target.parentId)?.chats.find(chat => chat.id === target.id) : null;
            if (value === null) {
                if (target.kind === 'character') { next.characters = next.characters.filter(character => character.id !== target.id); characterMap.delete(target.id); }
                else if (target.kind === 'chat') characterMap.get(target.parentId).chats = characterMap.get(target.parentId).chats.filter(chat => chat.id !== target.id);
                else { next.collections[group[0]] = next.collections[group[0]].filter(entityId => entityId !== target.id); delete next.paths[group[0]][target.id]; if (next.names?.[group[0]]) delete next.names[group[0]][target.id]; }
                archive.push(old.folder); catalogChanged = true; continue;
            }
            const name = label(value, target.kind);
            const parent = target.kind === 'chat' ? characterMap.get(target.parentId) : null;
            if (target.kind === 'chat' && !parent) fail('Chat parent is absent from catalog');
            const directory = target.kind === 'character' ? 'characters' : target.kind === 'chat' ? normalized(parent.path) + '/chats' : group[1];
            const oldName = old?.summary?.name;
            let folder = summary ? normalized(summary.path) : old?.folder;
            if (!old || oldName !== name) folder = allocate(directory, name, parent?.chats);
            write.folder = folder;
            if (old && old.folder !== folder) { moves.push([old.folder, folder]); archive.push(old.folder); }
            if (target.kind === 'character') {
                if (!summary) { summary = { id: target.id, name, path: folder, chats: [] }; next.characters.push(summary); characterMap.set(target.id, summary); }
                else {
                    if (normalized(summary.path) !== folder) {
                        for (const chat of summary.chats) chat.path = folder + normalized(chat.path).slice(normalized(summary.path).length);
                        summary.path = folder;
                    }
                    summary.name = name;
                }
            } else if (target.kind === 'chat') {
                if (!summary) { summary = { id: target.id, name, path: folder, lastDate: value.lastDate ?? 0 }; parent.chats.push(summary); }
                else Object.assign(summary, { name, path: normalized(summary.path) === folder ? summary.path : folder, lastDate: value.lastDate ?? 0 });
            } else {
                if (!old) next.collections[group[0]].push(target.id);
                if (!old || old.folder !== folder) next.paths[group[0]][target.id] = folder;
                next.names ||= {}; next.names[group[0]] ||= {}; next.names[group[0]][target.id] = name;
            }
            if (!old || old.folder !== folder || oldName !== name || (target.kind === 'chat' && old.summary.lastDate !== (value.lastDate ?? 0))) catalogChanged = true;
        }
        if (request.catalog) {
            const desired = request.catalog.value;
            if (desired.schemaVersion !== 2 || !Array.isArray(desired.characters) || !object(desired.collections)) fail('Invalid catalog update');
            function reorder(existing, requested, getId) {
                if (!Array.isArray(requested)) fail('Invalid catalog order');
                const current = new Map(existing.map(item => [getId(item), item])), ids = requested.map(getId);
                if (new Set(ids).size !== ids.length) fail('Duplicate catalog ID');
                if (ids.length !== existing.length || ids.some(entityId => !current.has(entityId))) fail('Catalog cannot delete live IDs without explicit document deletes or add unwritten IDs');
                return ids.map(entityId => current.get(entityId));
            }
            next.characters = reorder(next.characters, desired.characters, item => id(item.id));
            const requestedCharacters = new Map(desired.characters.map(character => [character.id, character]));
            for (const character of next.characters) character.chats = reorder(character.chats, requestedCharacters.get(character.id).chats, item => id(item.id));
            for (const [field] of Object.values(GROUPS)) next.collections[field] = reorder(next.collections[field], desired.collections[field], id);
            catalogChanged ||= JSON.stringify(next) !== JSON.stringify(state.value);
        }
        if (writes.some(write => !write.prior || write.value === null) && !request.catalog) fail('Catalog revision is required for membership changes', 409);
        validateCatalog(next);
        const relocatedFiles = new Map(), relocatedDirectories = new Map();
        const inventory = entries => JSON.stringify(entries.map(entry => [entry.name, entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other']).sort(([a], [b]) => a.localeCompare(b)));
        function copyTree(from, to, sourceRoot = from) {
            const entries = fs.readdirSync(safe(from), { withFileTypes: true });
            relocatedDirectories.set(from, inventory(entries));
            const regularNames = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name.toLowerCase()));
            for (const entry of entries) {
                if (entry.isSymbolicLink()) fail('Entity folder contains a symbolic link');
                const source = from + '/' + entry.name, destination = to + '/' + entry.name;
                if (archive.some(folder => folder.startsWith(sourceRoot + '/') && (source === folder || source.startsWith(folder + '/')))) continue;
                if (entry.isDirectory()) copyTree(source, destination, sourceRoot);
                else if (entry.isFile()) {
                    const sourcePath = safe(source);
                    relocatedFiles.set(source, checksumFile(sourcePath));
                    // The transaction regenerates a canonical file's checksum.
                    // Publishing its old sidecar separately can overwrite that
                    // checksum and make a consumed stage impossible to replay.
                    if (entry.name.toLowerCase().endsWith('.sha256') && regularNames.has(entry.name.slice(0, -7).toLowerCase())) continue;
                    put({ path: destination, sourcePath });
                }
                else fail('Entity folder contains a nonregular file');
            }
        }
        // Collapse nested relocations: copy parent once, then overlay changed chat.
        for (const [from, to] of moves) copyTree(from, to);
        let assetIndex, assetBefore, assetSourceIndex;
        function assets() {
            if (!assetIndex) {
                assetBefore = bytes(ASSETS); assetIndex = JSON.parse(assetBefore.toString('utf8'));
                if (assetIndex?.schemaVersion !== 2 || !object(assetIndex.entries)) fail('Invalid native asset index');
                assetSourceIndex = assetIndex;
                assetIndex = { ...assetIndex, entries: { ...assetIndex.entries } };
            }
            return assetIndex;
        }
        const specificMoves = [...moves].sort(([a], [b]) => b.length - a.length);
        const deletedFolders = writes.filter(write => write.value === null).map(write => state.targets.get(write.key).folder);
        if (moves.length || deletedFolders.length) for (const [key, entry] of Object.entries(assets().entries)) {
            if (!Array.isArray(entry.paths)) fail('Invalid native asset mapping');
            const retained = entry.paths.filter(relative => !deletedFolders.some(folder => normalized(relative).startsWith(folder + '/')));
            const paths = retained.map(relative => { const portable = normalized(relative); const move = specificMoves.find(([from]) => portable.startsWith(from + '/')); return move ? move[1] + portable.slice(move[0].length) : relative; });
            if (!paths.length) delete assetIndex.entries[key];
            else assetIndex.entries[key] = { ...entry, paths };
        }
        const newAssetFiles = new Set();
        function requireAssetFile(relative) {
            const planned = operations.get(normalized(relative));
            if (planned?.data) return;
            const file = planned?.sourcePath || safe(relative);
            const fd = fs.openSync(file, 'r');
            try { if (!fs.fstatSync(fd).isFile()) fail('New referenced asset is missing or unreadable'); }
            finally { fs.closeSync(fd); }
        }
        for (const write of writes) {
            if (write.value === null) continue;
            const previousRefs = collectReferences(write.prior?.value), refs = collectReferences(write.value);
            const added = [...refs].filter(([key]) => !previousRefs.has(key));
            if (added.length && write.target.kind !== 'settings') {
                const index = assets(), target = write.target, owner = target.kind === 'chat' ? { kind: 'character', id: target.parentId } : { kind: target.kind, id: target.id };
                const ownerFolder = target.kind === 'chat' ? normalized(characterMap.get(target.parentId).path) : write.folder;
                const identity = checksum(Buffer.from(JSON.stringify([owner.kind, owner.id]))).slice(0, 16), replacements = new Map();
                for (const [key, assetLabel] of added) {
                    const mapping = index.entries[key], own = mapping?.paths?.find(relative => normalized(relative).startsWith(ownerFolder + '/assets/'));
                    if (own && mapping.paths.length === 1) { requireAssetFile(own); newAssetFiles.add(own); continue; }
                    const scoped = key.match(/^assets\/owned-([a-f0-9]{16})-([a-f0-9]{64})(\.[a-z0-9]{1,8})?$/);
                    const ext = path.posix.extname(key).toLowerCase(), extension = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
                    const destinationKey = scoped?.[1] === identity ? key : `assets/owned-${identity}-${scoped?.[2] || checksum(Buffer.from(key))}${extension}`;
                    let destination = index.entries[destinationKey]?.paths?.find(relative => normalized(relative).startsWith(ownerFolder + '/assets/'));
                    if (destination) { requireAssetFile(destination); newAssetFiles.add(destination); }
                    if (!destination) {
                        let source = getOwnedAssetSource(root, key, assetSourceIndex);
                        if (!source) {
                            const manifest = JSON.parse(bytes('kv/manifest.json').toString('utf8')), entry = manifest.entries?.[key];
                            if (!entry || !/^[a-f0-9]{64}$/.test(entry.object)) {
                                fail(`Missing referenced asset: ${key} (${target.kind}/${target.id})`);
                            }
                            source = safe('kv/objects/' + entry.object);
                        }
                        const assetData = fs.readFileSync(source), base = folderName(assetLabel.replace(new RegExp(extension.replace('.', '\\.') + '$'), ''));
                        destination = `${ownerFolder}/assets/${base}${extension}`;
                        for (let suffix = 2; operations.has(destination) || fs.existsSync(safe(destination)); suffix++) destination = `${ownerFolder}/assets/${base}-${suffix}${extension}`;
                        put({ path: destination, data: assetData });
                        index.entries[destinationKey] = { paths: [destination], checksum: checksum(assetData), owner, sourceKey: mapping?.sourceKey || key };
                    }
                    replacements.set(key, destinationKey);
                }
                write.value = rewriteReferences(write.value, replacements);
            }
            if (write.target.kind === 'settings') {
                const parts = splitSecrets(write.value);
                put({ path: 'settings/app.json', data: json({ schemaVersion: 1, ...parts.settings }) });
                put({ path: 'secrets/credentials.json', data: json({ schemaVersion: 1, ...parts.secrets }) });
            } else {
                const value = { ...write.value };
                if (write.target.kind === 'chat') {
                    delete value.message;
                    if (!write.metadataOnly) put({ path: write.folder + '/messages.jsonl', data: Buffer.from(write.value.message.map(message => JSON.stringify(message)).join('\n') + (write.value.message.length ? '\n' : '')) });
                }
                for (const operation of encodeEntity(write.target.kind, value, write.folder)) put(operation);
            }
        }
        if (assetIndex && !json(assetIndex).equals(assetBefore)) put({ path: ASSETS, data: json(assetIndex) });
        if (catalogChanged) { put({ path: ORDER, data: json(next) }); put({ path: 'index/sidebar.json', data: json(next) }); }
        const changed = [...operations.values()].filter(operation => {
            if (operation.sourcePath) return true;
            try { return !bytes(operation.path).equals(operation.data); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        });
        const archiveRoots = [...new Set(archive)].filter(folder => !archive.some(other => other !== folder && folder.startsWith(other + '/')));
        const transactionId = crypto.randomUUID();
        for (const folder of archiveRoots) changed.push({ path: folder, archiveTo: `trash/native-${transactionId}/${folder}` });
        // Recheck actual bytes after planning. This includes external edits that
        // preserve mtime/size; checksum sidecars are never adopted during reads.
        function recheck() {
            cas(state.revision, checksum(bytes(ORDER)));
            for (const write of writes) if (write.prior) cas(write.prior.revision, readState(write.target, state, { metadataOnly: write.metadataOnly }).revision, write.target);
            if (assetBefore) cas(checksum(assetBefore), checksum(bytes(ASSETS)));
            try {
                for (const [directory, expected] of relocatedDirectories) cas(expected, inventory(fs.readdirSync(safe(directory), { withFileTypes: true })));
                for (const [relative, expected] of relocatedFiles) cas(expected, checksumFile(safe(relative)));
                for (const relative of newAssetFiles) requireAssetFile(relative);
            } catch (error) {
                if (error.statusCode === 409) throw error;
                fail('Native document source changed during transaction: revision conflict', 409);
            }
        }
        recheck();
        commitTransaction(root, changed, { ...options, beforePrepare: recheck });
        const finalState = catalogState();
        return { documents: writes.map(write => write.value === null ? { target: write.target, value: null, revision: null } : envelope(readState(write.target, finalState, { metadataOnly: write.metadataOnly }))), catalog: { value: finalState.value, revision: finalState.revision } };
    }
    return { catalog, read, commit };
}

module.exports = { createNativeDocumentStore };
