'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInside } = require('./file-store.cjs');
const { MAIN_FILES } = require('./named-entity-codec.cjs');
const FIELDS = {
    character: ['chaId', 'name', 'image', 'type', 'trashTime', 'lastInteraction', 'creation_date', 'chatPage', 'chatFolders', 'modules'],
    module: ['id', 'name', 'mcp', 'description'],
    chat: ['id', 'name', 'lastDate', 'folderId', 'modules'],
};

// Read-only UI hints, deliberately NOT document envelopes or save baselines.
// Catalog paths are server-validated before this function is called.
function readNativeSummaries({ dataRoot, catalog, targets }) {
    const root = path.resolve(dataRoot);
    function invalid(message, statusCode = 400) {
        throw Object.assign(new Error(message), { statusCode, code: 'INVALID_NATIVE_SUMMARY' });
    }
    return { summaries: targets.map(target => {
        if (!target || !Object.hasOwn(FIELDS, target.kind) || typeof target.id !== 'string' || !target.id) invalid('Invalid summary target');
        let folder;
        if (target.kind === 'module') {
            if (catalog.collections.modules.includes(target.id)) folder = catalog.paths.modules[target.id];
        } else {
            const character = catalog.characters.find(item => item.id === (target.kind === 'chat' ? target.parentId : target.id));
            folder = target.kind === 'character' ? character?.path : character?.chats.find(item => item.id === target.id)?.path;
        }
        if (!folder) invalid('Summary target is absent from catalog', 404);
        const relative = `${folder.replace(/\\/g, '/')}/${MAIN_FILES[target.kind]}`;
        let current = root;
        for (const part of [null, ...relative.split('/')]) {
            if (part !== null) current = path.join(current, part);
            if (fs.lstatSync(current).isSymbolicLink()) invalid('Summary path contains a symbolic link');
        }
        const document = JSON.parse(fs.readFileSync(resolveInside(root, relative), 'utf8'));
        const idField = target.kind === 'character' ? 'chaId' : 'id';
        if (!document || document[idField] !== target.id) invalid('Summary ID mismatch');
        const value = Object.fromEntries(FIELDS[target.kind].filter(field => Object.hasOwn(document, field)).map(field => [field, document[field]]));
        if (target.kind === 'module') {
            // The module picker displays this one mapped text field. Do not
            // decode the rest of the module (lorebooks, scripts or asset lists).
            const descriptionPath = resolveInside(root, `${folder.replace(/\\/g, '/')}/description.md`);
            try {
                const stat = fs.lstatSync(descriptionPath);
                if (!stat.isFile() || stat.isSymbolicLink()) invalid('Invalid module description file');
                value.description = fs.readFileSync(descriptionPath, 'utf8');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return { target, value, summary: true };
    }) };
}

module.exports = { readNativeSummaries };
