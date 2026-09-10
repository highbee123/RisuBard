import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const { inventory } = require('./v2-migration-gate.cjs')
const script = path.resolve('scripts/recover-save-index.cjs')
const roots: string[] = []
afterEach(() => {
    const temporaryRoot = fs.realpathSync(os.tmpdir())
    for (const root of roots.splice(0)) {
        const resolved = fs.realpathSync(root)
        if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('rb-index-recovery-')) {
            throw new Error('Unexpected test cleanup path')
        }
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

function copyTree(source: string, target: string) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name), to = path.join(target, entry.name)
        if (entry.isDirectory()) copyTree(from, to)
        else fs.copyFileSync(from, to)
    }
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-index-recovery-'))
    roots.push(root)
    const source = path.join(root, 'source'), output = path.join(root, 'output')
    const database = {
        characters: [{ chaId: 'char-a', name: '캐릭터', desc: '원본 설명', chatPage: 1,
            chats: ['z', 'a'].map(id => ({ id, name: id, message: [{ role: 'user', data: `대화 ${id}` }] })) }],
        personas: [{ id: 'persona-a', name: '페르소나', personaPrompt: '원본 페르소나' }],
        modules: [{ id: 'module-a', name: '모듈', description: '모듈 본문' }],
        botPresets: [{ id: 'prompt-a', name: '프롬프트', mainPrompt: '프롬프트 본문' }],
        loreBook: [{ id: 'lore-a', name: '로어북', data: '로어북 본문' }],
    }
    createUserDataRepository({ dataRoot: source, formatVersion: 2 }).importLegacyDatabase(database, { mode: 'replace' })
    return { source, output, database }
}
function run(source: string, output: string) {
    let success = true
    try { execFileSync(process.execPath, [script, source, output], { stdio: 'pipe' }) }
    catch { success = false }
    const report = fs.existsSync(path.join(output, 'report.json'))
        ? JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8')) : null
    return { success, report }
}

test.each(['missing', 'empty', 'malformed'])('recovers all V2 entities from files when both catalogs are %s without changing source', state => {
    const { source, output, database } = fixture()
    for (const relative of ['index/sidebar.json', 'settings/entity-order.json']) {
        if (state === 'missing') fs.unlinkSync(path.join(source, relative))
        else if (state === 'malformed') {
            atomicWriteJson(source, relative, { schemaVersion: 2, characters: [{ id: 'char-a', chats: {} }], collections: {} })
        } else {
            const empty = { schemaVersion: 2, characters: [], collections: {}, paths: {}, names: {} }
            for (const key of ['botPresets', 'modules', 'personas', 'loreBook']) {
                (empty.collections as any)[key] = []; (empty.paths as any)[key] = {}
            }
            atomicWriteJson(source, relative, empty)
        }
    }
    // Trash is evidence only, never an active recovery source.
    fs.mkdirSync(path.join(source, 'trash/old/characters'), { recursive: true })
    copyTree(path.join(source, 'characters/캐릭터'), path.join(source, 'trash/old/characters/캐릭터'))
    const before = inventory(source, true)
    const { success, report } = run(source, output)
    expect(success).toBe(true)
    expect(report).toMatchObject({ status: 'recovered', sourceUnchanged: true, counts: { characters: 1, chats: 2, personas: 1 } })
    expect(inventory(source, true)).toEqual(before)
    const recovered = createUserDataRepository({ dataRoot: path.join(output, 'recovered') }).exportLegacyDatabase()
    expect(recovered.characters[0].desc).toBe(database.characters[0].desc)
    expect(recovered.characters[0].chats.map((c: any) => c.message[0].data).sort()).toEqual(['대화 a', '대화 z'])
    for (const field of ['personas', 'modules', 'botPresets', 'loreBook']) expect(recovered[field]).toEqual((database as any)[field])
})

test('retains a surviving order hint and scans files absent from the hint', () => {
    const { source, output } = fixture()
    fs.unlinkSync(path.join(source, 'index/sidebar.json'))
    const orderPath = path.join(source, 'settings/entity-order.json')
    const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'))
    order.collections.personas = []; order.paths.personas = {}; order.names.personas = {}
    atomicWriteJson(source, 'settings/entity-order.json', order)
    expect(run(source, output).success).toBe(true)
    const index = JSON.parse(fs.readFileSync(path.join(output, 'recovered/index/sidebar.json'), 'utf8'))
    expect(index.characters[0].chats.map((c: any) => c.id)).toEqual(['z', 'a'])
    expect(index.collections.personas).toEqual(['persona-a'])
})

test.each(['duplicate', 'missing-message', 'invalid-message', 'manifest', 'settings', 'assets', 'journal'])('reports %s and never publishes a usable recovery', failure => {
    const { source, output } = fixture()
    if (failure === 'duplicate') copyTree(path.join(source, 'personas/페르소나'), path.join(source, 'personas/복사본'))
    if (failure === 'missing-message') fs.unlinkSync(path.join(source, 'characters/캐릭터/chats/z/messages.jsonl'))
    if (failure === 'invalid-message') fs.writeFileSync(path.join(source, 'characters/캐릭터/chats/z/messages.jsonl'), '{broken')
    if (failure === 'manifest') fs.unlinkSync(path.join(source, 'personas/페르소나/manifest.json'))
    if (failure === 'settings') fs.unlinkSync(path.join(source, 'settings/app.json'))
    if (failure === 'assets') {
        fs.unlinkSync(path.join(source, 'settings/asset-files.json'))
        fs.unlinkSync(path.join(source, 'settings/layout.json'))
    }
    if (failure === 'journal') {
        fs.mkdirSync(path.join(source, '.journal'), { recursive: true })
        fs.writeFileSync(path.join(source, '.journal/pending.json'), '{}')
    }
    const before = inventory(source, true)
    const { success, report } = run(source, output)
    expect(success).toBe(false)
    expect(report?.status).toBe('blocked')
    expect(report?.errors.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(output, 'recovered'))).toBe(false)
    expect(inventory(source, true)).toEqual(before)
})

test('recovers missing layout marker from validated V2 entity manifests', () => {
    const { source, output } = fixture()
    fs.unlinkSync(path.join(source, 'settings/layout.json'))
    expect(run(source, output).success).toBe(true)
    expect(createUserDataRepository({ dataRoot: path.join(output, 'recovered') }).loadSidebarIndex().schemaVersion).toBe(2)
})

test('refuses directory links without reading or modifying their target', () => {
    const { source, output } = fixture()
    const target = path.join(path.dirname(source), 'linked-data')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep'), 'unchanged')
    fs.symlinkSync(target, path.join(source, 'linked'), 'junction')
    const result = run(source, output)
    expect(result.success).toBe(false)
    expect(result.report.status).toBe('blocked')
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('unchanged')
    expect(fs.existsSync(path.join(output, 'recovered'))).toBe(false)
})

test('rejects existing output and output inside source', () => {
    const { source, output } = fixture()
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(output, 'keep'), 'untouched')
    expect(run(source, output).success).toBe(false)
    expect(fs.readdirSync(output)).toEqual(['keep'])
    expect(run(source, path.join(source, 'nested')).success).toBe(false)
    expect(fs.existsSync(path.join(source, 'nested'))).toBe(false)
})

test.runIf(process.platform === 'win32')('Windows helper creates a recovery and a launcher that uses only the recovered data root', () => {
    const { source, output } = fixture()
    fs.unlinkSync(path.join(source, 'index/sidebar.json'))
    fs.unlinkSync(path.join(source, 'settings/entity-order.json'))
    const destination = path.join(path.dirname(source), '결과 & test !')
    fs.mkdirSync(destination)
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/recover-save.ps1'), '-NoDialogs', '-Source', source, '-DestinationParent', destination], { stdio: 'pipe' })
    const resultRoot = path.join(destination, fs.readdirSync(destination)[0])
    const configPath = path.join(resultRoot, 'recovery-launch.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
    expect(config.dataRoot).toBe(path.join(resultRoot, 'recovered'))
    expect(fs.existsSync(path.join(resultRoot, 'Start-Recovered-RisuBard.bat'))).toBe(true)

    // Use a tiny server to verify the launcher's actual process environment.
    const fakeApp = path.join(path.dirname(source), 'fake-app')
    fs.mkdirSync(path.join(fakeApp, 'server/node'), { recursive: true })
    fs.writeFileSync(path.join(fakeApp, 'server/node/server.cjs'),
        'require("fs").writeFileSync(process.env.RECOVERY_TEST_OUTPUT, process.env.RISUBARD_DATA_ROOT)')
    config.appRoot = fakeApp
    config.node = process.execPath
    fs.writeFileSync(configPath, JSON.stringify(config))
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/recover-save.ps1'), '-NoDialogs', '-LaunchRecovered', resultRoot],
    { stdio: 'pipe', env: { ...process.env, PORT: '0', RECOVERY_TEST_OUTPUT: output } })
    expect(fs.readFileSync(output, 'utf8')).toBe(config.dataRoot)
})

test.runIf(process.platform === 'win32')('Windows helper refuses to launch a blocked recovery', () => {
    const { source, output } = fixture()
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'blocked', sourceUnchanged: true }))
    fs.writeFileSync(path.join(output, 'recovery-launch.json'), JSON.stringify({ appRoot: process.cwd(), node: process.execPath, dataRoot: source }))
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/recover-save.ps1'), '-NoDialogs', '-LaunchRecovered', output], { stdio: 'pipe' })).toThrow()
})

test.runIf(process.platform === 'win32')('Windows helper rejects the wrong folder before creating any output', () => {
    const { source, output } = fixture()
    fs.mkdirSync(output)
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/recover-save.ps1'), '-NoDialogs', '-Source', path.join(source, 'characters'),
        '-DestinationParent', output], { stdio: 'pipe' })).toThrow()
    expect(fs.readdirSync(output)).toEqual([])
})
