'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { inventory, needsMigration } = require('./v2-migration-gate.cjs');
const { planMigration } = require('./v2-migration-plan.cjs');
const { atomicWriteJson, fsyncDirectory, commitTransaction } = require('./file-store.cjs');

async function inspectMigration(root) {
    const workspace = fs.mkdtempSync(`${root}.v2-stage-`);
    try {
        const plan = await planMigration(root, workspace);
        return { sourceBytes: plan.before.reduce((sum, entry) => sum + (typeof entry[1] === 'number' ? entry[1] : 0), 0),
            outputBytes: plan.outputBytes, requiredBytes: plan.requiredBytes };
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}

async function migrate(root, backup, options = {}) {
    root = fs.realpathSync(root);
    const lock = `${root}.v2-lock`;
    if (fs.existsSync(lock)) {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('이관 잠금 기록을 확인해야 합니다: ' + lock);
        try { process.kill(pid, 0); throw new Error('다른 이관 작업이 실행 중입니다.'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd);
        if (!needsMigration(root)) return { alreadyMigrated: true };
        return await migrateLocked(root, backup, options);
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

async function migrateLocked(root, backup, options) {
    if (root === path.dirname(root)) throw new Error('A filesystem root cannot be migrated');
    const parent = path.dirname(root), prefix = path.join(parent, 'backups', `${path.basename(root)}.v1-`);
    if (!backup.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(backup.slice(prefix.length)) || fs.existsSync(backup)) throw new Error('Invalid migration backup destination');
    const workspace = fs.mkdtempSync(`${root}.v2-stage-`), stage = `${workspace}-output`;
    const journal = `${root}.v2-swap.json`;
    let prepared = false;
    const phase = name => options.onPhase?.(name);
    try {
        phase('checking');
        const plan = await planMigration(root, workspace);
        const checkSpace = required => {
            const stats = (options.statfs || fs.statfsSync)(parent);
            if (Number(stats.bavail) * Number(stats.bsize) < required) throw new Error('V2 파일 생성에 필요한 디스크 여유 공간이 부족합니다. 원본은 변경하지 않았습니다.');
        };
        checkSpace(plan.remainingBytes);
        fs.mkdirSync(stage);
        phase('convert');
        // Stage each output once, then rename it into the empty V2 tree.
        let remaining = plan.remainingBytes;
        commitTransaction(stage, plan.operations, {
            sourceRoot: root,
            onProgress(event) {
                if (event.phase === 'staging') {
                    if (event.current > 0) {
                        const op = plan.operations[event.current - 1];
                        remaining -= op.sourcePath ? fs.statSync(op.sourcePath).size : op.data.length;
                    }
                    checkSpace(Math.max(0, remaining));
                }
                options.onProgress?.(event);
            },
        });
        phase('verify');
        const { createUserDataRepository } = require('./user-data-repository.cjs');
        const repo = createUserDataRepository({ dataRoot: stage, formatVersion: 2 });
        if (!isDeepStrictEqual(plan.database, repo.exportLegacyDatabase())) throw new Error('V2 round-trip verification failed');
        const { readOwnedAssetIndex, getOwnedAssetSource } = require('./owned-assets.cjs');
        const index = readOwnedAssetIndex(stage);
        for (const key of Object.keys(index.entries)) getOwnedAssetSource(stage, key, index);
        const { createFileKv } = require('./file-kv.cjs');
        const store = createFileKv({ dataRoot: stage });
        for (const key of store.kvList()) if (store.kvGet(key) == null) throw new Error('Missing data after conversion');
        if (!isDeepStrictEqual(plan.database, createUserDataRepository({ dataRoot: stage, formatVersion: 2 }).exportLegacyDatabase())) throw new Error('Reopen verification failed');
        atomicWriteJson(stage, 'settings/native-runtime.json', { schemaVersion: 1, mode: 'native-documents' });
        atomicWriteJson(stage, 'migration/v2-completed.json', { schemaVersion: 1, backupPath: backup, completedAt: Date.now(), outputBytes: plan.outputBytes });
        for (const entry of inventory(stage).reverse()) if (entry[1] === 'directory') fsyncDirectory(path.join(stage, entry[0]));
        options.beforePublish?.();
        if (!isDeepStrictEqual(plan.before, inventory(root, true))) throw new Error('기존 저장소가 이관 중 변경되었습니다. 다른 서버와 편집기를 종료한 뒤 다시 시도하세요.');
        phase('publish');
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        if (fs.realpathSync(path.dirname(backup)) !== path.dirname(backup)) throw new Error('Backup directory must not be a link');
        const state = { root, backup, stage, id: backup.slice(prefix.length) };
        atomicWriteJson(parent, path.basename(journal), state);
        prepared = true;
        fs.renameSync(root, backup);
        fsyncDirectory(parent);
        fsyncDirectory(path.dirname(backup));
        try { fs.renameSync(stage, root); }
        catch (error) { fs.renameSync(backup, root); throw error; }
        fsyncDirectory(parent);
        fs.unlinkSync(journal);
        return { backup, outputBytes: plan.outputBytes };
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        if (!prepared && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    }
}

module.exports = { migrate, inspectMigration };
if (require.main === module) {
    let finished = false;
    process.on('disconnect', () => { if (!finished) process.exit(1); });
    const task = process.argv[4] === '--inspect'
        ? inspectMigration(process.argv[2]).then(inspection => process.send?.({ inspection }))
        : migrate(process.argv[2], process.argv[3], { onPhase: phase => process.send?.({ phase }) });
    task.then(() => { finished = true; process.disconnect?.(); }).catch(error => {
        finished = true; process.send?.({ error: error.message }); console.error(error.message);
        process.exitCode = 1; process.disconnect?.();
    });
}
