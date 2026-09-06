import { describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'
import {
    compilePromptV2Text,
    clearPromptV2PreviewState,
    createPromptV2BodyPreviewSegments,
    createPromptV2PreviewValues,
    evaluatePromptV2Activation,
    loadPromptV2PreviewState,
    parsePromptV2Text,
    parsePromptV2ToggleTree,
    savePromptV2PreviewState,
    type PromptV2Activation,
} from './promptV2'
import { risuChatParser } from './parser/parser.svelte'
import { DBState } from './stores.svelte'

vi.mock(import('./storage/database.svelte'), () => ({
    appVer: '1234.5.67',
    getCurrentCharacter: () => ({}),
    getDatabase: () => ({}),
}) as typeof import('./storage/database.svelte'))

vi.mock(import('./globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('./stores.svelte'), () => ({
    DBState: {
        db: {
            characters: [{ chatPage: 0, chats: [{ scriptstate: {} }], defaultVariables: '' }],
            globalChatVariables: {},
            templateDefaultVariables: '',
        },
    },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}) as typeof import('./stores.svelte'))

const activation = (join: 'and' | 'or'): PromptV2Activation => ({
    join,
    conditions: [
        { key: 'toggle_OOC', operator: 'is', value: '0' },
        { key: 'toggle_lang', operator: 'isnot', value: '2' },
    ],
})

describe('Prompt V2 compatibility compiler', () => {
    test('round-trips AND conditions without adding preset schema fields', () => {
        const source = compilePromptV2Text('Readable prompt body', activation('and'))

        expect(source).toBe(
            '{{#when::keep::{{equal::{{getglobalvar::toggle_OOC}}::0}}::and::{{notequal::{{getglobalvar::toggle_lang}}::2}}}}\n' +
            'Readable prompt body\n{{/when}}',
        )
        expect(parsePromptV2Text(source)).toEqual({
            body: 'Readable prompt body',
            activation: activation('and'),
            format: 'v2',
            editable: true,
        })
    })

    test.each([
        ['and', { toggle_OOC: '0', toggle_lang: '1' }, true],
        ['and', { toggle_OOC: '1', toggle_lang: '1' }, false],
        ['or', { toggle_OOC: '1', toggle_lang: '2' }, false],
        ['or', { toggle_OOC: '0', toggle_lang: '2' }, true],
    ] as const)('evaluates %s conditions identically in the helper and CBS runtime', (join, values, expected) => {
        const rule = activation(join)
        const source = compilePromptV2Text('VISIBLE', rule)
        DBState.db.globalChatVariables = values

        expect(evaluatePromptV2Activation(rule, values)).toBe(expected)
        expect(risuChatParser(source).trim()).toBe(expected ? 'VISIBLE' : '')
    })

    test('keeps a legacy condition wrapper as editable prompt body', () => {
        const source = '{{#if_pure {{? {{getglobalvar::toggle_OOC}}=0}}}}\nLegacy body\n{{/if}}'

        expect(parsePromptV2Text(source)).toEqual({
            body: source,
            activation: null,
            format: 'none',
            editable: true,
        })
    })

    test('evaluates hand-written if_pure body branches with isolated preview globals', () => {
        const source = [
            '{{#if_pure {{? {{getglobalvar::toggle_OOC}}=0}}}}',
            '# Basic Guideline',
            'Visible only while OOC is off.',
            '{{/if}}',
        ].join('\n')

        const active = createPromptV2BodyPreviewSegments(source, { toggle_OOC: '0' })
        const inactive = createPromptV2BodyPreviewSegments(source, { toggle_OOC: '2' })

        expect(active.filter(segment => segment.text.includes('Basic Guideline'))).toEqual([
            expect.objectContaining({ state: 'active' }),
        ])
        expect(inactive.filter(segment => segment.text.includes('Basic Guideline'))).toEqual([
            expect.objectContaining({ state: 'inactive' }),
        ])
        expect(active.map(segment => segment.text).join('')).toBe(source)
        expect(inactive.map(segment => segment.text).join('')).toBe(source)
    })

    test('keeps ordinary body text neutral while highlighting only conditional ranges', () => {
        const source = 'Always\n{{#if_pure {{? {{getglobalvar::toggle_OOC}}=0}}}}Conditional{{/if}}\nTail'
        const segments = createPromptV2BodyPreviewSegments(source, { toggle_OOC: '1' })

        expect(segments.find(segment => segment.text.includes('Always'))?.state).toBe('neutral')
        expect(segments.find(segment => segment.text.includes('Conditional'))?.state).toBe('inactive')
        expect(segments.find(segment => segment.text.includes('Tail'))?.state).toBe('neutral')
        expect(segments.map(segment => segment.text).join('')).toBe(source)
    })

    test('highlights nested when branches closed with the generic CBS closer', () => {
        const source = [
            'Always',
            '{{#when::toggle::outer}}',
            'Outer',
            '{{#when::toggle::inner}}Inner{{:else}}Fallback{{/}}',
            '{{/}}',
            'Tail',
        ].join('\n')
        const segments = createPromptV2BodyPreviewSegments(source, {
            toggle_outer: '1',
            toggle_inner: '0',
        })

        expect(segments.find(segment => segment.text.includes('Outer'))?.state).toBe('active')
        expect(segments.find(segment => segment.text.includes('Inner'))?.state).toBe('inactive')
        expect(segments.find(segment => segment.text.includes('Fallback'))?.state).toBe('active')
        expect(segments.find(segment => segment.text.includes('Tail'))?.state).toBe('neutral')
        expect(segments.map(segment => segment.text).join('')).toBe(source)
    })

    test('keeps generic CBS closers aligned across conditional and non-conditional blocks', () => {
        const source = [
            '{{#pure}}Literal{{/}}',
            '{{#when::toggle::outer}}',
            'Before',
            '{{#each [1] as n}}Loop{{slot::n}}{{/}}',
            'After',
            '{{/}}',
            'Tail',
        ].join('\n')
        const segments = createPromptV2BodyPreviewSegments(source, { toggle_outer: '1' })

        expect(segments.find(segment => segment.text.includes('Literal'))?.state).toBe('neutral')
        expect(segments.find(segment => segment.text.includes('Before'))?.state).toBe('active')
        expect(segments.find(segment => segment.text.includes('Loop'))?.state).toBe('active')
        expect(segments.find(segment => segment.text.includes('After'))?.state).toBe('active')
        expect(segments.find(segment => segment.text.includes('Tail'))?.state).toBe('neutral')
        expect(segments.map(segment => segment.text).join('')).toBe(source)
    })

    test('nests the V2 block gate around hand-written body conditions without changing them', () => {
        const source = '{{#when::keep::custom::operator::value}}\nBody\n{{/when}}'
        expect(parsePromptV2Text(source)).toEqual({
            body: source,
            activation: null,
            format: 'none',
            editable: true,
        })

        const wrapped = compilePromptV2Text(source, activation('and'))
        const parsed = parsePromptV2Text(wrapped)
        expect(parsed.body).toBe(source)
        expect(parsed.activation).toEqual(activation('and'))
        expect(compilePromptV2Text(parsed.body, null)).toBe(source)
    })

    test('builds a grouped master list from the existing toggle DSL', () => {
        const tree = parsePromptV2ToggleTree([
            'prefill=비망록 프리필',
            '-=🐶 누렁이=group',
            'OOC=아웃오브캐릭터=select=없음,어시스턴트,캐릭터',
            'jail=정조대=select=없음,강화',
            '-==groupEnd',
            'memo=메모=text',
        ].join('\n'))

        expect(tree.definitions.map(({ key, label, group, type }) => ({ key, label, group, type }))).toEqual([
            { key: 'toggle_prefill', label: '비망록 프리필', group: undefined, type: 'switch' },
            { key: 'toggle_OOC', label: '아웃오브캐릭터', group: '🐶 누렁이', type: 'select' },
            { key: 'toggle_jail', label: '정조대', group: '🐶 누렁이', type: 'select' },
            { key: 'toggle_memo', label: '메모', group: undefined, type: 'text' },
        ])
        expect(tree.items[1]).toMatchObject({ type: 'group', label: '🐶 누렁이' })
    })

    test('persists isolated preview values per prompt preset and resets to current defaults', () => {
        const definitions = parsePromptV2ToggleTree([
            'enabled=활성화',
            'mode=모드=select=없음,강화',
        ].join('\n')).definitions
        const values = new Map<string, string>()
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        }

        savePromptV2PreviewState('preset-a', definitions, {
            toggle_enabled: '1',
            toggle_mode: '1',
            unrelated: 'do-not-store',
        }, storage)

        expect(loadPromptV2PreviewState('preset-a', definitions, {
            toggle_enabled: '0',
            toggle_mode: '0',
        }, storage)).toEqual({
            toggle_enabled: '1',
            toggle_mode: '1',
        })
        expect(loadPromptV2PreviewState('preset-b', definitions, {
            toggle_enabled: '0',
            toggle_mode: '0',
        }, storage)).toEqual({
            toggle_enabled: '0',
            toggle_mode: '0',
        })

        clearPromptV2PreviewState('preset-a', storage)
        expect(loadPromptV2PreviewState('preset-a', definitions, {
            toggle_enabled: '0',
            toggle_mode: '0',
        }, storage)).toEqual({
            toggle_enabled: '0',
            toggle_mode: '0',
        })
    })

    test('uses empty defaults for text controls and zero defaults for switches and selects', () => {
        const definitions = parsePromptV2ToggleTree([
            'enabled=활성화',
            'mode=모드=select=없음,강화',
            'memo=메모=text',
            'notes=노트=textarea',
        ].join('\n')).definitions
        const values = new Map<string, string>()
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        }

        expect(createPromptV2PreviewValues(definitions)).toEqual({
            toggle_enabled: '0',
            toggle_mode: '0',
            toggle_memo: '',
            toggle_notes: '',
        })

        savePromptV2PreviewState('typed-defaults', definitions, {}, storage)
        expect(loadPromptV2PreviewState('typed-defaults', definitions, {}, storage)).toEqual({
            toggle_enabled: '0',
            toggle_mode: '0',
            toggle_memo: '',
            toggle_notes: '',
        })
    })
})
