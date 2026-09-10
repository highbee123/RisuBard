'use strict';

const path = require('path');
const { checksum } = require('./file-store.cjs');
const { collectReferences } = require('./owned-assets.cjs');
const GROUPS = [['botPresets', 'prompt'], ['modules', 'module'], ['personas', 'persona'], ['loreBook', 'lorebook'], ['characters', 'character']];
const SCOPED = /^assets\/owned-([a-f0-9]{16})-([a-f0-9]{64})(\.[a-z0-9]{1,8})?$/;
const token = (kind, id) => checksum(Buffer.from(JSON.stringify([kind, id]))).slice(0, 16);

function databaseOwners(database) {
    return GROUPS.flatMap(([field, kind]) => (database[field] || []).map((entity, index) => ({ field, index, kind, id: kind === 'character' ? entity.chaId : entity.id, entity })));
}

function previousDatabaseOwners(index) {
    if (index?.schemaVersion !== 2) return [];
    return GROUPS.flatMap(([field, kind]) => field === 'characters'
        ? index.characters.map(c => ({ kind, id: c.id, folder: c.path }))
        : (index.collections[field] || []).map(id => ({ kind, id, folder: index.paths[field][id] })));
}

function rewriteReferences(value, replacements, seen = new WeakSet()) {
    if (typeof value === 'string') {
        const direct = replacements.get(value.replace(/\\/g, '/'));
        if (direct) return direct;
        // Replace complete local references only. URLs, prefixes and suffixes
        // outside the scanner's token boundary are never substring-rewritten.
        return value.replace(/(^|[^A-Za-z0-9_:/.-])(assets[\/\\][^\s"'<>\\)\],}]+)(?=$|[\s"'<>\\)\],}])/g,
            (whole, prefix, key) => replacements.has(key.replace(/\\/g, '/')) ? prefix + replacements.get(key.replace(/\\/g, '/')) : whole);
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    if (value instanceof Map) for (const [key, child] of value) value.set(key, rewriteReferences(child, replacements, seen));
    else if (value instanceof Set) { const children = [...value]; value.clear(); for (const child of children) value.add(rewriteReferences(child, replacements, seen)); }
    else for (const key of Object.keys(value)) value[key] = rewriteReferences(value[key], replacements, seen);
    return value;
}

// Pure normalization: callers retain their original database. The source plan
// separately preserves each existing owner's bytes until the transaction commits.
function normalizeOwnerAssetReferences(database, { previousIndex = { schemaVersion: 2, entries: {} }, previousOwners = [], allAssetKeys = [] } = {}) {
    const normalized = structuredClone(database);
    const owners = databaseOwners(normalized);
    const known = new Set([...Object.keys(previousIndex.entries), ...allAssetKeys]);
    const globals = Object.fromEntries(Object.entries(normalized).filter(([field]) => !GROUPS.some(([name]) => name === field)));
    const selectedPersona = Number.isInteger(normalized.selectedPersona) && normalized.selectedPersona >= 0
        ? normalized.personas?.[normalized.selectedPersona] : null;
    const projectsPersonaIcon = typeof selectedPersona?.icon === 'string' && selectedPersona.icon === normalized.userIcon;
    // userIcon is the selected persona's display projection (changeUserPersona),
    // unless the user has supplied a different custom global avatar.
    if (projectsPersonaIcon) delete globals.userIcon;
    const globalReferences = collectReferences(globals, known);
    const references = owners.map(owner => collectReferences(owner.entity, known));
    const counts = new Map();
    references.forEach(refs => { for (const key of refs.keys()) counts.set(key, (counts.get(key) || 0) + 1); });
    const previous = structuredClone(previousIndex);
    const aliases = new Map(), consumed = new Set();
    const remembered = new Map();
    for (const [key, entry] of Object.entries(previousIndex.entries)) {
        if (entry.owner && entry.sourceKey) remembered.set(`${token(entry.owner.kind, entry.owner.id)}:${entry.sourceKey}`, key);
    }
    owners.forEach((owner, i) => {
        const identity = token(owner.kind, owner.id);
        const replacements = new Map();
        for (const key of references[i].keys()) {
            const scoped = key.match(SCOPED);
            const priorKey = remembered.get(`${identity}:${key}`);
            const needsScope = counts.get(key) > 1 || globalReferences.has(key) || previousIndex.entries[key]?.paths.length > 1 || (scoped && scoped[1] !== identity) || priorKey;
            if (!needsScope && !scoped) continue;
            const sourceKey = previousIndex.entries[key]?.sourceKey || key;
            const ext = path.posix.extname(key).toLowerCase();
            const destination = priorKey || (scoped?.[1] === identity ? key : `assets/owned-${identity}-${scoped?.[2] || checksum(Buffer.from(key))}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`);
            if (destination !== key) replacements.set(key, destination);
            const oldOwner = previousOwners.find(item => item.kind === owner.kind && item.id === owner.id);
            const folder = oldOwner?.folder?.replace(/\\/g, '/');
            const ownPath = previousIndex.entries[destination]?.paths[0] || previousIndex.entries[key]?.paths.find(relative => folder && path.posix.dirname(relative) === `${folder}/assets`);
            aliases.set(destination, { sourceKey: priorKey || key, originalKey: sourceKey, owner: { kind: owner.kind, id: owner.id }, path: ownPath });
            if (ownPath) previous.entries[destination] = { paths: [ownPath], owner: { kind: owner.kind, id: owner.id }, sourceKey };
            if (destination !== key && !globalReferences.has(key) && !(scoped && owners.some(item => token(item.kind, item.id) === scoped[1]))) consumed.add(key);
        }
        if (replacements.size) {
            // A direct JS caller may have shallow-cloned an entity. Detach its
            // graph before rewriting so shared nested objects keep owner scope.
            normalized[owner.field][owner.index] = rewriteReferences(structuredClone(owner.entity), replacements);
        }
    });
    if (projectsPersonaIcon) normalized.userIcon = normalized.personas[normalized.selectedPersona].icon;
    for (const key of consumed) delete previous.entries[key];
    // If a global reference survives, it owns its shared file; owner files are
    // now assigned to their distinct keys. Its bytes still resolve via readAsset.
    for (const key of globalReferences.keys()) {
        // Selected-persona avatars intentionally reference that persona's scoped
        // file. The global projection must retain its owner's source mapping.
        if (aliases.get(key)?.sourceKey === key) continue;
        if (previous.entries[key] && [...aliases.values()].some(alias => alias.sourceKey === key)) {
            const paths = previous.entries[key].paths.filter(relative => path.posix.dirname(relative) === 'shared/assets');
            if (paths.length) previous.entries[key] = { ...previous.entries[key], paths };
            else delete previous.entries[key];
        }
    }
    return { database: normalized, previousIndex: previous, aliases, consumedAssetKeys: [...consumed] };
}

module.exports = { normalizeOwnerAssetReferences, databaseOwners, previousDatabaseOwners, rewriteReferences };
