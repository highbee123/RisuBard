// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import CbsConditionView from './CbsConditionView.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('CBS visual condition editor', () => {
    it('shows Prompt V2 toggle labels and edits only the selected body span', async () => {
        const opening = '{{#if_pure {{? {{? {{getglobalvar::toggle_a}}>0}} || {{? {{getglobalvar::toggle_b}}>0}}=1}}}}'
        const source = `Before\n${opening}\nConditional body\n{{/if}}\nAfter`
        const onInput = vi.fn()
        const onSelectionChange = vi.fn()

        mounted = mount(CbsConditionView, {
            target: document.body,
            props: {
                value: source,
                onInput,
                onSelectionChange,
                showVariableSidebar: false,
                variableLabels: { toggle_a: '첫 번째 토글', toggle_b: '두 번째 토글' },
            },
        })
        await tick()
        await vi.waitFor(() => expect(document.querySelector('[data-cbs-summary]')).not.toBeNull())

        const summary = document.querySelector('[data-cbs-summary]')!
        expect(summary.textContent).toContain('[첫 번째 토글]')
        expect(summary.textContent).toContain('OR')
        expect(summary.textContent).toContain('[두 번째 토글]')
        expect(document.querySelector('[data-cbs-variable-sidebar]')).toBeNull()

        const body = Array.from(document.querySelectorAll<HTMLTextAreaElement>('[data-cbs-body]'))
            .find(field => field.value.includes('Conditional body'))!
        const start = body.value.indexOf('Conditional')
        body.focus()
        body.setSelectionRange(start, start + 'Conditional'.length)
        body.dispatchEvent(new Event('select', { bubbles: true }))
        expect(onSelectionChange).toHaveBeenLastCalledWith({
            start: source.indexOf('Conditional'),
            end: source.indexOf('Conditional') + 'Conditional'.length,
        })

        body.value = body.value.replace('Conditional body', 'Edited body')
        body.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(onInput).toHaveBeenLastCalledWith(source.replace('Conditional body', 'Edited body'))
        expect(onInput.mock.lastCall?.[0]).toContain(opening)
    })

    it('warns when a condition stays as lossless raw syntax', async () => {
        mounted = mount(CbsConditionView, {
            target: document.body,
            props: {
                value: '{{#if {{unknown::a::b}}}}Body{{/if}}',
                onInput: vi.fn(),
                showVariableSidebar: false,
            },
        })
        await tick()

        expect(document.querySelector('[data-cbs-warning]')).not.toBeNull()
        expect(document.querySelector('[data-cbs-summary]')?.textContent).toContain('{{unknown::a::b}}')
    })
})
