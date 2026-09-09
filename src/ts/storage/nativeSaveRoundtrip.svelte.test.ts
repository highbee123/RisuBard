import { afterEach, describe, expect, it } from 'vitest'
import { flushSync } from 'svelte'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { NativeRuntime } from './nativeRuntime'
import { trackNativeDocuments } from './nativeDocumentTracking.svelte'

const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('../../../server/node/user-data-repository.cjs')
const { createNativeDocumentStore } = require('../../../server/node/native-document-store.cjs')
const { readNativeSummaries } = require('../../../server/node/native-document-summaries.cjs')
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))

async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-save-loop-'))
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    createUserDataRepository({ dataRoot: root, formatVersion: 2 }).importLegacyDatabase({
        characters: [{ chaId: 'a', name: 'A', desc: 'old',
            personas: [{ id: 'persona-a', name: '라인델', personaPrompt: '라인델 아이바홀' }],
            chats: [{ id: 'c', name: 'C', message: [{ role: 'user', data: 'old' }] }] }],
        modules: [], personas: [], botPresets: [], loreBook: [], username: 'User',
    }, { mode: 'replace' })
    const store = createNativeDocumentStore({ dataRoot: root })
    let db: any = $state({})
    let commits = 0
    const runtime = new NativeRuntime(async (url, body: any) => {
        let result
        try {
            if (url.endsWith('/catalog')) result = store.catalog()
            else if (url.endsWith('/summaries')) result = readNativeSummaries({ dataRoot: root, catalog: store.catalog().value, targets: body.targets })
            else if (url.endsWith('/commit')) { commits++; result = store.commit(body) }
            else if (url.includes('/document?')) {
                const query = new URLSearchParams(url.split('?')[1])
                result = store.read({ kind: query.get('kind'), id: query.get('id'), ...(query.has('parentId') ? { parentId: query.get('parentId') } : {}) }, { metadataOnly: query.get('metadataOnly') === '1' })
            } else throw new Error(url)
        } catch (error: any) {
            throw Object.assign(new Error(error.message), { status: error.statusCode, details: { target: error.target, currentRevision: error.currentRevision } })
        }
        return JSON.parse(JSON.stringify(result))
    }, () => db)
    db = await runtime.bootstrap()
    const changed: any[] = []
    cleanup.push($effect.root(() => trackNativeDocuments(() => db, target => {
        if (runtime.documentDirty(target)) changed.push(target)
    }, () => false)))
    flushSync()
    return { runtime, db: () => db, changed, root, store, commits: () => commits }
}

describe('reactive native saves against the file store', () => {
    it.each([false, true])('keeps persona edits connected across autosaves (external edit: %s)', async (externalEdit) => {
        const f = await fixture(); await f.runtime.hydrateCharacter('a'); flushSync()
        // The mounted persona editor holds this object throughout typing.
        const editingPersona = f.db().characters[0].personas[0]
        editingPersona.personaPrompt = '세오 아이바홀'
        if (externalEdit) fs.writeFileSync(path.join(f.root, 'characters/A/description.md'), 'external')
        await f.runtime.persist({ character: ['a'] }); flushSync()

        editingPersona.name = '세오딘'
        editingPersona.personaPrompt = '세오딘 아이바홀'
        flushSync()
        expect(f.db().characters[0].personas[0]).toMatchObject({ name: '세오딘', personaPrompt: '세오딘 아이바홀' })
        expect(await f.runtime.persist({ character: ['a'] })).toBe(true)
        await f.runtime.ensureCharacter('a', true)
        expect(f.db().characters[0].personas[0]).toMatchObject({ name: '세오딘', personaPrompt: '세오딘 아이바홀' })
        expect(f.store.read({ kind: 'character', id: 'a' }).value.personas[0]).toMatchObject({ name: '세오딘', personaPrompt: '세오딘 아이바홀' })
        if (externalEdit) expect(f.db().characters[0].desc).toBe('external')
    })

    it('loads without saves, saves an edit once, and ignores server acknowledgment changes', async () => {
        const f = await fixture()
        expect(f.changed).toEqual([])
        await f.runtime.hydrateCharacter('a'); flushSync()
        expect(f.changed).toEqual([])
        f.db().characters[0].desc = 'edited'; flushSync()
        expect(f.changed).toEqual([{ kind: 'character', id: 'a' }])
        f.changed.length = 0
        await f.runtime.persist({ character: ['a'] }); flushSync()
        expect(f.changed).toEqual([])
        for (let i = 0; i < 10; i++) expect(await f.runtime.persist({ character: ['a'] })).toBe(false)
        expect(f.commits()).toBe(1)
        expect(f.store.read({ kind: 'character', id: 'a' }).value.desc).toBe('edited')
    })
    it('merges a disjoint external edit once without writing it back again', async () => {
        const f = await fixture(); await f.runtime.hydrateCharacter('a'); flushSync()
        fs.writeFileSync(path.join(f.root, 'characters/A/description.md'), 'external')
        f.db().characters[0].creator = 'local'
        await f.runtime.persist({ character: ['a'] }); flushSync()
        expect(f.db().characters[0]).toMatchObject({ desc: 'external', creator: 'local' })
        expect(await f.runtime.persist({ character: ['a'] })).toBe(false)
        expect(f.commits()).toBe(2)
    })
    it('keeps a conflicting local message and stops sending identical retries', async () => {
        const f = await fixture(); await f.runtime.hydrateCharacter('a'); flushSync()
        fs.writeFileSync(path.join(f.root, 'characters/A/chats/C/messages.jsonl'), JSON.stringify({ role: 'user', data: 'external' }) + '\n')
        f.db().characters[0].chats[0].message[0].data = 'local'
        await expect(f.runtime.persist({ chat: [['a', 'c']] })).rejects.toMatchObject({ status: 409 })
        for (let i = 0; i < 5; i++) expect(await f.runtime.persist({ chat: [['a', 'c']] })).toBe(false)
        expect(f.commits()).toBe(1)
        expect(f.db().characters[0].chats[0].message[0].data).toBe('local')
        expect(f.store.read({ kind: 'chat', id: 'c', parentId: 'a' }).value.message[0].data).toBe('external')
        f.db().username = 'unrelated edit'
        expect(await f.runtime.persist({ root: true, chat: [['a', 'c']] })).toBe(true)
        expect(f.commits()).toBe(2)
        expect(f.store.read({ kind: 'settings', id: 'global' }).value.username).toBe('unrelated edit')
    })
})
