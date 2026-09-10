import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { encodeEntity, decodeEntity, entityFiles } = require('./named-entity-codec.cjs')
const { commitTransaction, atomicWriteJson, readVerifiedJson } = require('./file-store.cjs')
const roots: string[] = []
function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-named-codec-'))
    roots.push(root)
    return root
}
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function save(kind: string, entity: object, folder = `${kind}s/Example`) {
    const root = tempRoot()
    const operations = encodeEntity(kind, entity, folder)
    commitTransaction(root, operations)
    return { root, folder, operations }
}

describe('named entity canonical files', () => {
    it('preserves character fields and unknown extensions while extracting exact Markdown and lore arrays', () => {
        const entity = {
            chaId: 'c1', name: 'Alice', desc: '# Alice\r\n  trailing  ', firstMessage: '',
            personality: '', scenario: 'scene', systemPrompt: 'system', postHistoryInstructions: 'after', notes: 'notes',
            globalLore: [{ key: ['a', 'b'], content: 'Lore\n', extension: { enabled: false } }],
            localLore: [], lorebook: [{ content: 'other' }],
            alternateGreetings: ['one', '', 'three'], extension: { null: null, tuple: [true, 4, 'text'] },
        }
        const before = structuredClone(entity)
        const { root, folder, operations } = save('character', entity)
        expect(entity).toEqual(before)
        expect(fs.readFileSync(path.join(root, folder, 'description.md'), 'utf8')).toBe(entity.desc)
        expect(fs.readFileSync(path.join(root, folder, 'first_mes.md'), 'utf8')).toBe('')
        expect(readVerifiedJson(root, `${folder}/lorebook.json`)).toEqual(entity.globalLore)
        const metadata = readVerifiedJson(root, `${folder}/character.json`)
        expect(metadata).not.toHaveProperty('desc')
        expect(metadata).not.toHaveProperty('globalLore')
        expect(metadata.extension).toEqual(entity.extension)
        expect(decodeEntity(root, 'character', folder)).toEqual(entity)
        expect(entityFiles(root, 'character', folder).sort()).toEqual(operations.map((op: { path: string }) => op.path).sort())
    })

    it.each([
        ['module', 'module.json', { name: 'M', description: '', lorebook: [{ content: 'lore' }], custom: [1, null] }],
        ['persona', 'persona.json', { name: 'P', personaPrompt: 'p', prompt: '', description: 'desc', icon: 'asset/x' }],
        ['lorebook', 'lorebook.json', { name: 'L', data: [{ content: 'lore' }], globalLore: [], unknown: 'keep' }],
        ['chat', 'metadata.json', { name: 'Chat', note: 'note\r\n', localLore: [{ content: 'local' }], globalLore: [], custom: false }],
    ])('round-trips %s without adding absent fields', (kind, filename, entity) => {
        const { root, folder } = save(kind as string, entity as object)
        expect(fs.existsSync(path.join(root, folder, filename as string))).toBe(true)
        expect(decodeEntity(root, kind, folder)).toEqual(entity)
    })

    it('extracts indexed nested prompt text and preserves duplicate names, arrays, and unknown metadata', () => {
        const entity = {
            name: 'Prompt', mainPrompt: '', jailbreak: 'jail\r\n', globalNote: 'note', temperature: 0.8,
            promptTemplate: [
                { type: 'plain', name: 'Same/Name', text: 'first', role: 'system' },
                { type: 'plain', name: 'Same/Name', text: '', nested: { text: 'nested' } },
                { type: 'description', innerFormat: '{{slot}}', extra: ['leave', 1] },
            ],
            promptV2: { blocks: [{ name: 'Same', text: 'v2', activation: { conditions: [{ key: 'x', value: 'yes' }] } }], unknown: false },
            unknown: { text: 'not prompt content', values: [null, false] },
        }
        const { root, folder } = save('prompt', entity)
        const manifest = readVerifiedJson(root, `${folder}/manifest.json`)
        expect(manifest.schemaVersion).toBe(2)
        expect(Object.values(manifest.fieldFiles)).toContainEqual(['promptTemplate', 1, 'nested', 'text'])
        expect(Object.values(manifest.fieldFiles)).toContainEqual(['promptV2', 'blocks', 0, 'text'])
        expect(Object.values(manifest.fieldFiles)).not.toContainEqual(['unknown', 'text'])
        const secondFile = Object.keys(manifest.fieldFiles).find(name => JSON.stringify(manifest.fieldFiles[name]) === JSON.stringify(['promptTemplate', 1, 'text']))!
        fs.writeFileSync(path.join(root, folder, secondFile), 'Edited\r\n  ')
        entity.promptTemplate[1].text = 'Edited\r\n  '
        expect(decodeEntity(root, 'prompt', folder)).toEqual(entity)
    })

    it('requires every file declared by the manifest even if metadata has a fallback value', () => {
        const { root, folder } = save('character', { desc: 'required' })
        atomicWriteJson(root, `${folder}/character.json`, { desc: 'stale fallback' })
        fs.unlinkSync(path.join(root, folder, 'description.md'))
        expect(() => decodeEntity(root, 'character', folder)).toThrow(/ENOENT|missing/i)
    })

    it('accepts valid external JSON edits only through the explicit read option', () => {
        const { root, folder } = save('module', { description: 'desc', lorebook: [] })
        fs.writeFileSync(path.join(root, folder, 'lorebook.json'), '[{"content":"edited"}]')
        expect(() => decodeEntity(root, 'module', folder)).toThrow(/checksum/i)
        expect(decodeEntity(root, 'module', folder, { acceptExternalChanges: true })).toEqual({ description: 'desc', lorebook: [{ content: 'edited' }] })
    })

    it.each(['../escape.md', '/absolute.md', 'C:\\escape.md', 'nested/../../escape.md', 'nested\\..\\escape.md'])('rejects manifest filename %s', filename => {
        const { root, folder } = save('character', { desc: 'desc' })
        atomicWriteJson(root, `${folder}/manifest.json`, { schemaVersion: 2, kind: 'character', fieldFiles: { [filename]: ['desc'] } })
        expect(() => decodeEntity(root, 'character', folder)).toThrow(/path|manifest|relative/i)
        expect(() => entityFiles(root, 'character', folder)).toThrow(/path|manifest|relative/i)
    })

    it.each([['__proto__', 'polluted'], ['constructor', 'prototype', 'polluted'], [], ['unknown', -1]])('rejects unsafe property path %j', (...fieldPath) => {
        const { root, folder } = save('character', { desc: 'desc' })
        atomicWriteJson(root, `${folder}/manifest.json`, { schemaVersion: 2, kind: 'character', fieldFiles: { 'description.md': fieldPath } })
        expect(() => decodeEntity(root, 'character', folder)).toThrow(/field|path|manifest/i)
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
})
