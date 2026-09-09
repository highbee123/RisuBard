import { deepTouch } from '../gui/deepTouch.svelte'
import type { NativeTarget } from './nativeDocuments'
import { untrack } from 'svelte'

/** Install under an effect root. Each body edit touches only its own document. */
export function trackNativeDocuments(database: () => any, changed: (target: NativeTarget) => void, hydrating: (parentId: string, id: string) => boolean) {
    $effect(() => {
        for (const char of database().characters) {
            $effect(() => {
                for (const key in char) if (key !== 'chats') deepTouch(char[key])
                untrack(() => changed({ kind: 'character', id: char.chaId }))
            })
            $effect(() => {
                // Membership changes still need a save when the array becomes empty.
                untrack(() => changed({ kind: 'character', id: char.chaId }))
                for (const chat of char.chats ?? []) {
                    $effect(() => {
                        deepTouch(chat)
                        if (chat.id && !hydrating(char.chaId, chat.id)) untrack(() => changed({ kind: 'chat', parentId: char.chaId, id: chat.id }))
                    })
                }
            })
        }
    })
}
