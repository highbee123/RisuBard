import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-storage-safety-'))
    roots.push(dataRoot)
    const repository = createUserDataRepository({ dataRoot })
    const database = {
        language: 'ko', botPresets: [{ id: 'preset-1', name: 'Prompt' }],
        modules: [{ id: 'module-1', name: 'Module' }], personas: [], loreBook: [],
        characters: [{ chaId: 'char-1', name: 'Character', chats: [
            { id: 'chat-1', name: 'Chat', message: [{ role: 'user', data: 'Keep this message' }] },
        ] }],
    }
    repository.importLegacyDatabase(database, { mode: 'replace' })
    return { dataRoot, repository, database }
}

describe('file-native data loss regressions', () => {
    it('preserves empty settings and non-filesystem IDs without breaking references', () => {
        const { repository, database } = fixture()
        const incoming: any = structuredClone(database)
        incoming.empty = {}
        incoming.modules[0].id = '한글/모듈'
        incoming.characters[0].chaId = '캐릭터/이름'
        incoming.characters[0].chats[0].id = '대화/이름'
        incoming.selectedModule = '한글/모듈'
        repository.importLegacyDatabase(incoming, { mode: 'replace' })
        expect(repository.exportLegacyDatabase()).toEqual(incoming)
    })
    it.each(['characters', 'modules', 'botPresets'])('rejects a sync missing %s before changing any files', field => {
        const { repository, database } = fixture()
        const before = repository.exportLegacyDatabase()
        const incomplete: any = structuredClone(database)
        delete incomplete[field]
        expect(() => repository.importLegacyDatabase(incomplete, { mode: 'sync' })).toThrow(/incomplete|missing/i)
        expect(repository.exportLegacyDatabase()).toEqual(before)
    })

    it.each(['stub', 'missing-message', 'missing-chats'])('rejects an unhydrated %s before replacing message bytes', kind => {
        const { repository, database } = fixture()
        const before = repository.exportLegacyDatabase()
        const incomplete: any = structuredClone(database)
        if (kind === 'missing-chats') delete incomplete.characters[0].chats
        else {
            delete incomplete.characters[0].chats[0].message
            if (kind === 'stub') incomplete.characters[0].chats[0]._stub = true
        }
        expect(() => repository.importLegacyDatabase(incomplete, { mode: 'sync' })).toThrow(/incomplete|hydrate|message|chats/i)
        expect(repository.exportLegacyDatabase()).toEqual(before)
    })

    it('rejects duplicate stable IDs before two entities can overwrite the same file', () => {
        const { repository, database } = fixture()
        const before = repository.exportLegacyDatabase()
        database.modules.push({ id: 'module-1', name: 'Conflicting module' })
        expect(() => repository.importLegacyDatabase(database, { mode: 'replace' })).toThrow(/duplicate/i)
        expect(repository.exportLegacyDatabase()).toEqual(before)
    })

    it('rebuilds a missing sidebar from entity files without losing messages or collections', () => {
        const { dataRoot, repository } = fixture()
        const before = repository.exportLegacyDatabase()
        fs.unlinkSync(path.join(dataRoot, 'index/sidebar.json'))
        const reopened = createUserDataRepository({ dataRoot })
        expect(reopened.exportLegacyDatabase()).toEqual(before)
        expect(reopened.loadSidebarIndex().characters.map((entry: any) => entry.id)).toEqual(['char-1'])
    })

    it('does not interpret a missing message file as an empty conversation', () => {
        const { dataRoot, repository } = fixture()
        fs.unlinkSync(path.join(dataRoot, 'characters/char-1/chats/chat-1/messages.jsonl'))
        expect(() => repository.exportLegacyDatabase()).toThrow(/message|ENOENT/i)
    })

    it.each(['missing', 'corrupt'])('preserves selection order when the sidebar is %s', kind => {
        const { dataRoot, repository, database } = fixture()
        database.botPresets.unshift({ id: 'z-preset', name: 'Selected prompt' })
        database.characters[0].chats.unshift({ id: 'z-chat', name: 'Selected chat', message: [] })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const before = repository.exportLegacyDatabase()
        const sidebar = path.join(dataRoot, 'index/sidebar.json')
        if (kind === 'missing') fs.unlinkSync(sidebar)
        else fs.writeFileSync(sidebar, '{broken')
        expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(before)
    })

    it('keeps valid intentional deletions and empty chats working', () => {
        const { repository, database } = fixture()
        database.modules = []
        database.characters[0].chats[0].message = []
        repository.importLegacyDatabase(database, { mode: 'sync' })
        expect(repository.exportLegacyDatabase().modules).toEqual([])
        expect(repository.loadChat('char-1', 'chat-1').message).toEqual([])
    })
})
