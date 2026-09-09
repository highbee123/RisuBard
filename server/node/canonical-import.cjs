'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { isDeepStrictEqual } = require('util');
const { decodeRisuSave, normalizeJSON } = require('./utils.cjs');
const { createUserDataRepository } = require('./user-data-repository.cjs');

const ENTITY_ROOTS = ['settings', 'secrets', 'presets', 'prompts', 'modules', 'personas', 'lorebooks', 'characters', 'shared', 'index'];
const COLD_HEADER = '\uEF01COLDSTORAGE\uEF01';

// Resolve exclusively against the incoming snapshot, never the previous user's KV.
async function decodeImportDatabase(raw, getEntry) {
    const database = normalizeJSON(await decodeRisuSave(raw, {
        strict: true,
        resolveRemote: name => getEntry(`remotes/${name}.local.bin`),
    }));
    if (!database || !Array.isArray(database.characters)) throw new Error('Incomplete import: missing characters');
    async function coldData(rawKey) {
        const key = String(rawKey).replace(/^coldstorage\//, '').replace(/\.json$/, '');
        if (!key || /[\\/]/.test(key)) throw new Error('Invalid cold storage key');
        const bytes = await getEntry(`coldstorage/${key}`) || await getEntry(`coldstorage/${key}.json`);
        if (!bytes) throw new Error('Incomplete import: missing cold storage payload');
        let json;
        try { json = zlib.gunzipSync(bytes); } catch { json = bytes; }
        return JSON.parse(Buffer.from(json).toString('utf8'));
    }
    for (const character of database.characters) {
        if (character.coldstorage) {
            const full = await coldData(character.coldstorage);
            if (!full?.character || !Array.isArray(full.character.chats)) throw new Error('Invalid cold storage character');
            Object.assign(character, full.character);
            delete character.coldstorage;
            delete character.coldStoragedChats;
        }
        for (const chat of character.chats || []) {
            const first = chat.message?.[0]?.data;
            if (typeof first === 'string' && first.startsWith(COLD_HEADER)) {
                const full = await coldData(first.slice(COLD_HEADER.length));
                const messages = Array.isArray(full) ? full : full?.message;
                if (!Array.isArray(messages)) throw new Error('Invalid cold storage chat');
                chat.message = messages;
                for (const key of ['hypaV3Data', 'scriptstate', 'localLore']) {
                    if (!Array.isArray(full) && key in full) chat[key] = full[key];
                }
            }
            // Legacy hybrid chats can retain a stub flag alongside their
            // full payload. Normalize only after any cold body is restored.
            if (chat._stub === true && Array.isArray(chat.message)) delete chat._stub;
        }
    }
    return database;
}

function assignImportIds(database) {
    for (const field of ['botPresets', 'modules', 'personas', 'loreBook']) {
        if (database[field] === undefined) database[field] = [];
        if (!Array.isArray(database[field])) throw new Error(`Invalid import collection: ${field}`);
        for (const item of database[field]) {
            if (!item || typeof item !== 'object') throw new Error('Invalid import entity');
            item.id ||= crypto.randomUUID();
        }
    }
    for (const character of database.characters) {
        character.chaId ||= character.id || crypto.randomUUID();
        for (const chat of character.chats || []) chat.id ||= crypto.randomUUID();
    }
}

// Only an explicit user-confirmed ID list may repair stale deletion state.
// Missing image bytes alone never imply that an entity should be deleted.
function applyConfirmedModuleDeletions(database, ids = []) {
    const selected = new Set(ids);
    const modules = database.modules || [];
    for (const id of selected) {
        if (typeof id !== 'string' || !id || !modules.some(module => module.id === id)) {
            throw new Error('Confirmed module deletion ID is absent from the source database');
        }
    }
    if (!selected.size) return [];
    const removed = modules.filter(module => selected.has(module.id)).map(module => ({ id: module.id, name: module.name || '' }));
    database.modules = modules.filter(module => !selected.has(module.id));
    const filter = list => list.filter(id => !selected.has(id));
    if (Array.isArray(database.enabledModules)) database.enabledModules = filter(database.enabledModules);
    for (const assignments of Object.values(database.personaEnabledModules || {})) {
        if (!Array.isArray(assignments)) throw new Error('Invalid persona module assignment');
        for (let i = assignments.length - 1; i >= 0; i--) if (selected.has(assignments[i])) assignments.splice(i, 1);
    }
    for (const character of database.characters || []) {
        if (Array.isArray(character.modules)) character.modules = filter(character.modules);
        for (const chat of character.chats || []) if (Array.isArray(chat.modules)) chat.modules = filter(chat.modules);
    }
    const organizer = database.collectionOrganizers?.modules;
    if (Array.isArray(organizer?.itemOrder)) organizer.itemOrder = filter(organizer.itemOrder);
    if (organizer?.folderByItemId) for (const id of selected) delete organizer.folderByItemId[id];
    return removed;
}

function stageCanonicalDatabase(stagingRoot, database, options = {}) {
    database = structuredClone(database);
    assignImportIds(database);
    const repository = createUserDataRepository({ dataRoot: stagingRoot, formatVersion: options.formatVersion ?? 2,
        readAsset: options.readAsset, assetSourceRoot: options.assetSourceRoot });
    const { normalizeOwnerAssetReferences, previousDatabaseOwners } = require('./owner-asset-references.cjs');
    const expected = (options.formatVersion ?? 2) === 2 ? normalizeOwnerAssetReferences(database, {
        previousIndex: require('./owned-assets.cjs').readOwnedAssetIndex(stagingRoot),
        previousOwners: previousDatabaseOwners(repository.loadSidebarIndex()), allAssetKeys: options.allAssetKeys || [],
    }).database : database;
    const imported = repository.importLegacyDatabase(database, {
        mode: 'sync', strictAssets: options.strictAssets === true,
        allAssetKeys: options.allAssetKeys || [], checkSpace: options.checkSpace === true,
        onProgress: options.onProgress,
    });
    options.onPhase?.('verifying');
    const restored = repository.exportLegacyDatabase();
    // Compare the whole document, not just counts: prompts, settings, selections,
    // extension fields and message content must all survive the file conversion.
    if (!isDeepStrictEqual(restored, expected)) throw new Error('Import conversion did not preserve all database fields');
    options.onAssetNormalization?.({ consumedAssetKeys: imported.consumedAssetKeys || [] });
    return restored;
}

function collectImportFiles(root, relativeDirectory = '') {
    const operations = [];
    for (const entry of fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
        if (entry.name === '.journal') continue;
        const relative = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) operations.push(...collectImportFiles(root, relative));
        else if (entry.isFile() && !entry.name.endsWith('.sha256')) {
            operations.push({ path: relative, sourcePath: path.join(root, relative) });
        } else if (entry.isSymbolicLink()) throw new Error('Import cannot contain symbolic links');
    }
    return operations;
}

module.exports = { ENTITY_ROOTS, decodeImportDatabase, assignImportIds, applyConfirmedModuleDeletions, stageCanonicalDatabase, collectImportFiles };
