'use strict';

// Offline V2 recovery. Source files are only read; no storage constructor opens them.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { isDeepStrictEqual } = require('util');
const { inventory } = require('../server/node/v2-migration-gate.cjs');
const { atomicWriteJson, readVerifiedJson, checksumFile } = require('../server/node/file-store.cjs');
const { decodeEntity } = require('../server/node/named-entity-codec.cjs');
const { GROUPS } = require('../server/node/named-user-data-repository.cjs');
const { readOwnedAssetIndex, collectReferences, getOwnedAssetSource } = require('../server/node/owned-assets.cjs');

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function recoverSaveIndex(sourceArg, outputArg) {
    const source = fs.realpathSync(sourceArg);
    const requested = path.resolve(outputArg);
    const output = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
    if (inside(source, output) || inside(output, source)) throw new Error('원본과 출력은 서로 포함되지 않는 별도 경로여야 합니다.');
    fs.mkdirSync(output); // Refuse existing destinations, including previous recovery attempts.
    const candidate = path.join(output, 'candidate');
    const report = { status: 'blocked', source, sourceUnchanged: false, errors: [], warnings: [], counts: {} };
    let before;
    const issue = (file, message) => report.errors.push({ file, message });
    try {
        before = inventory(source, true); // Reject links and record every byte before copying.
        if (before.some(([file]) => /^\.journal[/\\][^/\\]+\.json$/.test(file))) {
            throw new Error('미완료 저장 journal이 있습니다. 인덱스만 교체하지 말고 저장 작업 복구를 먼저 검토하세요.');
        }
        fs.mkdirSync(candidate);
        for (const [relative, size, , hash] of before) {
            if (!relative) continue;
            const from = path.join(source, relative), to = path.join(candidate, relative);
            const stat = fs.lstatSync(from);
            if (stat.isSymbolicLink()) throw new Error('복사 도중 원본에 링크가 나타났습니다.');
            if (size === 'directory') {
                if (!stat.isDirectory()) throw new Error('복사 도중 원본 폴더가 변경되었습니다.');
                fs.mkdirSync(to);
            } else {
                if (!stat.isFile()) throw new Error('복사 도중 원본 파일이 변경되었습니다.');
                fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
                if (checksumFile(to) !== hash) throw new Error('복사본 검증 실패: 원본이 변경되었거나 디스크 오류가 있습니다.');
            }
        }
        const index = { schemaVersion: 2, updatedAt: Date.now(), characters: [], collections: {}, paths: {}, names: {} };
        const hints = [];
        for (const file of ['settings/entity-order.json', 'index/sidebar.json', 'settings/entity-order.json.bak', 'index/sidebar.json.bak']) {
            try {
                const value = readVerifiedJson(candidate, file);
                if (value?.schemaVersion === 2 && Array.isArray(value.characters) && object(value.collections)
                    && value.characters.every(item => typeof item?.id === 'string' && Array.isArray(item.chats)
                        && item.chats.every(chat => typeof chat?.id === 'string'))) hints.push(value);
            } catch { /* Hints never decide whether an actual entity is included. */ }
        }
        report.warnings.push('원래 순서가 기록에 없으면 폴더명 순서로 배치합니다. 복구 후 프롬프트·페르소나·대화 선택을 확인하세요.');
        function ordered(items, lists) {
            const ranks = new Map();
            for (const list of lists) if (Array.isArray(list)) for (const id of list) if (typeof id === 'string' && !ranks.has(id)) ranks.set(id, ranks.size);
            return items.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
        }
        function directories(relative) {
            const target = path.join(candidate, relative);
            if (!fs.existsSync(target)) return [];
            const entries = fs.readdirSync(target, { withFileTypes: true });
            for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) {
                issue(`${relative}/${entry.name}`, 'V2 항목 폴더 밖에 JSON이 있습니다. 구형 또는 혼합 저장소인지 검토하세요.');
            }
            return entries.filter(entry => entry.isDirectory()).map(entry => `${relative}/${entry.name}`).sort();
        }
        let assets;
        try {
            if (!fs.existsSync(path.join(candidate, 'settings/asset-files.json'))) throw new Error('missing-assets');
            assets = readOwnedAssetIndex(candidate);
        }
        catch { issue('settings/asset-files.json', '이미지 연결 기록이 없거나 손상되었습니다. 별도 복구가 필요합니다.'); }
        const references = new Set();
        const knownKeys = new Set(Object.keys(assets?.entries || {}));
        function collect(value) {
            for (const key of collectReferences(value, knownKeys).keys()) references.add(key);
        }
        function entity(kind, folder, ids) {
            try {
                const value = decodeEntity(candidate, kind, folder);
                const id = kind === 'character' ? value.chaId : value.id;
                if (typeof id !== 'string' || !id.trim()) throw new Error('missing-id');
                if (ids.has(id)) {
                    issue(folder, `중복 ID: ${id} (${ids.get(id)})`);
                    return null;
                }
                ids.set(id, folder);
                collect(value);
                return { value, id, name: value.name || value.title || path.posix.basename(folder), path: folder };
            } catch {
                issue(folder, '항목 JSON·manifest·본문 파일 또는 내부 ID를 검증하지 못했습니다.');
                return null;
            }
        }
        for (const [field, directory, kind] of GROUPS) {
            const ids = new Map(), found = [];
            index.paths[field] = Object.create(null);
            index.names[field] = Object.create(null);
            for (const folder of directories(directory)) {
                const item = entity(kind, folder, ids);
                if (item) found.push(item);
            }
            ordered(found, hints.map(hint => hint.collections[field]));
            index.collections[field] = found.map(item => item.id);
            for (const item of found) { index.paths[field][item.id] = item.path; index.names[field][item.id] = item.name; }
            report.counts[field] = found.length;
        }
        let chats = 0, messages = 0;
        const characterIds = new Map();
        for (const folder of directories('characters')) {
            const character = entity('character', folder, characterIds);
            if (!character) continue;
            const summary = { id: character.id, name: character.name, path: folder, chats: [] };
            const chatIds = new Map();
            for (const chatFolder of directories(`${folder}/chats`)) {
                const chat = entity('chat', chatFolder, chatIds);
                if (!chat) continue;
                const file = `${chatFolder}/messages.jsonl`;
                const input = fs.createReadStream(path.join(candidate, file));
                const lines = readline.createInterface({ input, crlfDelay: Infinity });
                let lineNumber = 0;
                try {
                    for await (const line of lines) {
                        lineNumber++;
                        if (!line.trim()) continue;
                        const message = JSON.parse(line);
                        if (!object(message)) throw new Error('invalid-message');
                        collect(message);
                        messages++;
                    }
                } catch { issue(file, `대화 본문 누락 또는 JSONL 오류 (행 ${lineNumber || 1})`); }
                finally { lines.close(); input.destroy(); }
                summary.chats.push({ id: chat.id, name: chat.name, path: chatFolder, lastDate: chat.value.lastDate ?? 0 });
                chats++;
            }
            ordered(summary.chats, hints.map(hint => hint.characters.find(item => item?.id === character.id)?.chats?.map(item => item?.id)));
            index.characters.push(summary);
        }
        ordered(index.characters, hints.map(hint => hint.characters.map(item => item?.id)));
        Object.assign(report.counts, { characters: index.characters.length, chats, messages });
        if (!index.characters.length && !Object.values(index.collections).some(ids => ids.length)) {
            issue('characters/', '복구 가능한 V2 항목이 없습니다. 구형 파일 저장소는 이 도구의 대상이 아닙니다.');
        }
        for (const file of ['settings/app.json', 'secrets/credentials.json']) {
            try {
                const value = readVerifiedJson(candidate, file);
                if (!object(value) || value.schemaVersion !== 1) throw new Error('invalid-settings');
                collect(value);
            } catch { issue(file, '필수 설정 파일이 없거나 손상되었습니다. 빈 설정으로 대체하지 않았습니다.'); }
        }
        if (fs.existsSync(path.join(candidate, 'settings/layout.json'))) {
            try {
                if (readVerifiedJson(candidate, 'settings/layout.json').schemaVersion !== 2) throw new Error('invalid-layout');
            } catch { issue('settings/layout.json', 'V2 레이아웃 표시가 손상되었거나 지원하지 않는 버전입니다.'); }
        }
        if (assets) for (const key of new Set([...Object.keys(assets.entries), ...references])) {
            try { if (!getOwnedAssetSource(candidate, key, assets)) throw new Error('missing-asset'); }
            catch { issue('settings/asset-files.json', `이미지 연결 또는 파일을 확인할 수 없습니다: ${key}`); }
        }
        // A candidate catalog is evidence, never automatically applied over source data.
        atomicWriteJson(output, 'rebuilt-index.json', index);
        if (!report.errors.length) {
            atomicWriteJson(candidate, 'settings/entity-order.json', index);
            atomicWriteJson(candidate, 'index/sidebar.json', index);
            if (!fs.existsSync(path.join(candidate, 'settings/layout.json'))) {
                atomicWriteJson(candidate, 'settings/layout.json', { schemaVersion: 2, format: 'risubard-named-folders' });
            }
            // Exercise the real native catalog validator without reassembling a giant database.bin.
            require('../server/node/native-document-store.cjs').createNativeDocumentStore({ dataRoot: candidate }).catalog();
        }
    } catch (error) { issue('', error.message); }
    try {
        report.sourceUnchanged = !!before && isDeepStrictEqual(inventory(source, true), before);
        if (!report.sourceUnchanged) issue('', '원본이 실행 중 변경되었거나 원본 검증을 완료하지 못했습니다.');
    } catch { issue('', '원본 최종 검증 실패'); }
    if (!report.errors.length) {
        const recovered = path.join(output, 'recovered');
        try {
            fs.renameSync(candidate, recovered);
            report.status = 'recovered';
            report.recoveredPath = recovered;
        } catch { issue('', '검증된 복사본의 게시에 실패했습니다. candidate 폴더는 보존했습니다.'); }
    }
    atomicWriteJson(output, 'report.json', report);
    return report;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args.some(arg => arg.startsWith('--'))) {
        console.error('사용법: node scripts/recover-save-index.cjs SOURCE NEW_OUTPUT_DIRECTORY\n서버 종료 후 실행하세요. 원본 전체 크기만큼 별도 여유 공간이 필요합니다.');
        process.exitCode = 1;
    } else recoverSaveIndex(...args).then(report => {
        console.log(JSON.stringify({ status: report.status, counts: report.counts, errors: report.errors, recoveredPath: report.recoveredPath }, null, 2));
        if (report.status !== 'recovered') process.exitCode = 1;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { recoverSaveIndex };
