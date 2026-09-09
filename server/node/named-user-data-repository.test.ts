import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-names-')); roots.push(dataRoot)
    const database = {
        characters: ['a', 'b'].map(chaId => ({ chaId, name: '동일 이름', desc: '본문', globalLore: [{ key: 'lore', content: '설정' }],
            modules: ['module-a'], chatPage: 1, chats: ['chat-a', 'chat-b'].map(id => ({ id, name: '대화', message: [{ role: 'user', data: id }], localLore: [] })) })),
        modules: [{ id: 'module-a', name: '도구', lorebook: [{ content: '모듈 설정' }], description: '설명' }],
        personas: [{ id: 'persona-a', name: '나', personaPrompt: '화자' }],
        botPresets: [{ id: 'preset-a', name: '규칙', promptTemplate: [{ name: '지시', text: '본문' }] }], loreBook: [],
        botPresetsId: 0, selectedCharacter: 1,
    }
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    return { dataRoot, database, repository }
}
test('allocates readable duplicate names and keeps IDs, selections and content through reopen', () => {
    const { dataRoot, database, repository } = fixture()
    repository.importLegacyDatabase(database, { mode: 'replace' })
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름/character.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름 (2)/character.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dataRoot, 'characters/동일 이름/description.md'), 'utf8')).toBe('본문')
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름/lorebook.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름/chats/대화 (2)/messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'prompts/규칙/settings.json'))).toBe(true)
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(database)
})
test('renames folders without renumbering siblings or changing references; preserves drafts', () => {
    const { dataRoot, database, repository } = fixture()
    repository.importLegacyDatabase(database, { mode: 'replace' })
    repository.saveAssistantDraft('a', 'chat-a', { role: 'char', data: '초안' })
    database.characters[0].name = '새 이름'
    database.characters[0].chats[0].name = '새 대화'
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const reopened = createUserDataRepository({ dataRoot })
    expect(reopened.exportLegacyDatabase()).toEqual(database)
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름 (2)'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'characters/동일 이름'))).toBe(false)
    expect(reopened.loadAssistantDraft('a', 'chat-a')).toEqual({ role: 'char', data: '초안' })
    fs.unlinkSync(path.join(dataRoot, 'index/sidebar.json'))
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(database)
})
test('handles sanitized and case-insensitive collisions without overwrites', () => {
    const { dataRoot, database, repository } = fixture()
    database.characters[0].name = 'A/B'
    database.characters[1].name = 'a_b'
    repository.importLegacyDatabase(database, { mode: 'replace' })
    const names = fs.readdirSync(path.join(dataRoot, 'characters'))
    expect(names).toHaveLength(2)
    expect(new Set(names.map(n => n.toLowerCase())).size).toBe(2)
    expect(repository.exportLegacyDatabase()).toEqual(database)
})
test('converts legacy ID folders while retaining chats and auxiliary files', () => {
    const { dataRoot, database, repository } = fixture()
    const old = createUserDataRepository({ dataRoot, formatVersion: 1 })
    old.importLegacyDatabase(database, { mode: 'replace' })
    old.saveAssistantDraft('a', 'chat-a', { data: 'legacy draft' })
    repository.importLegacyDatabase(database, { mode: 'replace' })
    expect(repository.exportLegacyDatabase()).toEqual(database)
    expect(repository.loadAssistantDraft('a', 'chat-a')).toEqual({ data: 'legacy draft' })
    expect(fs.existsSync(path.join(dataRoot, 'characters/a'))).toBe(false)
    expect(fs.existsSync(path.join(dataRoot, 'trash'))).toBe(true)
})

test('numbers duplicate modules, personas and prompts while keeping prototype-like IDs intact', () => {
    const { dataRoot, database, repository } = fixture()
    for (const field of ['modules', 'personas', 'botPresets'] as const) {
        database[field] = [database[field][0], { ...database[field][0], id: '__proto__' }] as any
    }
    repository.importLegacyDatabase(database, { mode: 'replace' })
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(database)
    expect(fs.existsSync(path.join(dataRoot, 'modules/도구 (2)/module.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'personas/나 (2)/persona.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'prompts/규칙 (2)/settings.json'))).toBe(true)
})

test('merge assigns distinct IDs before combining legacy entities without IDs', () => {
    const { repository, database } = fixture()
    repository.importLegacyDatabase(database, { mode: 'replace' })
    repository.importLegacyDatabase({ characters: [], modules: [{ name: '추가' }, { name: '추가' }] }, { mode: 'merge' })
    const modules = repository.exportLegacyDatabase().modules
    expect(modules).toHaveLength(3)
    expect(new Set(modules.map((m: any) => m.id)).size).toBe(3)
})

test('external metadata edits may change prose but cannot silently retarget stable IDs', () => {
    const { dataRoot, repository, database } = fixture()
    repository.importLegacyDatabase(database, { mode: 'replace' })
    const file = path.join(dataRoot, 'characters/동일 이름/character.json')
    const changed = JSON.parse(fs.readFileSync(file, 'utf8')); changed.chaId = 'wrong-id'
    fs.writeFileSync(file, JSON.stringify(changed))
    expect(() => repository.exportLegacyDatabase({ acceptExternalChanges: true })).toThrow(/ID/)
})
