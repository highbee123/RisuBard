'use strict';

const fs = require('fs');
const path = require('path');
const { readVerifiedJson, resolveInside } = require('./file-store.cjs');

const MAIN_FILES = Object.freeze({
    character: 'character.json', module: 'module.json', persona: 'persona.json',
    prompt: 'settings.json', lorebook: 'lorebook.json', chat: 'metadata.json',
});
const TEXT_FIELDS = {
    character: {
        desc: 'description.md', firstMessage: 'first_mes.md', personality: 'personality.md',
        scenario: 'scenario.md', systemPrompt: 'system_prompt.md',
        postHistoryInstructions: 'post_history_instructions.md', notes: 'notes.md',
    },
    module: { description: 'description.md' },
    persona: { personaPrompt: 'persona_prompt.md', prompt: 'prompt.md', description: 'description.md' },
    chat: { note: 'note.md' },
    prompt: Object.fromEntries([
        'description', 'mainPrompt', 'jailbreak', 'globalNote', 'autoSuggestPrompt', 'autoSuggestPrefix',
        'customPromptTemplateToggle', 'templateDefaultVariables', 'instructChatTemplate',
        'JinjaTemplate', 'groupTemplate', 'systemContentReplacement',
    ].map(key => [key, `${key}.md`])),
};
const PROMPT_TEXT_FIELDS = new Set(['text', 'body', 'content', 'innerFormat']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function mainFile(kind) {
    if (!Object.hasOwn(MAIN_FILES, kind)) throw new Error(`Unknown entity kind: ${kind}`);
    return MAIN_FILES[kind];
}

function relativePath(value) {
    if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
        || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
        || /[:\x00-\x1f]/.test(value)) {
        throw new Error('Entity file path must be a safe relative path');
    }
    return value.replace(/\\/g, '/');
}

function validateFieldPath(fieldPath) {
    if (!Array.isArray(fieldPath) || !fieldPath.length || fieldPath.some(segment => (
        typeof segment === 'number' ? !Number.isSafeInteger(segment) || segment < 0
            : typeof segment !== 'string' || !segment || FORBIDDEN_KEYS.has(segment)
    ))) throw new Error('Invalid entity field path');
}

function fieldParent(entity, fieldPath) {
    let parent = entity;
    for (const segment of fieldPath.slice(0, -1)) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) {
            throw new Error('Entity field path is missing from metadata');
        }
        parent = parent[segment];
    }
    const key = fieldPath[fieldPath.length - 1];
    if (!parent || typeof parent !== 'object'
        || (Array.isArray(parent) && (typeof key !== 'number' || key >= parent.length))) {
        throw new Error('Invalid entity field path container');
    }
    return parent;
}

function encodeEntity(kind, entity, folder) {
    const filename = mainFile(kind);
    const prefix = relativePath(folder);
    const metadata = JSON.parse(JSON.stringify(entity));
    const operations = [];
    const fieldFiles = {};
    const usedNames = new Set([filename.toLowerCase(), 'manifest.json']);
    function extract(fieldPath, preferredName) {
        validateFieldPath(fieldPath);
        const parent = fieldParent(metadata, fieldPath);
        const key = fieldPath[fieldPath.length - 1];
        const value = parent[key];
        const ext = path.posix.extname(preferredName);
        const base = preferredName.slice(0, -ext.length);
        let name = preferredName;
        for (let index = 2; usedNames.has(name.toLowerCase()); index++) name = `${base}-${index}${ext}`;
        usedNames.add(name.toLowerCase());
        fieldFiles[name] = fieldPath;
        operations.push({ path: `${prefix}/${name}`, data: Buffer.from(ext === '.md' ? value : JSON.stringify(value, null, 2), 'utf8') });
        // Object containers stay intact, preserving unknown fields and array ordering.
        delete parent[key];
    }
    for (const [field, name] of Object.entries(TEXT_FIELDS[kind] || {})) {
        if (typeof metadata[field] === 'string') extract([field], name);
    }
    for (const field of ['globalLore', 'localLore', 'lorebook']) {
        if (filename !== 'lorebook.json' && Array.isArray(metadata[field])) {
            extract([field], usedNames.has('lorebook.json') ? `${field}.json` : 'lorebook.json');
        }
    }
    if (kind === 'prompt') {
        function walk(value, fieldPath) {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                const childPath = [...fieldPath, Array.isArray(value) ? Number(key) : key];
                if (typeof child === 'string' && PROMPT_TEXT_FIELDS.has(key)) {
                    const stem = childPath.map(segment => String(segment).replace(/[^\p{L}\p{N}_-]/gu, '_')).join('-');
                    extract(childPath, `${stem.slice(0, 60)}.md`);
                } else if (child && typeof child === 'object') {
                    walk(child, childPath);
                }
            }
        }
        for (const field of ['promptTemplate', 'promptV2']) walk(metadata[field], [field]);
    }
    operations.push({ path: `${prefix}/${filename}`, data: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8') });
    operations.push({ path: `${prefix}/manifest.json`, data: Buffer.from(JSON.stringify({ schemaVersion: 2, kind, fieldFiles }, null, 2), 'utf8') });
    return operations;
}

function readManifest(root, kind, folder, options) {
    const filename = mainFile(kind);
    const prefix = relativePath(folder);
    const manifest = (options.readJson || readVerifiedJson)(root, `${prefix}/manifest.json`, options);
    if (!manifest || manifest.schemaVersion !== 2 || manifest.kind !== kind
        || !manifest.fieldFiles || typeof manifest.fieldFiles !== 'object' || Array.isArray(manifest.fieldFiles)) {
        throw new Error('Invalid entity manifest');
    }
    const names = new Set([filename.toLowerCase(), 'manifest.json']);
    const fields = [];
    for (const [name, fieldPath] of Object.entries(manifest.fieldFiles)) {
        const normalized = relativePath(name);
        if (!/\.(md|json)$/.test(normalized) || names.has(normalized.toLowerCase())) {
            throw new Error('Invalid or duplicate entity manifest file path');
        }
        names.add(normalized.toLowerCase());
        validateFieldPath(fieldPath);
        if (fields.some(other => other.slice(0, Math.min(other.length, fieldPath.length)).every((segment, index) => segment === fieldPath[index]))) {
            throw new Error('Overlapping entity manifest field paths');
        }
        fields.push(fieldPath);
    }
    return { prefix, filename, manifest };
}

function decodeEntity(root, kind, folder, options = {}) {
    const { prefix, filename, manifest } = readManifest(root, kind, folder, options);
    const entity = (options.readJson || readVerifiedJson)(root, `${prefix}/${filename}`, options);
    for (const [name, fieldPath] of Object.entries(manifest.fieldFiles)) {
        const relative = `${prefix}/${relativePath(name)}`;
        const value = name.endsWith('.json') ? (options.readJson || readVerifiedJson)(root, relative, options)
            : options.readText ? options.readText(root, relative) : fs.readFileSync(resolveInside(root, relative), 'utf8');
        const parent = fieldParent(entity, fieldPath);
        parent[fieldPath[fieldPath.length - 1]] = value;
    }
    return entity;
}

function entityFiles(root, kind, folder) {
    const { prefix, filename, manifest } = readManifest(root, kind, folder, { acceptExternalChanges: true });
    return [`${prefix}/manifest.json`, `${prefix}/${filename}`, ...Object.keys(manifest.fieldFiles).map(name => `${prefix}/${relativePath(name)}`)];
}

module.exports = { MAIN_FILES, encodeEntity, decodeEntity, entityFiles };
