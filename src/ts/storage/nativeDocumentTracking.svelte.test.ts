import { describe, expect, it } from 'vitest'
import { flushSync } from 'svelte'
import { trackNativeDocuments } from './nativeDocumentTracking.svelte'

describe('native document reactive tracking', () => {
    it('does not subscribe a document to unrelated values read by the scheduler', () => {
        const db = $state({ characters: [{ chaId: 'a', desc: 'old', chats: [] }] })
        const other = $state({ value: 0 })
        const changes: any[] = []
        const stop = $effect.root(() => trackNativeDocuments(() => db, target => {
            void other.value
            changes.push(target)
        }, () => false))
        flushSync(); changes.length = 0
        other.value++; flushSync()
        expect(changes).toEqual([])
        db.characters[0].desc = 'edited'; flushSync()
        expect(changes).toEqual([{ kind: 'character', id: 'a' }])
        stop()
    })
    it('schedules an unselected character after its final chat is deleted', () => {
        const db = $state({ characters: [{ chaId: 'selected', chats: [] }, { chaId: 'other', chats: [{ id: 'last', message: [{ data: 'keep' }] }] }] })
        const changes: any[] = []
        const stop = $effect.root(() => trackNativeDocuments(() => db, target => changes.push(target), () => false))
        flushSync(); changes.length = 0
        db.characters[1].chats.splice(0)
        flushSync()
        expect(changes).toContainEqual({ kind: 'character', id: 'other' })
        changes.length = 0; flushSync()
        expect(changes).toEqual([])
        stop()
    })
    it('tracks only the edited document on body changes and suppresses hydration writes', () => {
        const db = $state({ characters: [{ chaId: 'a', desc: '', chats: [{ id: 'c', message: [{ data: 'before' }] }] }] })
        let hydrating = false
        const changes: any[] = []
        const stop = $effect.root(() => trackNativeDocuments(() => db, target => changes.push(target), () => hydrating))
        flushSync(); changes.length = 0
        db.characters[0].chats[0].message[0].data = 'after'; flushSync()
        expect(changes).toEqual([{ kind: 'chat', parentId: 'a', id: 'c' }])
        hydrating = true; changes.length = 0
        db.characters[0].chats[0].message[0].data = 'hydrated'; flushSync()
        expect(changes).toEqual([])
        stop()
    })
})
