import { describe, expect, it } from 'vitest'
import { NativeRuntime, hydrateActiveModuleScopes } from './nativeRuntime'

function fixture(hooks: { commit?: (body: any, result: any) => Promise<any>; read?: (target: any, value: any) => Promise<any>; summary?: (target: any) => any; saving?: (state: boolean) => void } = {}) {
    let db: any
    const calls: any[] = []
    const catalog = { value: { schemaVersion: 2, characters: [{ id: 'a', name: 'A', chats: [{ id: 'c', name: 'C' }] }, { id: 'b', name: 'B', chats: [] }], collections: { modules: ['m'], personas: [], botPresets: [], loreBook: [] }, paths: {}, names: {} }, revision: 'catalog1' }
    const request = async (path: string, body?: any): Promise<any> => {
        calls.push({ path, body })
        if (path.endsWith('/catalog')) return catalog
        if (path.endsWith('/summaries')) return { summaries: body.targets.map((target: any) => ({ target, value: hooks.summary ? hooks.summary(target) : { id: target.id, name: target.id.toUpperCase() }, summary: true })) }
        if (path.includes('/document?')) {
            const q = new URLSearchParams(path.split('?')[1]); const target: any = { kind: q.get('kind'), id: q.get('id'), ...(q.has('parentId') ? { parentId: q.get('parentId') } : {}) }
            const value = target.kind === 'settings' ? { username: 'U' } : target.kind === 'chat' ? { id: target.id, name: 'C', note: 'keep', ...(q.has('metadataOnly') ? {} : { message: [{ data: 'body' }] }) } : { chaId: target.id, desc: 'disk', name: 'A' }
            return { target, value: hooks.read ? await hooks.read(target, value) : value, revision: 'r1', ...(q.has('metadataOnly') ? { metadataOnly: true } : {}) }
        }
        if (path.endsWith('/documents')) return { documents: [] }
        if (path.endsWith('/commit')) {
            const result = { documents: body.writes.map((write: any) => ({ target: write.target, value: write.value, revision: 'r2' })), catalog: body.catalog ? { value: body.catalog.value, revision: 'catalog2' } : catalog }
            return hooks.commit ? hooks.commit(body, result) : result
        }
        throw new Error(path)
    }
    const runtime = new NativeRuntime(request, () => db, value => value, hooks.saving)
    return { runtime, calls, setDb: (value: any) => { db = value }, db: () => db }
}
describe('native runtime', () => {
    it('only marks actual edits or membership changes dirty, including during hydration', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        expect(f.runtime.documentDirty({ kind: 'character', id: 'a' })).toBe(false)
        await f.runtime.hydrateCharacter('a')
        expect(f.runtime.documentDirty({ kind: 'character', id: 'a' })).toBe(false)
        expect(f.runtime.documentDirty({ kind: 'chat', id: 'c', parentId: 'a' })).toBe(false)
        f.db().characters[0].chats[0].message[0].data = 'edited'
        expect(f.runtime.documentDirty({ kind: 'chat', id: 'c', parentId: 'a' })).toBe(true)
        f.db().characters[0].chats.splice(0)
        expect(f.runtime.documentDirty({ kind: 'character', id: 'a' })).toBe(true)
    })
    it('stops saving after the server returns equivalent fields in disk order', async () => {
        const f = fixture({ commit: async (_body, result) => ({ ...result, documents: result.documents.map((doc: any) => ({
            ...doc, value: Object.fromEntries(Object.entries(doc.value).reverse()),
        })) }) })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].desc = 'edited'
        await f.runtime.persist({ character: ['a'] })
        for (let i = 0; i < 5; i++) expect(await f.runtime.persist({ character: ['a'] })).toBe(false)
        expect(f.calls.filter(call => call.path.endsWith('/commit'))).toHaveLength(1)
    })
    it('bootstraps settings and complete summary IDs without legacy DB or character/chat bodies', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        expect(f.db().characters.map((c: any) => c.chaId)).toEqual(['a', 'b'])
        expect(f.db().characters[0].chats[0]._placeholder).toBe(true)
        expect(f.runtime.characterReady('a')).toBe(false)
        expect(f.calls.filter(c => c.path.includes('/document?')).every(c => c.path.includes('kind=settings'))).toBe(true)
        expect(f.calls.some(c => /database.bin|api\/read|api\/patch/.test(c.path))).toBe(false)
    })
    it('saves only the edited requested document and never an unloaded sibling', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        await f.runtime.ensureCharacter('a')
        f.db().characters[0].desc = 'edited'
        await f.runtime.persist()
        const commit = f.calls.find(c => c.path.endsWith('/commit'))
        expect(commit.body.writes.map((w: any) => w.target)).toEqual([{ kind: 'character', id: 'a' }])
        expect(commit.body.catalog).toBeUndefined()
        expect(commit.body.writes[0].value.chats).toBeUndefined()
    })
    it('refreshes clean requested documents but preserves unsaved edits', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        await f.runtime.ensureCharacter('a')
        await f.runtime.ensureCharacter('a', true)
        const reads = () => f.calls.filter(c => c.path.includes('kind=character')).length
        expect(reads()).toBe(2)
        f.db().characters[0].desc = 'local'
        await f.runtime.ensureCharacter('a', true)
        expect(reads()).toBe(2)
        expect(f.db().characters[0].desc).toBe('local')
    })
    it('does not save anything after a read or replace unloaded placeholders with empty documents', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        await f.runtime.ensureCharacter('a')
        expect(await f.runtime.persist()).toBe(false)
        expect(f.calls.some(c => c.path.endsWith('/commit'))).toBe(false)
    })
    it('reports saving only while an actual native commit is in flight', async () => {
        let release: () => void
        let started: () => void
        const begun = new Promise<void>(resolve => { started = resolve })
        const blocked = new Promise<void>(resolve => { release = resolve })
        const states: boolean[] = []
        const f = fixture({ saving: state => states.push(state), commit: async (_body, result) => { started(); await blocked; return result } })
        f.setDb(await f.runtime.bootstrap())
        expect(await f.runtime.persist()).toBe(false)
        expect(states).toEqual([])

        await f.runtime.ensureCharacter('a')
        f.db().characters[0].desc = 'edited'
        const pending = f.runtime.persist()
        await begun
        expect(states).toEqual([true])
        release()
        await pending
        expect(states).toEqual([true, false])
    })
    it('hydrates and preserves edits to an unselected summary before saving', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        f.db().characters[1].name = 'Renamed'
        f.db().characters[1].trashTime = 123
        await f.runtime.persist()
        const writes = f.calls.find(c => c.path.endsWith('/commit')).body.writes
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ target: { kind: 'character', id: 'b' }, value: { desc: 'disk', name: 'Renamed', trashTime: 123 } })
        expect(f.runtime.characterReady('a')).toBe(false)
    })
    it('renames unloaded chat metadata without reading or writing its messages', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        await f.runtime.ensureCharacter('a')
        f.db().characters[0].chats[0].name = 'Renamed chat'
        await f.runtime.persist()
        const writes = f.calls.find(c => c.path.endsWith('/commit')).body.writes
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ target: { kind: 'chat', parentId: 'a', id: 'c' }, metadataOnly: true, value: { name: 'Renamed chat', note: 'keep' } })
        expect(writes[0].value.message).toBeUndefined()
        expect(f.calls.filter(c => c.path.includes('kind=chat')).every(c => c.path.includes('metadataOnly=1'))).toBe(true)
        expect(f.db().characters[0].chats[0]._placeholder).toBe(true)
        expect(await f.runtime.persist()).toBe(false)
    })
    it('uses complete catalog CAS for an explicit deletion while keeping siblings', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        f.db().characters.splice(1, 1)
        await f.runtime.persist()
        const commit = f.calls.find(c => c.path.endsWith('/commit')).body
        expect(commit.writes).toEqual([{ target: { kind: 'character', id: 'b' }, expectedRevision: 'r1', value: null }])
        expect(commit.catalog.expectedRevision).toBe('catalog1')
        expect(commit.catalog.value.characters.map((c: any) => c.id)).toEqual(['a'])
        expect(commit.catalog.value.characters[0].chats.map((c: any) => c.id)).toEqual(['c'])
        expect(commit.catalog.value.collections.modules).toEqual(['m'])
    })
    it('retains edits made during a commit and persists them with the acknowledged revision', async () => {
        let release: () => void
        let started: () => void
        const begun = new Promise<void>(resolve => { started = resolve })
        const blocked = new Promise<void>(resolve => { release = resolve })
        let first = true
        const f = fixture({ commit: async (_body, result) => { if (first) { first = false; started(); await blocked }; return result } })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].desc = 'sent'
        const pending = f.runtime.persist(); await begun
        f.db().characters[0].desc = 'newer'
        release(); await pending
        expect(f.db().characters[0].desc).toBe('newer')
        await f.runtime.persist()
        const commits = f.calls.filter(c => c.path.endsWith('/commit'))
        expect(commits[1].body.writes[0]).toMatchObject({ expectedRevision: 'r2', value: { desc: 'newer' } })
    })
    it('keeps editors attached by ID when acknowledgment reorders and removes entries', async () => {
        let normalize = true
        const f = fixture({ commit: async (_body, result) => {
            if (normalize) {
                const document = result.documents.find((entry: any) => entry.target.kind === 'character')
                const [first, , last] = document.value.personas
                document.value = { ...document.value, personas: [{ ...last, icon: 'normalized' }, first] }
                normalize = false
            }
            return result
        } })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].personas = [{ id: 'first', name: 'First' }, { id: 'removed', name: 'Removed' }, { id: 'last', name: 'Last' }]
        const editing = f.db().characters[0].personas[2]
        await f.runtime.persist()
        editing.name = 'Latest'
        await f.runtime.persist()
        const writes = f.calls.filter(call => call.path.endsWith('/commit')).at(-1).body.writes
        expect(writes[0].value.personas).toEqual([{ id: 'last', name: 'Latest', icon: 'normalized' }, { id: 'first', name: 'First' }])
    })
    it('keeps nested settings edits connected after server-side normalization', async () => {
        let normalize = true
        const f = fixture({ commit: async (_body, result) => {
            if (normalize) {
                const document = result.documents.find((entry: any) => entry.target.kind === 'settings')
                document.value = { ...document.value, customSettings: { ...document.value.customSettings, normalized: true } }
                normalize = false
            }
            return result
        } })
        f.setDb(await f.runtime.bootstrap())
        f.db().customSettings = { text: 'Partial' }
        const editing = f.db().customSettings
        await f.runtime.persist()
        editing.text = 'Latest'
        await f.runtime.persist()
        const writes = f.calls.filter(call => call.path.endsWith('/commit')).at(-1).body.writes
        expect(writes[0].value.customSettings).toEqual({ text: 'Latest', normalized: true })
    })
    it('retains dirty local documents and revisions on a 409 without a full-state fallback', async () => {
        const f = fixture({ commit: async () => { throw new Error('409 conflict') } })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].desc = 'local'
        await expect(f.runtime.persist()).rejects.toThrow('409')
        expect(f.db().characters[0].desc).toBe('local')
        expect(f.runtime.cache.write({ kind: 'character', id: 'a' }, f.db().characters[0])?.expectedRevision).toBe('r1')
        expect(f.calls.every(c => c.path.startsWith('/api/native/'))).toBe(true)
    })
    it('acknowledges only normalization and does not swallow existing edits on this or other targets', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().username = 'edited settings'; f.db().characters[0].desc = 'local'
        const before = JSON.parse(JSON.stringify(f.db().characters[0]))
        f.db().characters[0].newDefault = true
        f.runtime.acknowledgeCharacterNormalization('a', before)
        await f.runtime.persist()
        const writes = f.calls.find(c => c.path.endsWith('/commit')).body.writes
        expect(writes.map((w: any) => w.target.kind)).toEqual(['settings', 'character'])
        expect(writes[1].value.desc).toBe('local')
    })
    it('refreshes clean loaded chats and retains unsaved messages', async () => {
        let text = 'first'
        const f = fixture({ read: async (target, value) => target.kind === 'chat' ? { ...value, message: [{ data: text }] } : value })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.hydrateCharacter('a')
        text = 'external'
        await f.runtime.refreshChat('a', 'c')
        expect(f.db().characters[0].chats[0].message[0].data).toBe('external')
        f.db().characters[0].chats[0].message[0].data = 'local'
        text = 'external again'
        await f.runtime.refreshChat('a', 'c')
        expect(f.db().characters[0].chats[0].message[0].data).toBe('local')
    })
    it('rechecks active module scopes after an in-flight hydration', async () => {
        let active = ['old']; const ready = new Set<string>(); const hydrated: string[] = []
        await hydrateActiveModuleScopes(() => active, id => ready.has(id), async id => {
            hydrated.push(id); ready.add(id)
            if (id === 'old') active = ['new']
        })
        expect(hydrated).toEqual(['old', 'new'])
    })
    it('automatic saves inspect only the signaled documents', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        await f.runtime.ensureCharacter('a'); await f.runtime.ensureCharacter('b')
        f.db().characters[0].desc = 'A edited'; f.db().characters[1].desc = 'B edited'
        let siblingReads = 0
        Object.defineProperty(f.db().characters[1], 'desc', { enumerable: true, get: () => { siblingReads++; return 'B edited' } })
        await f.runtime.persist({ character: ['a'] })
        expect(siblingReads).toBe(0)
        const writes = f.calls.find(c => c.path.endsWith('/commit')).body.writes
        expect(writes.map((write: any) => write.target.id)).toEqual(['a'])
    })
    it('preserves a placeholder rename made while its body was loading', async () => {
        let release: () => void; let started: () => void
        const blocked = new Promise<void>(resolve => { release = resolve })
        const begun = new Promise<void>(resolve => { started = resolve })
        const f = fixture({ read: async (target, value) => { if (target.kind === 'chat') { started(); await blocked }; return value } })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        const pending = f.runtime.readChat('a', 'c'); await begun
        f.db().characters[0].chats[0].name = 'Local rename'
        release(); const full = await pending
        f.runtime.mergeHydratedChat('a', f.db().characters[0].chats[0], full)
        f.db().characters[0].chats[0] = full
        expect(full.name).toBe('Local rename')
        expect(full.message[0].data).toBe('body')
        await f.runtime.persist({ chat: [['a', 'c']] })
        expect(f.calls.find(c => c.path.endsWith('/commit')).body.writes[0].value.name).toBe('Local rename')
    })
    it('preserves local placeholder metadata when refreshing its character summaries', async () => {
        let folderId = 'old'
        const f = fixture({ summary: target => ({ id: target.id, name: target.id.toUpperCase(), ...(target.kind === 'chat' ? { folderId } : {}) }) })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].chats[0].name = 'Local rename'
        folderId = 'external folder'
        await f.runtime.ensureCharacter('a', true)
        expect(f.db().characters[0].chats[0]).toMatchObject({ name: 'Local rename', folderId: 'external folder' })
    })
    it('preserves pending placeholder metadata at bulk/plugin hydration boundaries', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        f.db().characters[0].chats[0].name = 'Pending name'
        f.db().characters[0].chats[0].modules = ['m']
        await f.runtime.hydrateCharacter('a')
        expect(f.db().characters[0].chats[0]).toMatchObject({ name: 'Pending name', modules: ['m'], message: [{ data: 'body' }] })
        expect(f.runtime.cache.write({ kind: 'chat', id: 'c', parentId: 'a' }, f.db().characters[0].chats[0])).not.toBeNull()
    })
    it('retains newer summary edits made while persistence hydrates the original document', async () => {
        let release: () => void; let started: () => void
        const blocked = new Promise<void>(resolve => { release = resolve })
        const begun = new Promise<void>(resolve => { started = resolve })
        const f = fixture({ read: async (target, value) => { if (target.kind === 'character') { started(); await blocked }; return value } })
        f.setDb(await f.runtime.bootstrap())
        f.db().characters[1].name = 'first edit'
        const pending = f.runtime.persist({ character: ['b'] }); await begun
        f.db().characters[1].name = 'newer edit'
        release(); await pending
        expect(f.db().characters[1].name).toBe('newer edit')
        expect(f.calls.find(call => call.path.endsWith('/commit')).body.writes[0].value).toMatchObject({ name: 'newer edit', desc: 'disk' })
    })
    it('does not advance chat summary baselines when a character refresh is discarded', async () => {
        let release: () => void; let started: () => void; let block = false; let folderId = 'old'
        const blocked = new Promise<void>(resolve => { release = resolve })
        const begun = new Promise<void>(resolve => { started = resolve })
        const f = fixture({
            read: async (target, value) => { if (block && target.kind === 'character') { started(); await blocked }; return value },
            summary: target => ({ id: target.id, name: target.id.toUpperCase(), ...(target.kind === 'chat' ? { folderId } : {}) }),
        })
        f.setDb(await f.runtime.bootstrap()); await f.runtime.ensureCharacter('a')
        block = true; folderId = 'external'
        const pending = f.runtime.ensureCharacter('a', true); await begun
        f.db().characters[0].desc = 'local'
        release(); await pending
        await f.runtime.persist({ character: ['a'] })
        const writes = f.calls.find(call => call.path.endsWith('/commit')).body.writes
        expect(writes.map((write: any) => write.target.kind)).toEqual(['character'])
    })
    it('creates document IDs when crypto.randomUUID is unavailable on HTTP', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap())
        f.db().characters[0].chats.push({ name: 'New', message: [] })
        const randomUUID = crypto.randomUUID
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
        try {
            await f.runtime.persist()
            expect(f.db().characters[0].chats[1].id).toMatch(/^[a-f0-9-]{36}$/)
        } finally {
            Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: randomUUID })
        }
    })
    it('never reclassifies an externally removed existing summary as a new document', async () => {
        const f = fixture({ commit: async (_body, result) => ({ ...result, catalog: { value: { ...result.catalog.value, characters: result.catalog.value.characters.filter((character: any) => character.id !== 'b') }, revision: 'external-delete' } }) })
        f.setDb(await f.runtime.bootstrap())
        f.db().username = 'first settings edit'; await f.runtime.persist({ root: true })
        f.db().username = 'second settings edit'; await f.runtime.persist({ root: true })
        const writes = f.calls.filter(call => call.path.endsWith('/commit')).flatMap(call => call.body.writes)
        expect(writes.map((write: any) => write.target.kind)).toEqual(['settings', 'settings'])
        expect(f.runtime.characterReady('b')).toBe(false)
    })
    it('allows an explicitly deleted character and its chats to be recreated with their IDs', async () => {
        const f = fixture(); f.setDb(await f.runtime.bootstrap()); await f.runtime.hydrateCharacter('a')
        const original = JSON.parse(JSON.stringify(f.db().characters[0]))
        f.db().characters.splice(0, 1); await f.runtime.persist()
        f.db().characters.push(original); await f.runtime.persist()
        const writes = f.calls.filter(call => call.path.endsWith('/commit'))[1].body.writes
        expect(writes.map((write: any) => [write.target.kind, write.expectedRevision])).toEqual([['character', null], ['chat', null]])
    })
})
