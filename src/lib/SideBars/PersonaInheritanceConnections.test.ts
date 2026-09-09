import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('new chat persona inheritance wiring', () => {
    test.each([
        ['src/lib/SideBars/SideChatList.svelte', 'newChatModelDefaults(chara, activeChat)'],
        ['src/lib/Others/ChatList.svelte', 'newChatModelDefaults(character, currentChat)'],
    ])('%s passes the current chat to the shared defaults', (path, call) => {
        expect(source(path)).toContain(call)
    })
})
