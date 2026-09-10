import { describe, expect, it } from 'vitest'
import { NativeDocuments, nativeEqual, mergeAcknowledgedValue, type NativeTarget } from './nativeDocuments'

const target: NativeTarget = { kind: 'character', id: 'a' }
describe('native document cache', () => {
    it('rebases disjoint edits on a fresh revision and retries only once', async () => {
        const calls: any[] = []
        const cache = new NativeDocuments(async (url, body: any) => {
            calls.push({ url, body })
            if (url.includes('/document?')) return { target, revision: '2', value: { desc: 'old', name: 'external' } }
            if (calls.length === 1) throw Object.assign(new Error('conflict'), { status: 409, details: { target } })
            return { documents: [{ target, revision: '3', value: body.writes[0].value }] }
        })
        cache.accept({ target, revision: '1', value: { name: 'before', desc: 'old' } })
        const write = cache.write(target, { name: 'before', desc: 'local' })!
        const result = await cache.commit([write])
        expect(calls).toHaveLength(3)
        expect(calls[2].body.writes[0]).toMatchObject({ expectedRevision: '2', value: { name: 'external', desc: 'local' } })
        expect(mergeAcknowledgedValue({ name: 'before', desc: 'newer' }, write.value, result.documents[0].value))
            .toEqual({ name: 'external', desc: 'newer' })
    })
    it('blocks repeated overlapping conflicts while preserving both versions', async () => {
        const calls: string[] = []
        const error = Object.assign(new Error('conflict'), { status: 409, details: { target } })
        const cache = new NativeDocuments(async url => {
            calls.push(url)
            if (url.includes('/document?')) return { target, revision: '2', value: { desc: 'external' } }
            throw error
        })
        cache.accept({ target, revision: '1', value: { desc: 'old' } })
        const write = cache.write(target, { desc: 'local' })!
        await expect(cache.commit([write])).rejects.toThrow('conflict')
        for (let i = 0; i < 5; i++) await expect(cache.commit([write])).rejects.toThrow('conflict')
        expect(calls).toHaveLength(2)
        expect(cache.baseline(target)).toEqual({ desc: 'old' })
        expect(write.value).toEqual({ desc: 'local' })
    })
    it('stops after one retry if the disk changes again', async () => {
        const calls: string[] = []
        const cache = new NativeDocuments(async url => {
            calls.push(url)
            if (url.includes('/document?')) return { target, revision: '2', value: { desc: 'old', name: 'external' } }
            throw Object.assign(new Error('conflict'), { status: 409, details: { target } })
        })
        cache.accept({ target, revision: '1', value: { desc: 'old', name: 'before' } })
        const write = cache.write(target, { desc: 'local', name: 'before' })!
        await expect(cache.commit([write])).rejects.toThrow('conflict')
        await expect(cache.commit([write])).rejects.toThrow('conflict')
        expect(calls).toHaveLength(3)
    })
    it('never automatically rebases deletion or conflicting message arrays', async () => {
        for (const value of [null, { message: [{ data: 'local' }] }]) {
            let commits = 0
            const cache = new NativeDocuments(async url => {
                if (url.includes('/document?')) return { target, revision: '2', value: { message: [{ data: 'external' }] } }
                commits++; throw Object.assign(new Error('conflict'), { status: 409, details: { target } })
            })
            cache.accept({ target, revision: '1', value: { message: [{ data: 'old' }] } })
            await expect(cache.commit([cache.write(target, value)!])).rejects.toThrow('conflict')
            expect(commits).toBe(1)
        }
    })
    it('compares persisted JSON by value regardless of object property order', () => {
        expect(nativeEqual({ name: 'A', nested: { first: 1, second: 2 }, absent: undefined },
            { nested: { second: 2, first: 1 }, name: 'A' })).toBe(true)
        expect(nativeEqual({ list: [1, 2] }, { list: [2, 1] })).toBe(false)
    })
    it('freezes nested edits into the submitted snapshot', () => {
        const cache = new NativeDocuments(async () => ({}))
        cache.accept({ target, value: { nested: { text: 'before' } }, revision: '1' })
        const local = { nested: { text: 'sent' } }
        const write = cache.write(target, local)!
        local.nested.text = 'newer'
        expect(write.value.nested.text).toBe('sent')
    })
    it('does not turn summaries into ready documents or save empty placeholders', async () => {
        const calls: unknown[] = []
        const cache = new NativeDocuments(async (url, body) => { calls.push([url, body]); return {} })
        cache.rememberSummary(target, { chaId: 'a', name: 'A' })
        expect(cache.isReady(target)).toBe(false)
        expect(cache.write(target, { chaId: 'a', desc: '' })).toBeNull()
        expect(calls).toEqual([])
    })
    it('acknowledges the sent snapshot while retaining a newer local edit', async () => {
        const cache = new NativeDocuments(async () => ({}))
        cache.accept({ target, value: { desc: 'before' }, revision: '1' })
        const write = cache.write(target, { desc: 'sent' })!
        const local = { desc: 'newer' }
        cache.acknowledge(write, { target, value: { desc: 'sent' }, revision: '2' })
        expect(cache.write(target, local)).toMatchObject({ expectedRevision: '2', value: local })
        expect(mergeAcknowledgedValue(local, write.value, { desc: 'sent' })).toEqual(local)
    })
    it('merges normalized asset references without swallowing concurrent field edits', () => {
        expect(mergeAcknowledgedValue({ image: 'old', desc: 'newer' }, { image: 'old', desc: 'sent' }, { image: 'scoped', desc: 'sent' }))
            .toEqual({ image: 'scoped', desc: 'newer' })
    })
    it('preserves revisions and local data when commit conflicts', async () => {
        const cache = new NativeDocuments(async () => { throw new Error('409 conflict') })
        cache.accept({ target, value: { desc: 'before' }, revision: '1' })
        const local = { desc: 'local' }
        await expect(cache.commit([cache.write(target, local)!])).rejects.toThrow('409')
        expect(cache.write(target, local)).toMatchObject({ expectedRevision: '1', value: local })
    })
    it('partial catalog responses cannot remove known IDs', () => {
        const cache = new NativeDocuments(async () => ({}))
        cache.acceptCatalog({ value: { schemaVersion: 2, characters: [{ id: 'a', chats: [] }, { id: 'b', chats: [] }], collections: { modules: ['m'] } }, revision: '1' })
        cache.acceptCatalog({ value: { characters: [{ id: 'a', chats: [] }], collections: {} }, revision: '2' }, false)
        expect(cache.catalog.value.characters.map((entry: any) => entry.id)).toEqual(['a', 'b'])
        expect(cache.catalog.value.collections.modules).toEqual(['m'])
    })
    it('only explicitly new documents may use creation revisions', () => {
        const cache = new NativeDocuments(async () => ({}))
        expect(cache.write(target, { desc: '' })).toBeNull()
        expect(cache.write(target, { desc: 'new' }, { create: true })).toMatchObject({ expectedRevision: null })
    })
    it('deletion requires an acknowledged revision and an explicit delete', () => {
        const cache = new NativeDocuments(async () => ({}))
        expect(cache.write(target, null)).toBeNull()
        cache.accept({ target, value: { desc: 'keep' }, revision: '1' })
        expect(cache.write(target, null)).toMatchObject({ expectedRevision: '1', value: null })
    })
})
