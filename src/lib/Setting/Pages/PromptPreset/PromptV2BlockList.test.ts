// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { writable } from 'svelte/store'
import type { PromptItem } from 'src/ts/process/prompt'
import PromptV2BlockList from './PromptV2BlockList.svelte'

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
    DBState: { db: { globalChatVariables: {} } },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}) as typeof import('src/ts/stores.svelte'))

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('Prompt V2 block list actions', () => {
    it('places new and duplicate block actions in the list heading', async () => {
        const items: PromptItem[] = [{
            type: 'plain', type2: 'normal', role: 'system', name: 'Block', text: 'Body',
        }]
        const onAdd = vi.fn()
        const onDuplicate = vi.fn()
        mounted = mount(PromptV2BlockList, {
            target: document.body,
            props: {
                items,
                selectedIndex: 0,
                previewValues: {},
                onSelect: vi.fn(),
                onAdd,
                onDuplicate,
                onRemove: vi.fn(),
                onMove: vi.fn(),
                onFind: vi.fn(),
            },
        })
        await tick()

        const header = document.querySelector('header')!
        const buttons = Array.from(header.querySelectorAll<HTMLButtonElement>('button'))
        buttons.find(button => button.textContent?.includes('새 블록') || button.textContent?.includes('New block'))!.click()
        buttons.find(button => button.textContent?.includes('블록 복제') || button.textContent?.includes('Duplicate block'))!.click()

        expect(onAdd).toHaveBeenCalledOnce()
        expect(onDuplicate).toHaveBeenCalledOnce()
        expect(document.querySelector('footer')).toBeNull()
    })
})
