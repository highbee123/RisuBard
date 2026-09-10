'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { inventory } = require('./v2-migration-gate.cjs');
const { checksumFile, fsyncDirectory } = require('./file-store.cjs');

function backupDestination(root, requested) {
    if (typeof requested !== 'string' || !path.isAbsolute(requested.trim())) throw new Error('백업을 보관할 기존 폴더의 절대 경로를 입력하세요.');
    const parent = fs.realpathSync(requested.trim());
    if (!fs.statSync(parent).isDirectory()) throw new Error('백업 위치는 폴더여야 합니다.');
    const source = fs.realpathSync(root);
    const relative = path.relative(source, parent);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('현재 저장소 내부에는 백업을 만들 수 없습니다. 다른 폴더를 지정하세요.');
    }
    return { source, parent };
}

function createLocalBackup(root, requested, options = {}) {
    const { source, parent } = backupDestination(root, requested);
    const before = inventory(source, true);
    const bytes = before.reduce((sum, e) => sum + (typeof e[1] === 'number' ? e[1] : 0), 0);
    let remaining = bytes + before.length * 8192 + 16 * 1024 * 1024;
    const checkSpace = () => {
        const stat = (options.statfs || fs.statfsSync)(parent);
        if (Number(stat.bavail) * Number(stat.bsize) < remaining) throw new Error('백업을 만들 여유 공간이 부족합니다. 원본은 변경하지 않았습니다.');
    };
    checkSpace();
    const stage = fs.mkdtempSync(path.join(parent, '.risubard-backup-incomplete-'));
    const data = path.join(stage, 'data');
    const final = path.join(parent, `RisuBard-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
    let published = false;
    try {
        let copied = 0;
        for (const [relative, size, , hash] of before) {
            const target = path.join(data, relative);
            if (size === 'directory') { fs.mkdirSync(target, { recursive: true }); continue; }
            checkSpace();
            const original = path.join(source, relative);
            if (fs.lstatSync(original).isSymbolicLink()) throw new Error('백업 중 원본 경로가 변경되었습니다.');
            fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
            const fd = fs.openSync(target, 'r+');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if (checksumFile(target) !== hash) throw new Error('백업 파일 검증에 실패했습니다.');
            copied += size; remaining -= size;
            options.onProgress?.({ copiedBytes: copied, totalBytes: bytes });
        }
        options.beforeVerify?.();
        if (!isDeepStrictEqual(before, inventory(source, true))) throw new Error('백업 중 원본이 변경되었습니다. 다른 서버와 편집기를 종료하고 다시 시도하세요.');
        const info = { schemaVersion: 1, format: 'original-data-folder', sourcePath: source, createdAt: new Date().toISOString(), bytes,
            instructions: '이 백업은 .bin 파일이 아닌 원본 저장 폴더 사본입니다. 서버를 종료하고 data 폴더를 별도 위치에 복사한 뒤 해당 경로를 RISUBARD_DATA_ROOT로 지정해 실행하세요. 기존 저장소 위에 덮어쓰지 마세요.' };
        const fd = fs.openSync(path.join(stage, 'backup-info.json'), 'wx');
        try { fs.writeFileSync(fd, JSON.stringify(info, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        for (const e of inventory(stage).reverse()) if (e[1] === 'directory') fsyncDirectory(path.join(stage, e[0]));
        fs.renameSync(stage, final); published = true; fsyncDirectory(parent);
        return { path: path.join(final, 'data'), infoPath: path.join(final, 'backup-info.json'), bytes, completedAt: info.createdAt };
    } finally {
        if (!published) fs.rmSync(stage, { recursive: true, force: true });
    }
}

module.exports = { backupDestination, createLocalBackup };
if (require.main === module) {
    let finished = false;
    process.on('disconnect', () => { if (!finished) process.exit(1); });
    try {
        let last = -1;
        const result = createLocalBackup(process.argv[2], process.argv[3], { onProgress(progress) {
            const pct = Math.floor(progress.copiedBytes / Math.max(1, progress.totalBytes) * 100);
            if (pct !== last) { last = pct; process.send?.({ progress }); }
        } });
        finished = true; process.send?.({ result }); process.disconnect?.();
    } catch (error) { finished = true; process.send?.({ error: error.message }); process.exitCode = 1; process.disconnect?.(); }
}
