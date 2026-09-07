// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { writable } from 'svelte/store'
import type { PromptItem } from 'src/ts/process/prompt'
import PromptV2BlockEditor from './PromptV2BlockEditor.svelte'

vi.mock(import('src/ts/storage/database.svelte'), () => ({
    appVer: '1234.5.67',
    getCurrentCharacter: () => ({}),
    getDatabase: () => ({}),
}) as typeof import('src/ts/storage/database.svelte'))

vi.mock(import('src/ts/globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('src/ts/stores.svelte'), () => ({
    DBState: {
        db: {
            characters: [{ chatPage: 0, chats: [{ scriptstate: {} }], defaultVariables: '' }],
            globalChatVariables: {},
            templateDefaultVariables: '',
        },
    },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}) as typeof import('src/ts/stores.svelte'))

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    localStorage.clear()
})

describe('Prompt V2 block visual editor', () => {
    it('wraps the selected visual text with a condition and remembers the mode', async () => {
        const item: PromptItem = {
            type: 'plain', type2: 'normal', role: 'system', name: 'Block', text: 'Before selected after',
        }
        const onReplace = vi.fn()
        mounted = mount(PromptV2BlockEditor, {
            target: document.body,
            props: {
                item,
                definitions: [{
                    key: 'toggle_enabled', rawKey: 'enabled', label: '활성화', type: 'switch', options: [],
                }],
                previewValues: { toggle_enabled: '0' },
                onReplace,
                onOpenToggleSetup: vi.fn(),
            },
        })
        await tick()

        const modeButtons = document.querySelectorAll<HTMLButtonElement>('.editor-mode-tabs button')
        modeButtons[1].click()
        await tick()
        await vi.waitFor(() => expect(document.querySelector('[data-prompt-v2-syntax-palette]')).not.toBeNull())
        expect(localStorage.getItem('risubard:prompt-v2-editor-mode:v1')).toBe('visual')

        const body = document.querySelector<HTMLTextAreaElement>('[data-cbs-body]')!
        const start = body.value.indexOf('selected')
        body.focus()
        body.setSelectionRange(start, start + 'selected'.length)
        body.dispatchEvent(new Event('select', { bubbles: true }))
        await tick()

        const insert = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-prompt-v2-syntax-palette] button'))
            .find(button => button.textContent?.includes('선택 영역') || button.textContent?.includes('Wrap selection'))!
        insert.click()
        await tick()

        expect(onReplace).toHaveBeenCalled()
        expect(onReplace.mock.lastCall?.[0].text).toBe(
            'Before {{#if {{equal::{{getglobalvar::toggle_enabled}}::1}}}}\nselected\n{{/if}} after',
        )
    })
})
