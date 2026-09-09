'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function checksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function checksumFile(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function resolveInside(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
        throw new Error('Canonical file path must be a non-empty relative path');
    }
    const rootPath = path.resolve(root);
    const target = path.resolve(rootPath, relativePath);
    const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
    if (target !== rootPath && !target.startsWith(prefix)) {
        throw new Error('Canonical file path escapes the data root');
    }
    return target;
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function writeSynced(filePath, data) {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
        let offset = 0;
        while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function copySynced(source, destination) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(destination, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function replaceAtomic(target, data) {
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    writeSynced(temp, data);
    try {
        fs.renameSync(temp, target);
        fsyncDirectory(directory);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
    }
}

function preserveBackup(target) {
    if (!fs.existsSync(target)) return;
    const backup = `${target}.bak`;
    const temp = `${backup}.${crypto.randomUUID()}.tmp`;
    copySynced(target, temp);
    fs.renameSync(temp, backup);
    fsyncDirectory(path.dirname(backup));
}

function atomicWriteFile(root, relativePath, value, options = {}) {
    const target = resolveInside(root, relativePath);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (options.validate && options.validate(data) !== true) {
        throw new Error(`Canonical file validation failed: ${relativePath}`);
    }

    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    writeSynced(temp, data);
    const staged = fs.readFileSync(temp);
    const digest = checksum(data);
    if (checksum(staged) !== digest) {
        fs.unlinkSync(temp);
        throw new Error(`Canonical file checksum verification failed: ${relativePath}`);
    }

    try {
        preserveBackup(target);
        fs.renameSync(temp, target);
        replaceAtomic(`${target}.sha256`, Buffer.from(`${digest}\n`, 'utf8'));
        fsyncDirectory(directory);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
    }
    return { path: target, checksum: digest, bytes: data.length };
}

function atomicWriteJson(root, relativePath, value, options = {}) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return atomicWriteFile(root, relativePath, bytes, {
        ...options,
        validate: (candidate) => {
            let parsed;
            try { parsed = JSON.parse(candidate.toString('utf8')); } catch { return false; }
            return options.validate ? options.validate(parsed) === true : true;
        },
    });
}

function readVerifiedJson(root, relativePath, options = {}) {
    const target = resolveInside(root, relativePath);
    const bytes = fs.readFileSync(target);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (options.validate && options.validate(parsed) !== true) {
        throw new Error(`Canonical file validation failed: ${relativePath}`);
    }
    const checksumPath = `${target}.sha256`;
    if (fs.existsSync(checksumPath)) {
        const expected = fs.readFileSync(checksumPath, 'utf8').trim();
        if (expected && checksum(bytes) !== expected) {
            if (!options.acceptExternalChanges) {
                throw new Error(`Canonical file checksum mismatch: ${relativePath}`);
            }
            if (options.persistChecksum !== false) {
                replaceAtomic(checksumPath, Buffer.from(`${checksum(bytes)}\n`, 'utf8'));
            }
        }
    }
    return parsed;
}

function writeJournal(journalPath, value) {
    replaceAtomic(journalPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function stageRollbackState(target, stageDir, index) {
    const capture = (filePath, label) => {
        if (!fs.existsSync(filePath)) return null;
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Transaction rollback only supports regular files');
        const snapshot = path.join(stageDir, `${index}.${label}.rollback`);
        copySynced(filePath, snapshot);
        return snapshot;
    };
    return {
        target: capture(target, 'target'),
        checksum: capture(`${target}.sha256`, 'checksum'),
        backup: capture(`${target}.bak`, 'backup'),
    };
}

function restoreRollbackFile(target, snapshot) {
    if (snapshot === null) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        return;
    }
    const temp = `${target}.${crypto.randomUUID()}.rollback`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copySynced(snapshot, temp);
    try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.renameSync(temp, target);
        fsyncDirectory(path.dirname(target));
    } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
    }
}

function rollbackTransaction(root, journal) {
    for (const entry of [...journal.entries].reverse()) {
        const target = resolveInside(root, entry.path);
        if (entry.archiveTo) {
            const archive = resolveInside(root, entry.archiveTo);
            if (!fs.existsSync(archive)) continue;
            if (fs.existsSync(target)) throw new Error(`Cannot roll back archived path: ${entry.path}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(archive, target);
            fsyncDirectory(path.dirname(target));
            fsyncDirectory(path.dirname(archive));
            continue;
        }
        if (!entry.rollback) continue;
        restoreRollbackFile(target, entry.rollback.target);
        restoreRollbackFile(`${target}.sha256`, entry.rollback.checksum);
        restoreRollbackFile(`${target}.bak`, entry.rollback.backup);
    }
}

function validateRetirementPaths(root, entry) {
    const source = entry.path.replace(/\\/g, '/');
    const replacement = typeof entry.replacementPath === 'string' ? entry.replacementPath.replace(/\\/g, '/') : '';
    if (!/^[a-f0-9]{64}$/.test(entry.retireIfChecksum)
        || !/^shared\/assets\/[^/]+$/.test(source)
        || /\.(?:bak|sha256)$/i.test(source)
        || !/^(?:characters|personas|modules|prompts|lorebooks)\/[^/]+\/assets\/[^/]+$/.test(replacement)) {
        throw new Error('Invalid asset retirement operation');
    }
    for (const relative of [source, replacement]) {
        const parts = relative.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || /[:\0]|[. ]$/.test(part))) throw new Error('Unsafe asset retirement path');
        let current = path.resolve(root);
        for (const part of [null, ...parts]) {
            if (part !== null) current = path.join(current, part);
            try {
                if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Asset retirement paths cannot contain symbolic links');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        resolveInside(root, relative);
    }
}

function retirementFileState(root, relative, allowMissing = false) {
    const target = resolveInside(root, relative);
    let stat;
    try { stat = fs.lstatSync(target, { bigint: true }); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Asset retirement requires regular files');
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function verifyRetirementFile(root, relative, digest, allowMissing = false) {
    const before = retirementFileState(root, relative, allowMissing);
    if (before === null) return false;
    if (checksumFile(resolveInside(root, relative)) !== digest || retirementFileState(root, relative) !== before) {
        throw new Error(`Asset retirement checksum mismatch: ${relative}`);
    }
    return true;
}

function publishTransaction(root, journal, options = {}) {
    let published = 0;
    let processed = 0;
    const reportProgress = () => options.onProgress?.({
        phase: 'publishing',
        current: (options.progressOffset || 0) + ++processed,
        total: options.progressTotal || journal.entries.length,
    });
    for (const entry of journal.entries) {
        const target = resolveInside(root, entry.path);
        if (entry.retireIfChecksum !== undefined) {
            validateRetirementPaths(root, entry);
            verifyRetirementFile(root, entry.replacementPath, entry.retireIfChecksum);
            if (verifyRetirementFile(root, entry.path, entry.retireIfChecksum, true)) {
                fs.unlinkSync(target);
                // Revisions and siblings are deliberately untouched. A stale
                // checksum sidecar is tiny and cannot resurrect the image.
                fsyncDirectory(path.dirname(target));
            }
            published += 1;
            reportProgress();
            if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
            continue;
        }
        if (entry.archiveTo) {
            const archive = resolveInside(root, entry.archiveTo);
            // The archive is the durable completion marker. Never move a newly
            // published directory again when replaying the same transaction.
            if (!fs.existsSync(archive)) {
                fs.mkdirSync(path.dirname(archive), { recursive: true });
                fs.renameSync(target, archive);
                fsyncDirectory(path.dirname(target));
                fsyncDirectory(path.dirname(archive));
            }
            published += 1;
            reportProgress();
            if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
            continue;
        }
        if (fs.existsSync(target) && checksumFile(target) === entry.checksum) {
            // A crash may have published data but not its checksum sidecar yet.
            const sidecar = `${target}.sha256`;
            if (!fs.existsSync(sidecar) || fs.readFileSync(sidecar, 'utf8').trim() !== entry.checksum) {
                replaceAtomic(sidecar, Buffer.from(`${entry.checksum}\n`, 'utf8'));
            }
            reportProgress();
            continue;
        }
        if (!fs.existsSync(entry.staged)) {
            throw new Error(`Transaction stage is missing for ${entry.path}`);
        }
        preserveBackup(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(entry.staged, target);
        if (entry.checksumSidecar === false) {
            try { fs.unlinkSync(`${target}.sha256`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
            replaceAtomic(`${target}.sha256`, Buffer.from(`${entry.checksum}\n`, 'utf8'));
        }
        fsyncDirectory(path.dirname(target));
        published += 1;
        reportProgress();
        if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
    }
}

function cleanupJournal(journalPath, stageDir) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
    fsyncDirectory(path.dirname(journalPath));
}

function commitTransaction(root, operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) return { committed: 0 };
    const progressTotal = operations.length * 2;
    options.onProgress?.({ phase: 'staging', current: 0, total: progressTotal });
    const journalDir = resolveInside(root, '.journal');
    fs.mkdirSync(journalDir, { recursive: true });
    if (fs.readdirSync(journalDir).some(name => name.endsWith('.json'))) {
        throw new Error('Storage recovery required before another transaction');
    }
    const id = crypto.randomUUID();
    const stageDir = path.join(journalDir, `${id}.stage`);
    fs.mkdirSync(stageDir, { recursive: true });
    let entries;
    try {
        entries = operations.map((operation, index) => {
        const prepared = value => {
            options.onProgress?.({ phase: 'staging', current: index + 1, total: progressTotal });
            return value;
        };
        resolveInside(root, operation.path);
        if (operation.retireIfChecksum !== undefined) {
            if (operation.archiveTo || operation.data !== undefined || operation.sourcePath) throw new Error('Conflicting asset retirement operation');
            validateRetirementPaths(root, operation);
            verifyRetirementFile(root, operation.path, operation.retireIfChecksum);
            retirementFileState(root, operation.replacementPath, true);
            return prepared({ path: operation.path, retireIfChecksum: operation.retireIfChecksum, replacementPath: operation.replacementPath,
                ...(options.rollbackOnFailure ? { rollback: stageRollbackState(resolveInside(root, operation.path), stageDir, index) } : {}) });
        }
        if (operation.archiveTo) {
            resolveInside(root, operation.archiveTo);
            if (!operation.archiveTo.startsWith(`trash${path.sep}`) && !operation.archiveTo.startsWith('trash/')) {
                throw new Error('Transaction archives must be inside trash');
            }
            if (fs.existsSync(resolveInside(root, operation.archiveTo))) throw new Error('Import archive already exists');
            const sourceStat = fs.lstatSync(resolveInside(root, operation.path));
            if (!sourceStat.isDirectory() && !sourceStat.isFile()) throw new Error('Only regular files or directories can be archived');
            return prepared({ path: operation.path, archiveTo: operation.archiveTo });
        }
        const staged = path.join(stageDir, `${index}.data`);
        let digest;
        if (operation.sourcePath) {
            const sourceRoot = operation.sourceRoot || options.sourceRoot || root;
            const sourcePath = resolveInside(sourceRoot, path.relative(sourceRoot, operation.sourcePath));
            if (operation.validate) {
                throw new Error(`Transaction file validation is unsupported: ${operation.path}`);
            }
            digest = checksumFile(sourcePath);
            copySynced(sourcePath, staged);
        } else {
            const data = Buffer.isBuffer(operation.data) ? operation.data : Buffer.from(operation.data);
            if (operation.validate && operation.validate(data) !== true) {
                throw new Error(`Transaction validation failed: ${operation.path}`);
            }
            writeSynced(staged, data);
            digest = checksum(data);
        }
        if (checksumFile(staged) !== digest) throw new Error(`Transaction checksum failed: ${operation.path}`);
        return prepared({ path: operation.path, staged, checksum: digest,
            ...(operation.checksumSidecar === false ? { checksumSidecar: false } : {}),
            ...(options.rollbackOnFailure ? { rollback: stageRollbackState(resolveInside(root, operation.path), stageDir, index) } : {}) });
        });
        for (const entry of entries.filter(item => item.retireIfChecksum !== undefined)) {
            const normalized = value => path.resolve(root, value).toLowerCase();
            if (entries.some(other => other !== entry && normalized(other.path) === normalized(entry.path))) throw new Error('Conflicting asset retirement target');
            const replacement = entries.findLast(other => normalized(other.path) === normalized(entry.replacementPath));
            if (replacement) {
                if (replacement.checksum !== entry.retireIfChecksum) throw new Error('Asset retirement replacement checksum mismatch');
            } else verifyRetirementFile(root, entry.replacementPath, entry.retireIfChecksum);
        }
        // Publish the replacement and all manifests before unlinking the old
        // upload. Prepared journals replay this same durable ordering.
        entries.sort((a, b) => Number(a.retireIfChecksum !== undefined) - Number(b.retireIfChecksum !== undefined));
        // Document CAS runs after staging and before any durable journal can
        // publish these bytes. A rejected snapshot uses the same stage cleanup.
        if (options.beforePrepare) options.beforePrepare();
    } catch (error) {
        // No prepared journal exists yet, so none of these bytes can be
        // replayed. Do not accumulate multi-gigabyte orphan staging folders.
        fs.rmSync(stageDir, { recursive: true, force: true });
        throw error;
    }
    fsyncDirectory(stageDir);
    const journalPath = path.join(journalDir, `${id}.json`);
    const journal = { schemaVersion: 1, id, state: 'prepared', createdAt: Date.now(), entries };
    writeJournal(journalPath, journal);
    try {
        publishTransaction(root, journal, { ...options, progressOffset: operations.length, progressTotal });
    } catch (error) {
        if (!options.rollbackOnFailure) throw error;
        journal.state = 'rollback';
        writeJournal(journalPath, journal);
        try {
            rollbackTransaction(root, journal);
            cleanupJournal(journalPath, stageDir);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Transaction publication and rollback both failed');
        }
        throw error;
    }
    cleanupJournal(journalPath, stageDir);
    return { committed: entries.length };
}

function recoverTransactions(root) {
    const journalDir = resolveInside(root, '.journal');
    if (!fs.existsSync(journalDir)) return { recovered: 0 };
    const journals = fs.readdirSync(journalDir).filter(name => name.endsWith('.json')).sort();
    let recovered = 0;
    for (const name of journals) {
        const journalPath = path.join(journalDir, name);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const stageDir = path.join(journalDir, `${journal.id}.stage`);
        if (journal.state === 'rollback') rollbackTransaction(root, journal);
        else publishTransaction(root, journal);
        cleanupJournal(journalPath, stageDir);
        recovered += 1;
    }
    return { recovered };
}

function moveToTrash(root, relativePath) {
    const source = resolveInside(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`Canonical file does not exist: ${relativePath}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = resolveInside(root, path.join('trash', stamp, relativePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    for (const suffix of ['.sha256', '.bak']) {
        if (fs.existsSync(`${source}${suffix}`)) fs.renameSync(`${source}${suffix}`, `${destination}${suffix}`);
    }
    fsyncDirectory(path.dirname(source));
    fsyncDirectory(path.dirname(destination));
    return destination;
}

module.exports = {
    fsyncDirectory,
    atomicWriteFile,
    atomicWriteJson,
    checksum,
    checksumFile,
    commitTransaction,
    moveToTrash,
    readVerifiedJson,
    recoverTransactions,
    resolveInside,
};
