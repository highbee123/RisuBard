'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readVerifiedJson, commitTransaction, recoverTransactions, resolveInside } = require('./file-store.cjs');

const ORDER = 'settings/entity-order.json';
const LAYOUT = 'settings/layout.json';
const GROUPS = [
    ['botPresets', 'prompts', 'prompt'], ['modules', 'modules', 'module'],
    ['personas', 'personas', 'persona'], ['loreBook', 'lorebooks', 'lorebook'],
];

function folderName(value, fallback = 'Untitled') {
    let name = String(value || fallback).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .trim().replace(/^[. ]+|[. ]+$/g, '');
    name = Array.from(name).slice(0, 40).join('').replace(/[. ]+$/g, '') || fallback;
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name;
}

function isNamedRoot(root) { return fs.existsSync(path.join(root, LAYOUT)); }
function json(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

function createNamedUserDataRepository(options) {
    const root = path.resolve(options.dataRoot);
    const { stableId, validateImport, splitSecrets, deepMerge } = require('./user-data-repository.cjs');
    const codec = () => require('./named-entity-codec.cjs');
    const assets = () => require('./owned-assets.cjs');
    const legacy = options.legacyFactory;
    if (!options.readOnly) {
        fs.mkdirSync(root, { recursive: true });
        recoverTransactions(root);
    }
    function read(relative, opts = {}) { return readVerifiedJson(root, relative, opts); }
    function validIndex(value) {
        if (value?.schemaVersion !== 2 || !Array.isArray(value.characters) || !value.collections || !value.paths) return false;
        const seen = new Set();
        function location(folder, directory) {
            if (typeof folder !== 'string') return false;
            const normalized = folder.replace(/\\/g, '/');
            if (!normalized.startsWith(`${directory}/`) || normalized.slice(directory.length + 1).includes('/')) return false;
            resolveInside(root, normalized);
            const folded = normalized.toLowerCase();
            if (seen.has(folded)) return false;
            seen.add(folded);
            return true;
        }
        for (const [field, directory] of GROUPS) {
            const ids = value.collections[field];
            if (!Array.isArray(ids) || !value.paths[field] || new Set(ids).size !== ids.length) return false;
            for (const id of ids) if (typeof id !== 'string' || !Object.hasOwn(value.paths[field], id) || !location(value.paths[field][id], directory)) return false;
        }
        if (new Set(value.characters.map(c => c.id)).size !== value.characters.length) return false;
        return value.characters.every(c => typeof c.id === 'string' && location(c.path, 'characters') && Array.isArray(c.chats)
            && new Set(c.chats.map(chat => chat.id)).size === c.chats.length
            && c.chats.every(chat => typeof chat.id === 'string' && location(chat.path, `${c.path.replace(/\\/g, '/')}/chats`)));
    }
    function loadSidebarIndex(opts = {}) {
        if (!isNamedRoot(root)) return legacy().loadSidebarIndex(opts);
        const layout = read(LAYOUT);
        if (layout.schemaVersion !== 2) throw new Error('Unsupported named-folder layout');
        try { return read('index/sidebar.json', { ...opts, validate: validIndex }); }
        catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !/validation|checksum/.test(error.message)) throw error;
            const order = read(ORDER, { validate: validIndex });
            if (options.readOnly) throw new Error('Read-only V2 source requires a valid sidebar index', { cause: error });
            atomicWriteJson(root, 'index/sidebar.json', order);
            return order;
        }
    }
    function characterSummary(id) {
        const entry = loadSidebarIndex().characters.find(c => c.id === id || stableId(c.id, 'character') === id);
        if (!entry) throw new Error('Character is absent from the canonical index');
        return entry;
    }
    function chatSummary(characterId, chatId) {
        const entry = characterSummary(characterId).chats.find(c => c.id === chatId || stableId(c.id, 'chat') === chatId);
        if (!entry) throw new Error('Chat is absent from the canonical index');
        return entry;
    }
    function loadCharacter(id, opts = {}) {
        const summary = characterSummary(id);
        const entity = codec().decodeEntity(root, 'character', summary.path, opts);
        if (entity.chaId !== summary.id) throw new Error('Canonical character ID does not match its index');
        return entity;
    }
    function loadMessages(characterId, chatId) {
        const file = path.join(chatSummary(characterId, chatId).path, 'messages.jsonl');
        return fs.readFileSync(resolveInside(root, file), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    }
    function loadChat(characterId, chatId, opts = {}) {
        const summary = chatSummary(characterId, chatId);
        const entity = codec().decodeEntity(root, 'chat', summary.path, opts);
        if (entity.id !== summary.id) throw new Error('Canonical chat ID does not match its index');
        return { ...entity, message: loadMessages(characterId, chatId) };
    }
    function exportLegacyDatabase(opts = {}) {
        if (!isNamedRoot(root)) return legacy().exportLegacyDatabase(opts);
        const index = loadSidebarIndex(opts);
        const { schemaVersion: _s, ...settings } = read('settings/app.json', opts);
        const { schemaVersion: _k, ...secrets } = read('secrets/credentials.json', opts);
        const result = deepMerge(settings, secrets);
        for (const [field, , kind] of GROUPS) result[field] = index.collections[field].map(id => {
            const entity = codec().decodeEntity(root, kind, index.paths[field][id], opts);
            if (entity.id !== id) throw new Error('Canonical entity ID does not match its index');
            return entity;
        });
        result.characters = index.characters.map(c => ({ ...loadCharacter(c.id, opts), chats: c.chats.map(chat => loadChat(c.id, chat.id, opts)) }));
        return result;
    }
    function buildAllocator(directory, previous = []) {
        const used = new Set();
        const own = new Map(previous.map(entry => [entry.id, entry]));
        if (fs.existsSync(path.join(root, directory))) {
            for (const entry of fs.readdirSync(path.join(root, directory))) used.add(entry.toLocaleLowerCase('en-US'));
        }
        return (id, label) => {
            const prior = own.get(id);
            if (prior && prior.name === label) return prior.path;
            const base = folderName(label);
            let name = base, suffix = 2;
            while (used.has(name.toLocaleLowerCase('en-US'))) name = `${base} (${suffix++})`;
            used.add(name.toLocaleLowerCase('en-US'));
            return path.join(directory, name);
        };
    }
    function importLegacyDatabase(incoming, importOptions = {}) {
        const mode = importOptions.mode || 'merge';
        if (!['merge', 'replace', 'sync'].includes(mode)) throw new Error('Invalid import mode');
        const hadNamed = isNamedRoot(root);
        const previous = hadNamed ? loadSidebarIndex() : legacy().loadSidebarIndex();
        validateImport(incoming, mode, previous);
        let db = structuredClone(incoming);
        require('./canonical-import.cjs').assignImportIds(db);
        if (mode === 'merge') {
            const old = exportLegacyDatabase();
            const addition = db;
            const merge = (a, b, key) => [...new Map([...a, ...b].map(item => [key(item), item])).values()];
            db = deepMerge(old, db);
            for (const [field] of GROUPS) db[field] = merge(old[field] || [], addition[field] || [], item => item.id);
            db.characters = merge(old.characters || [], addition.characters || [], item => item.chaId || item.id).map(character => {
                const prior = old.characters.find(c => (c.chaId || c.id) === (character.chaId || character.id));
                return { ...character, chats: merge(prior?.chats || [], character.chats || [], c => c.id) };
            });
        }
        require('./canonical-import.cjs').assignImportIds(db);
        validateImport(db, 'sync', previous);
        const previousAssets = assets().readOwnedAssetIndex(root);
        const kvManifest = fs.existsSync(path.join(root, 'kv/manifest.json')) ? read('kv/manifest.json') : { entries: {} };
        const allAssetKeys = importOptions.allAssetKeys || [...new Set([...Object.keys(previousAssets.entries), ...Object.keys(kvManifest.entries).filter(key => key.startsWith('assets/'))])];
        const previousOwners = require('./owner-asset-references.cjs').previousDatabaseOwners(previous);
        const normalization = require('./owner-asset-references.cjs').normalizeOwnerAssetReferences(db, { previousIndex: previousAssets, previousOwners, allAssetKeys });
        db = normalization.database;
        const operations = [];
        const excluded = new Set(['characters', ...GROUPS.map(g => g[0])]);
        const parts = splitSecrets(Object.fromEntries(Object.entries(db).filter(([key]) => !excluded.has(key))));
        operations.push({ path: 'settings/app.json', data: json({ schemaVersion: 1, ...parts.settings }) },
            { path: 'secrets/credentials.json', data: json({ schemaVersion: 1, ...parts.secrets }) });
        const index = { schemaVersion: 2, updatedAt: Date.now(), characters: [], collections: {}, paths: {}, names: {} };
        const owners = [], retained = new Set(), relocated = [], deleted = [];
        function carryExtras(from, to, skip = new Set()) {
            const extraRoot = importOptions.migrationSourceRoot || root;
            if (!from || (from === to && extraRoot === root) || !fs.existsSync(path.join(extraRoot, from))) return;
            function visit(relative) {
                for (const entry of fs.readdirSync(path.join(extraRoot, from, relative), { withFileTypes: true })) {
                    if (!relative && skip.has(entry.name)) continue;
                    const local = path.join(relative, entry.name);
                    if (entry.isSymbolicLink()) throw new Error('Entity folder contains a symbolic link');
                    if (entry.isDirectory()) visit(local);
                    else operations.push({ path: path.join(to, local), sourcePath: path.join(extraRoot, from, local), sourceRoot: extraRoot });
                }
            }
            visit('');
        }
        for (const [field, directory, kind] of GROUPS) {
            const prior = hadNamed ? previous.collections[field].map(id => ({ id, path: previous.paths[field][id], name: previous.names?.[field]?.[id] })) : [];
            const allocate = buildAllocator(directory, prior);
            index.collections[field] = [];
            index.paths[field] = Object.create(null);
            index.names[field] = Object.create(null);
            for (const entity of db[field]) {
                const folder = allocate(entity.id, entity.name || entity.title || 'Untitled');
                const oldFolder = prior.find(e => e.id === entity.id)?.path;
                carryExtras(oldFolder, folder, new Set(['assets']));
                if (oldFolder && oldFolder !== folder) relocated.push(oldFolder);
                operations.push(...codec().encodeEntity(kind, entity, folder));
                owners.push({ kind, id: entity.id, folder, entity });
                index.collections[field].push(entity.id);
                index.paths[field][entity.id] = folder;
                index.names[field][entity.id] = entity.name || entity.title || 'Untitled';
                retained.add(folder);
            }
            for (const item of prior) if (!retained.has(item.path)) deleted.push(item.path);
        }
        const priorCharacters = hadNamed ? previous.characters : [];
        const allocateCharacter = buildAllocator('characters', priorCharacters);
        for (const character of db.characters) {
            const folder = allocateCharacter(character.chaId, character.name || 'Untitled');
            const oldCharacter = previous.characters.find(c => c.id === character.chaId || c.id === stableId(character.chaId, 'character'));
            const oldFolder = hadNamed ? oldCharacter?.path : oldCharacter ? path.join('characters', oldCharacter.id) : null;
            carryExtras(oldFolder, folder, new Set(['assets', 'chats']));
            if (hadNamed && oldFolder && oldFolder !== folder) relocated.push(oldFolder);
            const { chats, ...metadata } = character;
            operations.push(...codec().encodeEntity('character', metadata, folder));
            owners.push({ kind: 'character', id: character.chaId, folder, entity: character });
            const summary = { id: character.chaId, name: character.name || 'Untitled', path: folder, chats: [] };
            const previousChats = hadNamed && oldFolder === folder ? oldCharacter?.chats || [] : [];
            const allocateChat = buildAllocator(path.join(folder, 'chats'), previousChats);
            for (const chat of chats) {
                const chatFolder = allocateChat(chat.id, chat.name || 'Chat');
                const oldChat = oldCharacter?.chats.find(c => c.id === chat.id || c.id === stableId(chat.id, 'chat'));
                const oldChatFolder = hadNamed ? oldChat?.path : oldChat ? path.join(oldFolder, 'chats', oldChat.id) : null;
                carryExtras(oldChatFolder, chatFolder);
                if (hadNamed && oldFolder === folder && oldChatFolder && oldChatFolder !== chatFolder) relocated.push(oldChatFolder);
                const { message, ...chatMetadata } = chat;
                operations.push(...codec().encodeEntity('chat', chatMetadata, chatFolder));
                operations.push({ path: path.join(chatFolder, 'messages.jsonl'), data: Buffer.from(message.map(m => JSON.stringify(m)).join('\n') + (message.length ? '\n' : '')) });
                summary.chats.push({ id: chat.id, name: chat.name || 'Chat', path: chatFolder, lastDate: chat.lastDate ?? 0 });
                retained.add(chatFolder);
            }
            if (hadNamed && oldFolder === folder) for (const chat of oldCharacter?.chats || []) if (!retained.has(chat.path)) deleted.push(chat.path);
            index.characters.push(summary);
            retained.add(folder);
        }
        for (const c of priorCharacters) if (!retained.has(c.path)) deleted.push(c.path);
        const readAsset = importOptions.readAsset || options.readAsset || (key => {
            const owned = assets().getOwnedAssetSource?.(root, key, previousAssets);
            if (owned) return { sourcePath: owned };
            const entry = kvManifest.entries[key];
            if (entry && !/^[a-f0-9]{64}$/.test(entry.object)) throw new Error('Invalid content object hash');
            return entry ? { sourcePath: path.join(root, 'kv/objects', entry.object), checksum: entry.object } : null;
        });
        const assetPlan = assets().planOwnedAssets({ dataRoot: root, owners, database: db, readAsset: key => {
            const alias = normalization.aliases.get(key);
            if (alias?.path) return { sourcePath: assets().getOwnedAssetSource(root, key, normalization.previousIndex) };
            return readAsset(alias?.sourceKey || key);
        },
            previousIndex: normalization.previousIndex, sourceRoot: importOptions.assetSourceRoot || options.assetSourceRoot || root,
            strict: importOptions.strictAssets === true,
            allAssetKeys: allAssetKeys.filter(key => !normalization.consumedAssetKeys.includes(key)),
        });
        for (const [key, alias] of normalization.aliases) if (assetPlan.index.entries[key]) {
            Object.assign(assetPlan.index.entries[key], { owner: alias.owner, sourceKey: alias.originalKey });
        }
        const retirements = [];
        const activePaths = new Set(Object.values(assetPlan.index.entries).flatMap(entry => entry.paths.map(relative => relative.toLowerCase())));
        const retirementCandidates = [];
        for (const [key, entry] of Object.entries(previousAssets.entries)) {
            if (!/^[a-f0-9]{64}$/.test(entry.checksum)) continue;
            for (const relative of entry.paths) {
                if (!/^shared\/assets\/[^/]+$/.test(relative) || /\.(?:bak|sha256)$/i.test(relative) || activePaths.has(relative.toLowerCase())) continue;
                retirementCandidates.push({ key, relative, checksum: entry.checksum });
            }
        }
        if (retirementCandidates.length) {
            const replacements = new Map();
            for (const [nextKey, next] of Object.entries(assetPlan.index.entries)) {
                const replacementPath = next.paths.find(relative => /^(?:characters|personas|modules|prompts|lorebooks)\/[^/]+\/assets\/[^/]+$/.test(relative));
                if (!replacementPath) continue;
                for (const key of [nextKey, next.sourceKey]) if (typeof key === 'string') {
                    const identity = `${key}\0${next.checksum}`;
                    if (!replacements.has(identity)) replacements.set(identity, replacementPath);
                }
            }
            for (const candidate of retirementCandidates) {
                const replacementPath = replacements.get(`${candidate.key}\0${candidate.checksum}`);
                if (!replacementPath) continue;
                // Never retire an externally changed upload merely because a
                // similarly named owner file exists. The journal checks again.
                if (assets().checksumOwnedAssetFile(resolveInside(root, candidate.relative)) !== candidate.checksum) continue;
                retirements.push({ path: candidate.relative, retireIfChecksum: candidate.checksum, replacementPath });
            }
        }
        operations.push(...assetPlan.operations, { path: 'settings/asset-files.json', data: json(assetPlan.index) });
        const archiveId = `layout-${crypto.randomUUID()}`;
        // Stage all relocated files before archiving their old directory.
        const archives = [...new Set([...relocated, ...deleted])].filter(folder =>
            ![...relocated, ...deleted].some(parent => parent !== folder && folder.startsWith(`${parent}${path.sep}`)));
        if (!hadNamed) {
            // Legacy archived metadata still refers to KV keys. Pin its objects
            // even after active assets are edited or explicitly deleted later.
            if (Object.keys(kvManifest.entries).length) {
                operations.push({ path: `trash/import-${archiveId}/kv-manifest.json`, data: json(kvManifest) });
            }
            // Preserve the old ID tree in-place until all staged bytes are durable.
            for (const [field, directory] of [['characters', 'characters'], ['botPresets', 'presets'], ['modules', 'modules'], ['personas', 'personas'], ['loreBook', 'lorebooks']]) {
                if (!fs.existsSync(path.join(root, directory))) continue;
                // New folders are only staged so the old root may be archived safely.
                archives.push(directory);
            }
        }
        const unique = new Map(operations.map(op => [path.normalize(op.path), { ...op, path: path.normalize(op.path) }]));
        // Source checksum sidecars belong to the old bytes, not regenerated metadata.
        for (const name of [...unique.keys()]) if (name.endsWith('.sha256') && unique.has(name.slice(0, -7))) unique.delete(name);
        const archiveOperations = archives.filter(folder => fs.existsSync(path.join(root, folder))).map(folder => ({ path: folder, archiveTo: path.join('trash', archiveId, folder) }));
        unique.set(LAYOUT, { path: LAYOUT, data: json({ schemaVersion: 2, format: 'risubard-named-folders' }) });
        unique.set(ORDER, { path: ORDER, data: json(index) });
        unique.set('index/sidebar.json', { path: 'index/sidebar.json', data: json(index) });
        if (importOptions.planOnly) {
            if (hadNamed || fs.existsSync(root)) throw new Error('Migration planning requires a new destination');
            return { operations: [...unique.values()], database: db, consumedAssetKeys: normalization.consumedAssetKeys };
        }
        if (importOptions.checkSpace) {
            let required = 64 * 1024 * 1024;
            for (const op of unique.values()) {
                required += op.sourcePath ? fs.statSync(op.sourcePath).size : op.data.length;
                const target = path.join(root, op.path);
                if (fs.existsSync(target)) required += fs.statSync(target).size;
                if (importOptions.rollbackOnFailure === true) {
                    if (fs.existsSync(target)) required += fs.statSync(target).size;
                    for (const suffix of ['.sha256', '.bak']) {
                        if (fs.existsSync(`${target}${suffix}`)) required += fs.statSync(`${target}${suffix}`).size;
                    }
                }
            }
            if (importOptions.rollbackOnFailure === true) {
                for (const op of retirements) {
                    for (const suffix of ['', '.sha256', '.bak']) {
                        const target = `${path.join(root, op.path)}${suffix}`;
                        if (fs.existsSync(target)) required += fs.statSync(target).size;
                    }
                }
            }
            const space = fs.statfsSync(root);
            if (Number(space.bavail) * Number(space.bsize) < required) throw new Error('V2 파일 생성에 필요한 디스크 여유 공간이 부족합니다.');
        }
        commitTransaction(root, [...archiveOperations, ...unique.values(), ...retirements], {
            sourceRoot: importOptions.assetSourceRoot || options.assetSourceRoot || root,
            onProgress: importOptions.onProgress,
            rollbackOnFailure: importOptions.rollbackOnFailure === true,
            failAfterPublish: importOptions.failAfterPublish,
        });
        return { mode, characters: db.characters.length, files: unique.size, formatVersion: 2, database: db, consumedAssetKeys: normalization.consumedAssetKeys };
    }
    function getProjectionRevision() {
        if (!isNamedRoot(root)) return legacy().getProjectionRevision();
        const index = loadSidebarIndex();
        const files = [LAYOUT, ORDER, 'settings/app.json', 'secrets/credentials.json', 'settings/asset-files.json'];
        for (const [field, , kind] of GROUPS) for (const id of index.collections[field]) files.push(...codec().entityFiles(root, kind, index.paths[field][id]));
        for (const c of index.characters) {
            files.push(...codec().entityFiles(root, 'character', c.path));
            for (const chat of c.chats) files.push(...codec().entityFiles(root, 'chat', chat.path), path.join(chat.path, 'messages.jsonl'));
        }
        const hash = crypto.createHash('sha256');
        for (const file of [...new Set(files)].sort()) {
            const stat = fs.statSync(resolveInside(root, file), { bigint: true });
            hash.update(`${file}\0${stat.size}\0${stat.mtimeNs}\n`);
        }
        return hash.digest('hex');
    }
    function draftPath(c, chat) { return path.join(chatSummary(c, chat).path, 'draft.json'); }
    function appendMessage(c, chat, message) {
        const file = resolveInside(root, path.join(chatSummary(c, chat).path, 'messages.jsonl'));
        const fd = fs.openSync(file, 'a');
        try { fs.writeFileSync(fd, `${JSON.stringify(message)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return message;
    }
    function loadAssistantDraft(c, chat) { const file = draftPath(c, chat); return fs.existsSync(path.join(root, file)) ? read(file) : null; }
    return { dataRoot: root, importLegacyDatabase, exportLegacyDatabase, loadSidebarIndex, rebuildSidebarIndex: loadSidebarIndex,
        loadCharacter, loadChat, loadMessages, getProjectionRevision, appendMessage, commitUserMessage: appendMessage,
        saveAssistantDraft: (c, chat, value) => atomicWriteJson(root, draftPath(c, chat), value), loadAssistantDraft,
        finalizeAssistantDraft(c, chat) { const draft = loadAssistantDraft(c, chat); if (!draft) return null; appendMessage(c, chat, draft); require('./file-store.cjs').moveToTrash(root, draftPath(c, chat)); return draft; },
    };
}
module.exports = { createNamedUserDataRepository, folderName, isNamedRoot, GROUPS };
