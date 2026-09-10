'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    atomicWriteJson,
    commitTransaction,
    moveToTrash,
    readVerifiedJson,
    recoverTransactions,
    resolveInside,
} = require('./file-store.cjs');

const COLLECTIONS = [
    ['botPresets', 'presets'],
    ['modules', 'modules'],
    ['personas', 'personas'],
    ['loreBook', 'lorebooks'],
];
const ENTITY_ORDER_PATH = 'settings/entity-order.json';

function isSidebarIndex(value) {
    return isPlainObject(value) && value.schemaVersion === 1
        && Array.isArray(value.characters) && isPlainObject(value.collections)
        && value.characters.every(character => typeof character?.id === 'string'
            && Array.isArray(character.chats) && character.chats.every(chat => typeof chat?.id === 'string'))
        && Object.values(value.collections).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'));
}

const SECRET_NAME = /(?:key|token|secret|password|credential|privateKey|clientEmail|accessToken|refresh_token)/i;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsSecret(value) {
    if (Array.isArray(value)) return value.some(containsSecret);
    if (!isPlainObject(value)) return false;
    return Object.entries(value).some(([key, child]) => SECRET_NAME.test(key) || containsSecret(child));
}

function splitSecrets(source) {
    const settings = {};
    const secrets = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (SECRET_NAME.test(key) || (Array.isArray(value) && containsSecret(value))) {
            secrets[key] = value;
        } else if (isPlainObject(value)) {
            const nested = splitSecrets(value);
            if (Object.keys(nested.settings).length || !Object.keys(value).length) settings[key] = nested.settings;
            if (Object.keys(nested.secrets).length) secrets[key] = nested.secrets;
        } else {
            settings[key] = value;
        }
    }
    return { settings, secrets };
}

function deepMerge(base, incoming) {
    const result = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(incoming || {})) {
        result[key] = isPlainObject(value) && isPlainObject(result[key])
            ? deepMerge(result[key], value)
            : value;
    }
    return result;
}

function mergeById(existing, incoming) {
    const merged = new Map((existing || []).map(item => [item.id, item]));
    for (const item of incoming || []) merged.set(item.id, item);
    return [...merged.values()];
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stableId(value, prefix) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return raw;
    if (raw) return `${prefix}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
    return `${prefix}-${crypto.randomUUID()}`;
}

function without(source, names) {
    const result = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (!names.has(key)) result[key] = value;
    }
    return result;
}

function validateImport(database, mode, previousIndex) {
    if (!isPlainObject(database)) throw new Error('Legacy database must be an object');
    const fields = ['characters', ...COLLECTIONS.map(([legacy]) => legacy)];
    for (const field of fields) {
        const hasExisting = field === 'characters' || previousIndex?.collections?.[field]?.length > 0;
        if (((mode === 'sync' && hasExisting) || field in database) && !Array.isArray(database[field])) {
            throw new Error(`Incomplete database: missing or invalid ${field}`);
        }
    }
    const checkIds = (items, key, prefix, label) => {
        const ids = new Set();
        for (const item of items || []) {
            if (!isPlainObject(item)) throw new Error(`Invalid ${label} entity`);
            const raw = key(item);
            if (!raw) continue; // Legacy import assigns IDs to entries that predate them.
            const id = stableId(raw, prefix).toLowerCase(); // Windows paths are case insensitive.
            if (ids.has(id)) throw new Error(`Duplicate ${label} ID`);
            ids.add(id);
        }
    };
    for (const [legacy, directory] of COLLECTIONS) {
        checkIds(database[legacy], item => item.id, directory.slice(0, -1), legacy);
    }
    checkIds(database.characters, item => item.chaId || item.id, 'character', 'character');
    for (const character of database.characters || []) {
        if (!Array.isArray(character.chats)) throw new Error('Incomplete character: missing chats');
        checkIds(character.chats, item => item.id, 'chat', 'chat');
        for (const chat of character.chats) {
            if (chat._stub === true || !Array.isArray(chat.message)) {
                throw new Error('Incomplete chat: hydrate messages before saving canonical files');
            }
        }
    }
}

function createLegacyUserDataRepository(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    if (!options.readOnly) {
        fs.mkdirSync(dataRoot, { recursive: true });
        recoverTransactions(dataRoot);
    }

    function rebuildSidebarIndex() {
        const order = fs.existsSync(path.join(dataRoot, ENTITY_ORDER_PATH))
            ? readVerifiedJson(dataRoot, ENTITY_ORDER_PATH, { validate: isSidebarIndex }) : null;
        const entries = (directory) => {
            const target = resolveInside(dataRoot, directory);
            if (!fs.existsSync(target)) return [];
            return fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        };
        const orderedEntries = (directory, names, isDirectory) => {
            const found = entries(directory).filter(entry => isDirectory ? entry.isDirectory()
                : entry.isFile() && entry.name.endsWith('.json'));
            if (!names) return found;
            const byName = new Map(found.map(entry => [entry.name, entry]));
            return names.map(name => {
                if (!byName.has(name)) throw new Error(`Missing canonical entity: ${directory}/${name}`);
                return byName.get(name);
            });
        };
        const collections = {};
        for (const [legacy, directory] of COLLECTIONS) {
            collections[legacy] = orderedEntries(directory, order?.collections[legacy]?.map(id => `${id}.json`), false).map(entry => {
                const entity = readJson(path.join(directory, entry.name));
                if (!entity.id || `${stableId(entity.id, directory.slice(0, -1))}.json` !== entry.name) {
                    throw new Error(`Canonical entity ID does not match its path: ${directory}/${entry.name}`);
                }
                return stableId(entity.id, directory.slice(0, -1));
            });
        }
        const characters = orderedEntries('characters', order?.characters.map(character => character.id), true).map(entry => {
            const character = loadCharacter(entry.name);
            if (stableId(character.chaId, 'character') !== entry.name) throw new Error('Canonical character ID does not match its path');
            const chatOrder = order?.characters.find(character => character.id === entry.name)?.chats.map(chat => chat.id);
            const chats = orderedEntries(path.join('characters', entry.name, 'chats'), chatOrder, true).map(chat => {
                const metadata = readJson(chatMetadataPath(entry.name, chat.name));
                if (stableId(metadata.id, 'chat') !== chat.name) throw new Error('Canonical chat ID does not match its path');
                // Do not read bodies during index recovery, but do not hide missing data either.
                fs.statSync(resolveInside(dataRoot, messagesPath(entry.name, chat.name)));
                return { id: chat.name, name: metadata.name || '', lastDate: metadata.lastDate ?? 0 };
            });
            return { id: entry.name, name: character.name || '', updatedAt: 0, chats };
        });
        const index = { schemaVersion: 1, updatedAt: Date.now(), characters, collections };
        if (!options.readOnly && (characters.length || Object.values(collections).some(ids => ids.length)
            || fs.existsSync(path.join(dataRoot, 'settings', 'app.json')))) {
            atomicWriteJson(dataRoot, 'index/sidebar.json', index);
        }
        return index;
    }

    function loadSidebarIndex(options = {}) {
        const indexPath = path.join(dataRoot, 'index', 'sidebar.json');
        if (!fs.existsSync(indexPath)) {
            return rebuildSidebarIndex();
        }
        try {
            return readVerifiedJson(dataRoot, 'index/sidebar.json', { ...options, validate: isSidebarIndex });
        } catch (error) {
            // Only repair a derived catalog; never hide IO errors or corrupt entity bodies.
            if (fs.existsSync(path.join(dataRoot, ENTITY_ORDER_PATH))
                && (error instanceof SyntaxError || /validation failed|checksum mismatch/.test(error.message))) {
                return rebuildSidebarIndex();
            }
            throw error;
        }
    }

    function getProjectionRevision() {
        const indexPath = path.join(dataRoot, 'index', 'sidebar.json');
        const index = loadSidebarIndex({ acceptExternalChanges: true });
        if (!fs.existsSync(indexPath)) return null;
        const relativePaths = new Set([
            'index/sidebar.json',
            'settings/app.json',
            'secrets/credentials.json',
            ENTITY_ORDER_PATH,
        ]);
        for (const [legacyName, directory] of COLLECTIONS) {
            for (const id of index.collections?.[legacyName] || []) {
                relativePaths.add(path.join(directory, `${stableId(id, directory.slice(0, -1))}.json`));
            }
        }
        for (const character of index.characters || []) {
            const characterId = stableId(character?.id, 'character');
            relativePaths.add(path.join('characters', characterId, 'metadata.json'));
            for (const chat of character?.chats || []) {
                const chatId = stableId(chat?.id, 'chat');
                relativePaths.add(chatMetadataPath(characterId, chatId));
                relativePaths.add(messagesPath(characterId, chatId));
            }
        }

        const revision = crypto.createHash('sha256');
        for (const relativePath of [...relativePaths].sort()) {
            const normalizedPath = relativePath.split(path.sep).join('/');
            const target = resolveInside(dataRoot, relativePath);
            try {
                const stat = fs.statSync(target, { bigint: true });
                revision.update(`${normalizedPath}\0${stat.size}\0${stat.mtimeNs}\n`);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                revision.update(`${normalizedPath}\0missing\n`);
            }
        }
        return revision.digest('hex');
    }

    function readJson(relativePath, options = {}) {
        return readVerifiedJson(dataRoot, relativePath, {
            ...options,
            validate: isPlainObject,
        });
    }

    function loadCharacter(characterId, options = {}) {
        const id = stableId(characterId, 'character');
        return readJson(path.join('characters', id, 'metadata.json'), options);
    }

    function messagesPath(characterId, chatId) {
        return path.join('characters', stableId(characterId, 'character'), 'chats', stableId(chatId, 'chat'), 'messages.jsonl');
    }

    function chatMetadataPath(characterId, chatId) {
        return path.join('characters', stableId(characterId, 'character'), 'chats', stableId(chatId, 'chat'), 'metadata.json');
    }

    function loadMessages(characterId, chatId) {
        const relativePath = messagesPath(characterId, chatId);
        const target = resolveInside(dataRoot, relativePath);
        const text = fs.readFileSync(target, 'utf8');
        return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
            try { return JSON.parse(line); }
            catch { throw new Error(`Invalid chat JSONL at ${relativePath}:${index + 1}`); }
        });
    }

    function loadChat(characterId, chatId, options = {}) {
        const metadata = readJson(chatMetadataPath(characterId, chatId), options);
        return { ...metadata, message: loadMessages(characterId, chatId) };
    }

    function appendMessage(characterId, chatId, message) {
        if (!message || typeof message !== 'object') throw new Error('Chat message must be an object');
        const target = resolveInside(dataRoot, messagesPath(characterId, chatId));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(target, 'a', 0o600);
        try {
            fs.writeSync(fd, `${JSON.stringify(message)}\n`, null, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    function commitUserMessage(characterId, chatId, message) {
        appendMessage(characterId, chatId, message);
        return message;
    }

    function draftPath(characterId, chatId) {
        return path.join('characters', stableId(characterId, 'character'), 'chats', stableId(chatId, 'chat'), 'draft.json');
    }

    function saveAssistantDraft(characterId, chatId, message) {
        atomicWriteJson(dataRoot, draftPath(characterId, chatId), message, {
            validate: value => value && typeof value === 'object',
        });
    }

    function loadAssistantDraft(characterId, chatId) {
        const relativePath = draftPath(characterId, chatId);
        if (!fs.existsSync(resolveInside(dataRoot, relativePath))) return null;
        return readJson(relativePath);
    }

    function finalizeAssistantDraft(characterId, chatId) {
        const relativePath = draftPath(characterId, chatId);
        const draft = loadAssistantDraft(characterId, chatId);
        if (!draft) return null;
        appendMessage(characterId, chatId, draft);
        moveToTrash(dataRoot, relativePath);
        return draft;
    }

    function importLegacyDatabase(database, importOptions = {}) {
        const mode = importOptions.mode || 'merge';
        if (!['merge', 'replace', 'sync'].includes(mode)) throw new Error('Import mode must be merge or replace');
        const previousIndex = loadSidebarIndex();
        validateImport(database, mode, previousIndex);

        const excluded = new Set(['characters', ...COLLECTIONS.map(([legacy]) => legacy)]);
        const incoming = splitSecrets(without(database, excluded));
        const previousSettings = fs.existsSync(path.join(dataRoot, 'settings', 'app.json')) ? readJson('settings/app.json') : {};
        const previousSecrets = fs.existsSync(path.join(dataRoot, 'secrets', 'credentials.json')) ? readJson('secrets/credentials.json') : {};
        const settings = mode === 'merge' ? deepMerge(previousSettings, incoming.settings) : incoming.settings;
        const secrets = mode === 'merge' ? deepMerge(previousSecrets, incoming.secrets) : incoming.secrets;

        const operations = [
            { path: 'settings/app.json', data: jsonBytes({ schemaVersion: 1, ...settings }) },
            { path: 'secrets/credentials.json', data: jsonBytes({ schemaVersion: 1, ...secrets }) },
        ];
        const collections = {};
        for (const [legacyName, directory] of COLLECTIONS) {
            const values = Array.isArray(database[legacyName]) ? database[legacyName] : [];
            const incomingIds = [];
            for (const item of values) {
                const id = stableId(item?.id, directory.slice(0, -1));
                incomingIds.push(id);
                operations.push({ path: path.join(directory, `${id}.json`), data: jsonBytes({ ...item, id: item.id || id }) });
            }
            collections[legacyName] = mode === 'merge'
                ? [...new Set([...(previousIndex.collections?.[legacyName] || []), ...incomingIds])]
                : incomingIds;
        }

        const characters = [];
        for (const rawCharacter of Array.isArray(database.characters) ? database.characters : []) {
            const characterId = stableId(rawCharacter?.chaId || rawCharacter?.id, 'character');
            const chats = [];
            for (const rawChat of Array.isArray(rawCharacter?.chats) ? rawCharacter.chats : []) {
                const chatId = stableId(rawChat?.id, 'chat');
                const metadata = without(rawChat, new Set(['message']));
                operations.push({
                    path: chatMetadataPath(characterId, chatId),
                    data: jsonBytes({ ...metadata, id: rawChat.id || chatId }),
                });
                const messages = Array.isArray(rawChat?.message) ? rawChat.message : [];
                operations.push({
                    path: messagesPath(characterId, chatId),
                    data: Buffer.from(messages.map(message => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''), 'utf8'),
                });
                chats.push({ id: chatId, name: rawChat?.name || '', lastDate: rawChat?.lastDate ?? 0 });
            }
            const metadata = without(rawCharacter, new Set(['chats']));
            operations.push({
                path: path.join('characters', characterId, 'metadata.json'),
                data: jsonBytes({ ...metadata, chaId: rawCharacter.chaId || rawCharacter.id || characterId }),
            });
            const previousCharacter = previousIndex.characters.find(item => item.id === characterId);
            characters.push({
                id: characterId,
                name: rawCharacter?.name || '',
                updatedAt: Date.now(),
                chats: mode === 'merge' ? mergeById(previousCharacter?.chats, chats) : chats,
            });
        }

        const sidebarCharacters = mode === 'merge' ? mergeById(previousIndex.characters, characters) : characters;
        const sidebar = { schemaVersion: 1, updatedAt: Date.now(), characters: sidebarCharacters, collections };
        // Array positions are user state (active preset/chat selections still use them).
        // Keep membership and order outside the disposable sidebar cache.
        operations.push({ path: ENTITY_ORDER_PATH, data: jsonBytes({
            schemaVersion: 1,
            characters: sidebarCharacters.map(character => ({ id: character.id,
                chats: character.chats.map(chat => ({ id: chat.id })) })),
            collections,
        }) });
        operations.push({ path: 'index/sidebar.json', data: jsonBytes(sidebar) });
        commitTransaction(dataRoot, operations);

        if (mode !== 'merge') {
            for (const [legacyName, directory] of COLLECTIONS) {
                const retained = new Set(collections[legacyName]);
                for (const id of previousIndex.collections?.[legacyName] || []) {
                    const relativePath = path.join(directory, `${id}.json`);
                    if (!retained.has(id) && fs.existsSync(resolveInside(dataRoot, relativePath))) moveToTrash(dataRoot, relativePath);
                }
            }
            const retainedCharacters = new Map(characters.map(item => [item.id, item]));
            for (const previousCharacter of previousIndex.characters) {
                const retained = retainedCharacters.get(previousCharacter.id);
                if (!retained) {
                    const relativePath = path.join('characters', previousCharacter.id);
                    if (fs.existsSync(resolveInside(dataRoot, relativePath))) moveToTrash(dataRoot, relativePath);
                    continue;
                }
                const retainedChats = new Set(retained.chats.map(chat => chat.id));
                for (const previousChat of previousCharacter.chats || []) {
                    const relativePath = path.join('characters', previousCharacter.id, 'chats', previousChat.id);
                    if (!retainedChats.has(previousChat.id) && fs.existsSync(resolveInside(dataRoot, relativePath))) moveToTrash(dataRoot, relativePath);
                }
            }
        }
        return { mode, characters: characters.length, files: operations.length };
    }

    function loadCollection(directory, ids, options = {}) {
        return (ids || []).map(id => readJson(path.join(directory, `${stableId(id, directory.slice(0, -1))}.json`), options));
    }

    function exportLegacyDatabase(exportOptions = {}) {
        const readOptions = { acceptExternalChanges: exportOptions.acceptExternalChanges === true };
        const settings = fs.existsSync(path.join(dataRoot, 'settings', 'app.json')) ? readJson('settings/app.json', readOptions) : {};
        const secrets = fs.existsSync(path.join(dataRoot, 'secrets', 'credentials.json')) ? readJson('secrets/credentials.json', readOptions) : {};
        const { schemaVersion: _settingsSchema, ...plainSettings } = settings;
        const { schemaVersion: _secretsSchema, ...plainSecrets } = secrets;
        const index = loadSidebarIndex(readOptions);
        const database = deepMerge(plainSettings, plainSecrets);
        for (const [legacyName, directory] of COLLECTIONS) {
            database[legacyName] = loadCollection(directory, index.collections?.[legacyName], readOptions);
        }
        database.characters = index.characters.map(summary => {
            const character = loadCharacter(summary.id, readOptions);
            return { ...character, chats: summary.chats.map(chat => loadChat(summary.id, chat.id, readOptions)) };
        });
        return database;
    }

    // Recover the disposable catalog before db.cjs decides whether a cache can be rebuilt.
    loadSidebarIndex();
    return {
        dataRoot,
        appendMessage,
        commitUserMessage,
        exportLegacyDatabase,
        finalizeAssistantDraft,
        getProjectionRevision,
        importLegacyDatabase,
        loadAssistantDraft,
        loadCharacter,
        loadChat,
        loadMessages,
        loadSidebarIndex,
        rebuildSidebarIndex,
        saveAssistantDraft,
    };
}

function createUserDataRepository(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    const { isNamedRoot, createNamedUserDataRepository } = require('./named-user-data-repository.cjs');
    if (!options.readOnly) {
        fs.mkdirSync(dataRoot, { recursive: true });
        recoverTransactions(dataRoot);
    } else if (!fs.statSync(dataRoot).isDirectory()) {
        throw new Error('Read-only data root must be a directory');
    }
    let legacy, named;
    const legacyFactory = () => legacy ||= createLegacyUserDataRepository({ ...options, dataRoot });
    const namedFactory = () => named ||= createNamedUserDataRepository({ ...options, dataRoot, legacyFactory });
    const current = () => isNamedRoot(dataRoot) ? namedFactory() : legacyFactory();
    const repository = { dataRoot };
    for (const method of ['appendMessage', 'commitUserMessage', 'exportLegacyDatabase', 'finalizeAssistantDraft',
        'getProjectionRevision', 'loadAssistantDraft', 'loadCharacter', 'loadChat', 'loadMessages',
        'loadSidebarIndex', 'rebuildSidebarIndex', 'saveAssistantDraft']) {
        repository[method] = (...args) => current()[method](...args);
    }
    repository.importLegacyDatabase = (...args) => (options.formatVersion === 2 || isNamedRoot(dataRoot) ? namedFactory() : legacyFactory()).importLegacyDatabase(...args);
    current().loadSidebarIndex();
    return repository;
}

module.exports = { createUserDataRepository, stableId, validateImport, splitSecrets, deepMerge };
