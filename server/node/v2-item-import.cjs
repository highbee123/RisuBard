'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createUserDataRepository } = require('./user-data-repository.cjs');
const { isNamedRoot } = require('./named-user-data-repository.cjs');
const { collectReferences, getOwnedAssetSource, readOwnedAssetIndex } = require('./owned-assets.cjs');
const { rewriteReferences } = require('./owner-asset-references.cjs');

const TYPES = Object.freeze([
    { kind: 'character', field: 'characters', count: 'characters', id: item => item?.chaId },
    { kind: 'module', field: 'modules', count: 'modules', id: item => item?.id },
    { kind: 'persona', field: 'personas', count: 'personas', id: item => item?.id },
    { kind: 'prompt', field: 'botPresets', count: 'prompts', id: item => item?.id },
    { kind: 'lorebook', field: 'loreBook', count: 'lorebooks', id: item => item?.id },
]);

function key(kind, id) { return `${kind}\0${id}`; }
function displayName(item) { return String(item?.name || item?.title || 'Untitled'); }

function validateRoot(sourceRoot, targetRoot) {
    if (typeof sourceRoot !== 'string' || !sourceRoot.trim()) throw new Error('V2 source path is required');
    const source = path.resolve(sourceRoot.trim());
    const target = path.resolve(targetRoot);
    if (source.toLowerCase() === target.toLowerCase()) throw new Error('Source and target data roots must be different');
    const sourceToTarget = path.relative(source, target);
    const targetToSource = path.relative(target, source);
    if ((!sourceToTarget.startsWith('..') && !path.isAbsolute(sourceToTarget))
        || (!targetToSource.startsWith('..') && !path.isAbsolute(targetToSource))) {
        throw new Error('Source and target data roots must not contain each other');
    }
    let stat;
    try { stat = fs.lstatSync(source); }
    catch (error) { throw new Error('Cannot access V2 source directory', { cause: error }); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('V2 source must be a regular directory');
    if (!isNamedRoot(source)) throw new Error('Source is not a RisuBard V2 data root');
    const journal = path.join(source, '.journal');
    if (fs.existsSync(journal) && fs.readdirSync(journal).length) throw new Error('V2 source has an unfinished transaction');
    return source;
}

function loadReadOnlyDatabase(sourceRoot) {
    return createUserDataRepository({ dataRoot: sourceRoot, readOnly: true })
        .exportLegacyDatabase({ acceptExternalChanges: true, persistChecksum: false });
}

function catalog(database) {
    const result = new Map();
    for (const type of TYPES) for (const entity of database[type.field] || []) {
        const id = type.id(entity);
        if (typeof id !== 'string' || !id) throw new Error(`V2 source contains an invalid ${type.kind} ID`);
        const identity = key(type.kind, id);
        if (result.has(identity)) throw new Error(`V2 source contains a duplicate ${type.kind} ID`);
        result.set(identity, { ...type, entity, id, identity });
    }
    return result;
}

function referencedModuleIds(item, database) {
    const result = new Set();
    const add = values => {
        if (!Array.isArray(values)) return;
        for (const value of values) if (typeof value === 'string' && value) result.add(value);
    };
    if (item.kind === 'character') {
        add(item.entity.modules);
        for (const chat of item.entity.chats || []) add(chat?.modules);
    }
    if (item.kind === 'persona') add(database.personaEnabledModules?.[item.id]);
    return result;
}

function dependencyMap(items, database) {
    const result = new Map();
    for (const item of items.values()) {
        const dependencies = [];
        for (const id of referencedModuleIds(item, database)) {
            const match = items.get(key('module', id));
            if (match && match.identity !== item.identity) dependencies.push(match);
        }
        result.set(item.identity, dependencies);
    }
    return result;
}

function itemSummary(item, dependencies) {
    return {
        kind: item.kind,
        id: item.id,
        name: displayName(item.entity),
        dependencies: dependencies.map(dep => ({ kind: dep.kind, id: dep.id, name: displayName(dep.entity) })),
    };
}

function rewriteTypedIds(database, replacements) {
    const replacement = (kind, id) => replacements.get(key(kind, id)) || id;
    const modules = values => Array.isArray(values) ? values.map(id => replacement('module', id)) : values;
    for (const character of database.characters || []) {
        character.chaId = replacement('character', character.chaId);
        character.modules = modules(character.modules);
        for (const chat of character.chats || []) chat.modules = modules(chat.modules);
    }
    for (const [field, kind] of [['modules', 'module'], ['personas', 'persona'], ['botPresets', 'prompt'], ['loreBook', 'lorebook']]) {
        for (const entity of database[field] || []) entity.id = replacement(kind, entity.id);
    }
    if (database.personaEnabledModules && typeof database.personaEnabledModules === 'object') {
        const assignments = Object.create(null);
        for (const [personaId, ids] of Object.entries(database.personaEnabledModules)) {
            assignments[replacement('persona', personaId)] = modules(ids);
        }
        database.personaEnabledModules = assignments;
    }
}

function sourceRevision(sourceRoot, database, assetIndex) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(database));
    for (const [logicalKey, entry] of Object.entries(assetIndex.entries).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(`\0${logicalKey}\0${JSON.stringify(entry)}`);
        for (const relative of [...entry.paths].sort()) {
            const filePath = path.resolve(sourceRoot, relative);
            const stat = fs.lstatSync(filePath, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('V2 source asset must be a regular file');
            hash.update(`\0${relative}\0${stat.size}\0${stat.mtimeNs}`);
        }
    }
    return hash.digest('hex');
}

function importedAssetKey(original, occupied) {
    const extension = /^\.[a-z0-9]{1,8}$/i.test(path.posix.extname(original)) ? path.posix.extname(original).toLowerCase() : '';
    for (;;) {
        const candidate = `assets/import-${crypto.randomUUID()}${extension}`;
        if (!occupied.has(candidate)) { occupied.add(candidate); return candidate; }
    }
}

function assertRegularSource(sourceRoot, sourcePath) {
    const relative = path.relative(sourceRoot, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Imported asset escapes the V2 source root');
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Imported asset must be a regular file');
    return { sourcePath, sourceRoot };
}

function createV2ItemImportService({ targetRoot, failAfterPublish }) {
    const target = path.resolve(targetRoot);
    if (!isNamedRoot(target)) throw new Error('Current data root is not using the RisuBard V2 layout');

    function inspect(sourcePath) {
        const sourceRoot = validateRoot(sourcePath, target);
        const database = loadReadOnlyDatabase(sourceRoot);
        const items = catalog(database);
        const sourceAssets = readOwnedAssetIndex(sourceRoot);
        const dependencies = dependencyMap(items, database);
        const revision = sourceRevision(sourceRoot, database, sourceAssets);
        return { sourceRoot, database, items, dependencies, sourceAssets, revision };
    }

    function preview(sourcePath) {
        const state = inspect(sourcePath);
        return {
            sourceRoot: state.sourceRoot,
            formatVersion: 2,
            revision: state.revision,
            items: [...state.items.values()].map(item => itemSummary(item, state.dependencies.get(item.identity) || [])),
        };
    }

    function execute({ sourceRoot: sourcePath, revision, selection, onProgress }) {
        const state = inspect(sourcePath);
        if (revision !== undefined && revision !== state.revision) throw new Error('V2 source changed after preview; check the items again');
        if (!Array.isArray(selection) || selection.length === 0) throw new Error('Select at least one V2 item');
        const selected = new Map();
        const requested = new Set();
        const add = identity => {
            const item = state.items.get(identity);
            if (!item) throw new Error('Selected V2 item is missing from the source');
            if (selected.has(identity)) return;
            selected.set(identity, item);
            for (const dependency of state.dependencies.get(identity) || []) add(dependency.identity);
        };
        for (const value of selection) {
            const identity = key(value?.kind, value?.id);
            requested.add(identity);
            add(identity);
        }

        const targetRepository = createUserDataRepository({ dataRoot: target });
        const targetDatabase = targetRepository.exportLegacyDatabase();
        const targetCatalog = catalog(targetDatabase);
        const incoming = Object.fromEntries(TYPES.map(type => [type.field, []]));
        incoming.personaEnabledModules = Object.create(null);
        const idReplacements = new Map();
        for (const item of selected.values()) {
            const entity = structuredClone(item.entity);
            incoming[item.field].push(entity);
            if (item.kind === 'persona' && Array.isArray(state.database.personaEnabledModules?.[item.id])) {
                incoming.personaEnabledModules[item.id] = structuredClone(state.database.personaEnabledModules[item.id]);
            }
            if (targetCatalog.has(item.identity)) {
                idReplacements.set(item.identity, crypto.randomUUID());
            }
        }
        rewriteTypedIds(incoming, idReplacements);

        const sourceAssets = state.sourceAssets;
        const targetAssets = readOwnedAssetIndex(target);
        const sourceKeys = new Set(Object.keys(sourceAssets.entries));
        const occupied = new Set(Object.keys(targetAssets.entries));
        const referenced = collectReferences(incoming, sourceKeys);
        const assetReplacements = new Map();
        const sourceAssetKeys = new Map();
        for (const original of referenced.keys()) {
            const destination = occupied.has(original) ? importedAssetKey(original, occupied) : original;
            if (destination !== original) assetReplacements.set(original, destination);
            sourceAssetKeys.set(destination, original);
            occupied.add(destination);
        }
        if (assetReplacements.size) rewriteReferences(incoming, assetReplacements);

        const readAsset = logicalKey => {
            if (sourceAssetKeys.has(logicalKey)) {
                const source = getOwnedAssetSource(state.sourceRoot, sourceAssetKeys.get(logicalKey), sourceAssets);
                return source ? assertRegularSource(state.sourceRoot, source) : null;
            }
            const existing = getOwnedAssetSource(target, logicalKey, targetAssets);
            return existing ? { sourcePath: existing, sourceRoot: target } : null;
        };
        targetRepository.importLegacyDatabase(incoming, {
            mode: 'merge',
            strictAssets: true,
            allAssetKeys: [...occupied],
            readAsset,
            onProgress,
            checkSpace: true,
            rollbackOnFailure: true,
            ...(Number.isInteger(failAfterPublish) ? { failAfterPublish } : {}),
        });

        return {
            ok: true,
            imported: Object.fromEntries(TYPES.map(type => [type.count, incoming[type.field].length])),
            remappedIds: Object.fromEntries([...idReplacements].map(([identity, replacement]) => [identity.replace('\0', ':'), replacement])),
            includedDependencies: selected.size - requested.size,
        };
    }

    return { preview, execute };
}

module.exports = { createV2ItemImportService };
