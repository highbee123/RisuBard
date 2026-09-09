'use strict';

const fs = require('fs');
const path = require('path');
const { checksum, checksumFile, readVerifiedJson } = require('./file-store.cjs');

const ASSET_INDEX_PATH = 'settings/asset-files.json';
const fileChecksums = new Map();
const MAX_CACHED_FILES = 262144;

function fileSignature(filePath) {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) throw new Error(`Owned asset source is not a file: ${filePath}`);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// Each lookup still checks current disk metadata. Including inode and ctime
// catches same-size replacements and edits that restore the original mtime.
function checksumOwnedAssetFile(filePath, expectedChecksum) {
    const target = path.resolve(filePath);
    let digest;
    for (let attempt = 0; attempt < 2; attempt++) {
        const signature = fileSignature(target);
        const cached = fileChecksums.get(target);
        if (cached?.signature === signature) {
            digest = cached.digest;
            break;
        }
        const current = checksumFile(target);
        if (fileSignature(target) !== signature) continue;
        if (!fileChecksums.has(target) && fileChecksums.size >= MAX_CACHED_FILES) {
            fileChecksums.delete(fileChecksums.keys().next().value);
        }
        fileChecksums.set(target, { signature, digest: current });
        digest = current;
        break;
    }
    if (!digest) throw new Error(`Owned asset changed while computing checksum: ${filePath}`);
    if (expectedChecksum !== undefined && digest !== expectedChecksum) {
        throw new Error(`Asset source checksum mismatch: ${filePath}`);
    }
    return digest;
}

function safePath(root, relative, options = {}) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || relative.startsWith('/')) {
        throw new Error(`Unsafe owned asset path: ${relative}`);
    }
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error(`Unsafe owned asset path: ${relative}`);
    let current = path.resolve(root);
    const checked = options.checkedPaths;
    const pathParts = options.checkLeaf === false ? parts.slice(0, -1) : parts;
    for (const part of [null, ...pathParts]) {
        if (part !== null) current = path.join(current, part);
        const cacheKey = process.platform === 'win32' ? current.toLowerCase() : current;
        if (checked?.has(cacheKey)) continue;
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Owned asset path contains a symbolic link: ${relative}`);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        checked?.add(cacheKey);
    }
    return current;
}

function logicalKey(value) {
    const key = value.replace(/\\/g, '/');
    if (!key.startsWith('assets/') || key.split('/').some(part => !part || part === '.' || part === '..') || /[:\0]/.test(key)) {
        throw new Error(`Invalid logical asset key: ${value}`);
    }
    return key;
}

function references(value, explicit = false, knownKeys = new Set()) {
    if (typeof value !== 'string') return [];
    const normalized = value.replace(/\\/g, '/');
    function candidate(value, strict = false) {
        if (!strict && !knownKeys.has(value) && /[\s\[\]{}()+*?|^$]/.test(value)) return [];
        try { return [logicalKey(value)]; }
        catch (error) { if (strict) throw error; return []; }
    }
    if (normalized.startsWith('assets/') && !/[\r\n<>"']/.test(normalized)) return candidate(normalized, explicit);
    // Matches in prose or source code are only suggestions. Regex fragments
    // must not abort an otherwise valid save or become invented asset keys.
    return [...normalized.matchAll(/(?:^|[^A-Za-z0-9_:/.-])(assets\/[^\s"'<>\\)\],}]+)(?=$|[\s"'<>\\)\],}])/g)]
        .flatMap(match => candidate(match[1]));
}

function collectReferences(entity, knownKeys) {
    const result = new Map();
    const seen = new WeakSet();
    const visit = (value, label = '', explicit = false) => {
        if (typeof value === 'string') {
            for (const key of references(value, explicit, knownKeys)) if (!result.has(key)) result.set(key, label || path.posix.basename(key));
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            // Emotion/module/additional-asset tuples use their first field as the display name.
            if (explicit && typeof value[0] === 'string' && !references(value[0], false, knownKeys).length
                && typeof value[1] === 'string' && references(value[1], true, knownKeys).length) {
                visit(value[1], value[0], true);
                for (const child of value.slice(2)) visit(child, label);
            } else for (const child of value) visit(child, label, explicit);
        } else if (value instanceof Map) {
            for (const [key, child] of value) visit(child, String(key), explicit);
        } else if (value instanceof Set) {
            for (const child of value) visit(child, label, explicit);
        } else {
            // Prefer descriptive structured references before free text duplicates.
            for (const field of ['image', 'icon', 'emotionImages', 'additionalAssets', 'assets', 'ccAssets']) {
                if (Object.hasOwn(value, field)) visit(value[field], field === 'image' ? 'portrait' : field, true);
            }
            for (const [field, child] of Object.entries(value)) {
                if (['image', 'icon', 'emotionImages', 'additionalAssets', 'assets', 'ccAssets'].includes(field)) continue;
                // This is a denylist of legacy asset identifiers, not a list of
                // files owned by the character. Deleted entries are valid here.
                if (field === 'prebuiltAssetExclude') continue;
                visit(child, field === 'uri' ? (value.name || value.type || label) : field, field === 'uri');
            }
        }
    };
    visit(entity);
    return result;
}

function readableName(value) {
    let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
    name = [...name].slice(0, 40).join('');
    if (!name) name = 'asset';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name;
}

function extension(key, bytes) {
    const original = path.posix.extname(key).toLowerCase();
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return '.gif';
    if (bytes.subarray(0, 4).toString() === 'RIFF') return bytes.subarray(8, 12).toString() === 'WEBP' ? '.webp' : bytes.subarray(8, 12).toString() === 'WAVE' ? '.wav' : '.bin';
    if (bytes.subarray(4, 8).toString() === 'ftyp') return /avif|avis/.test(bytes.subarray(8, 32).toString()) ? '.avif' : '.mp4';
    if (bytes.subarray(0, 4).toString() === 'OggS') return '.ogg';
    if (bytes.subarray(0, 3).toString() === 'ID3') return '.mp3';
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 512).toString())) return '.svg';
    return /^\.[a-z0-9]{1,8}$/.test(original) ? original : '.bin';
}

function validateIndexShape(index) {
    if (!index || index.schemaVersion !== 2 || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) throw new Error('Invalid owned asset index');
    return index;
}

function validateIndex(root, index) {
    validateIndexShape(index);
    const assigned = new Map();
    const checkedParents = new Set();
    for (const [key, entry] of Object.entries(index.entries)) {
        logicalKey(key);
        if (!entry || !Array.isArray(entry.paths) || !entry.paths.length) throw new Error(`Invalid owned asset mapping: ${key}`);
        for (const relative of entry.paths) {
            // The index pass validates every destination and all shared parent
            // directories. Individual files are checked when they are read or
            // written, avoiding tens of thousands of redundant lstat calls.
            safePath(root, relative, { checkLeaf: false, checkedPaths: checkedParents });
            if (!/(?:^|\/)assets\/[^/]+$/.test(relative)) throw new Error(`Invalid owned asset location: ${relative}`);
            const folded = relative.toLowerCase();
            if (assigned.has(folded) && assigned.get(folded) !== key) throw new Error(`Owned asset path collision: ${relative}`);
            assigned.set(folded, key);
        }
    }
    return index;
}

function readOwnedAssetIndexFile(dataRoot, validate) {
    safePath(dataRoot, ASSET_INDEX_PATH);
    try { return validate(readVerifiedJson(dataRoot, ASSET_INDEX_PATH)); }
    catch (error) {
        if (error.code === 'ENOENT') {
            if (fs.existsSync(safePath(dataRoot, 'settings/layout.json'))) {
                throw new Error('Missing canonical asset index for named-folder layout', { cause: error });
            }
            return { schemaVersion: 2, entries: {} };
        }
        throw error;
    }
}

function readOwnedAssetIndex(dataRoot) {
    return readOwnedAssetIndexFile(dataRoot, index => validateIndex(dataRoot, index));
}

// Interactive reads validate only the requested entry in assetMapping(). Full
// validation remains mandatory for migrations and every mutating operation.
function readOwnedAssetIndexForLookup(dataRoot) {
    return readOwnedAssetIndexFile(dataRoot, validateIndexShape);
}

function assetMapping(dataRoot, key, index) {
    const current = index === undefined ? readOwnedAssetIndex(dataRoot) : index;
    if (!current || current.schemaVersion !== 2 || !current.entries || typeof current.entries !== 'object' || Array.isArray(current.entries)) throw new Error('Invalid owned asset index');
    const mapping = current.entries[logicalKey(key)];
    if (mapping && (!Array.isArray(mapping.paths) || !mapping.paths.length)) throw new Error(`Invalid owned asset mapping: ${key}`);
    for (const relative of mapping?.paths ?? []) {
        safePath(dataRoot, relative);
        if (!/(?:^|\/)assets\/[^/]+$/.test(relative)) throw new Error(`Invalid owned asset location: ${relative}`);
    }
    return mapping;
}

function getOwnedAssetSource(dataRoot, key, index) {
    const mapping = assetMapping(dataRoot, key, index);
    if (!mapping) return null;
    const versions = new Map();
    for (const relative of mapping.paths) {
        const sourcePath = safePath(dataRoot, relative);
        let current;
        try { current = checksumOwnedAssetFile(sourcePath); }
        catch (error) { throw new Error(`Missing or unreadable owned asset ${key}: ${relative}`, { cause: error }); }
        versions.set(current, sourcePath);
    }
    if (versions.size === 1) return versions.values().next().value;
    // The saved checksum is the common baseline. One distinct external edit
    // wins over unchanged replicas; two differing edits require user resolution.
    if (mapping.checksum) versions.delete(mapping.checksum);
    if (versions.size === 1) return versions.values().next().value;
    throw new Error(`Conflicting owned asset copies for ${key}: ${mapping.paths.join(', ')}`);
}

function readOwnedAsset(dataRoot, key, index) {
    const source = getOwnedAssetSource(dataRoot, key, index);
    return source === null ? null : fs.readFileSync(source);
}

function ownedAssetOperationsForWrite(dataRoot, key, bytes, index) {
    const mapping = assetMapping(dataRoot, key, index);
    if (!mapping) return [];
    const data = Buffer.from(bytes);
    return mapping.paths.map(relative => ({ path: relative, data, checksumSidecar: false }));
}

function planOwnedAssets({ dataRoot, sourceRoot = dataRoot, owners = [], database, readAsset, previousIndex, allAssetKeys = [], strict = false }) {
    const previous = previousIndex === undefined ? readOwnedAssetIndex(dataRoot) : validateIndex(dataRoot, previousIndex);
    const knownKeys = new Set([...Object.keys(previous.entries), ...allAssetKeys].map(logicalKey));
    const index = { schemaVersion: 2, entries: Object.create(null) };
    const operations = [];
    const targets = new Map();
    const used = new Map();
    for (const [key, entry] of Object.entries(previous.entries)) for (const relative of entry.paths) used.set(relative.toLowerCase(), key);
    for (const owner of owners) {
        const folder = owner.folder.replace(/\\/g, '/');
        safePath(dataRoot, folder);
        for (const [key, label] of collectReferences(owner.entity, knownKeys)) {
            if (!targets.has(key)) targets.set(key, new Map());
            targets.get(key).set(`${folder}/assets`, label);
        }
    }
    const remaining = new Set([...collectReferences(database, knownKeys).keys(), ...allAssetKeys]);
    for (const value of remaining) {
        const key = logicalKey(value);
        if (!targets.has(key)) targets.set(key, new Map([['shared/assets', path.posix.basename(key)]]));
    }
    for (const [key, destinations] of targets) {
        const source = readAsset(key);
        if (source === null || source === undefined) {
            if (strict || previous.entries[key]) throw new Error(`Missing referenced asset: ${key}`);
            continue;
        }
        let data;
        let sourcePath;
        let operationSourceRoot = sourceRoot;
        let hasOperationSourceRoot = false;
        let digest;
        let header;
        if (source && typeof source.sourcePath === 'string') {
            hasOperationSourceRoot = typeof source.sourceRoot === 'string';
            operationSourceRoot = source.sourceRoot || sourceRoot;
            const relative = path.relative(path.resolve(operationSourceRoot), path.resolve(source.sourcePath)).split(path.sep).join('/');
            sourcePath = safePath(operationSourceRoot, relative);
            digest = checksumOwnedAssetFile(sourcePath, source.checksum);
        } else {
            if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error(`Asset reader must return bytes or a sourcePath synchronously: ${key}`);
            data = Buffer.from(source);
            digest = checksum(data);
            header = data;
        }
        const paths = [];
        for (const [directory, label] of destinations) {
            let relative = previous.entries[key]?.paths.find(candidate => path.posix.dirname(candidate) === directory);
            if (!relative) {
                if (!header) {
                    header = Buffer.alloc(512);
                    const fd = fs.openSync(sourcePath, 'r');
                    try { header = header.subarray(0, fs.readSync(fd, header, 0, header.length, 0)); }
                    finally { fs.closeSync(fd); }
                }
                const ext = extension(key, header);
                const base = readableName(label.endsWith(ext) ? label.slice(0, -ext.length) : label);
                for (let suffix = 1; ; suffix++) {
                    const candidate = `${directory}/${base}${suffix === 1 ? '' : `-${suffix}`}${ext}`;
                    const target = safePath(dataRoot, candidate);
                    if (!used.has(candidate.toLowerCase()) && !fs.existsSync(target)) { relative = candidate; break; }
                }
            }
            used.set(relative.toLowerCase(), key);
            paths.push(relative);
            const target = safePath(dataRoot, relative);
            let unchanged = false;
            try { unchanged = checksumOwnedAssetFile(target) === digest; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!unchanged) operations.push(sourcePath
                ? { path: relative, sourcePath, checksumSidecar: false, ...(hasOperationSourceRoot ? { sourceRoot: operationSourceRoot } : {}) }
                : { path: relative, data, checksumSidecar: false });
        }
        index.entries[key] = { paths, checksum: digest };
    }
    return { operations, index };
}

module.exports = { ASSET_INDEX_PATH, planOwnedAssets, readOwnedAssetIndex, readOwnedAssetIndexForLookup, readOwnedAsset, getOwnedAssetSource, ownedAssetOperationsForWrite, checksumOwnedAssetFile, collectReferences };
