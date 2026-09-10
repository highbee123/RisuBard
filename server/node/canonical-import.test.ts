import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { decodeImportDatabase, stageCanonicalDatabase } = require('./canonical-import.cjs')
const { encodeRisuSaveLegacy } = require('./utils.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function block(type: number, name: string, content: string) {
    const bytes = Buffer.from(content), label = Buffer.from(name)
    const header = Buffer.alloc(7 + label.length)
    header[0] = type; header[2] = label.length; label.copy(header, 3)
    header.writeUInt32LE(bytes.length, 3 + label.length)
    return Buffer.concat([header, bytes])
}
test.each(['invalid-json', 'truncated', 'missing-block'])('rejects %s in a block save instead of returning fewer characters', async kind => {
    const root = block(1, 'root', JSON.stringify({ __directory: ['character'], characters: [] }))
    let character = block(2, 'character', kind === 'invalid-json' ? '{' : JSON.stringify({ chaId: 'x', chats: [] }))
    if (kind === 'truncated') character = character.subarray(0, character.length - 2)
    if (kind === 'missing-block') character = Buffer.alloc(0)
    await expect(decodeImportDatabase(Buffer.concat([Buffer.from('RISUSAVE\0'), root, character]), () => null)).rejects.toThrow()
})
test('accepts a complete block-format save with no characters', async () => {
    const bytes = Buffer.concat([Buffer.from('RISUSAVE\0'), block(1, 'root', JSON.stringify({ __directory: [] }))])
    expect((await decodeImportDatabase(bytes, () => null)).characters).toEqual([])
})
test('hydrates cold chat bodies and compares extension fields through a complete file round-trip', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-canonical-import-')); roots.push(root)
    const db = { characters: [{ chaId: 'char', chats: [{ id: 'chat', message: [{ data: '\uEF01COLDSTORAGE\uEF01cold' }] }] }],
        extension: { empty: {}, key: 'private', values: [0, false, null, '한글'] } }
    const messages = [{ role: 'char', data: 'entire recovered body', extension: { note: true } }]
    const decoded = await decodeImportDatabase(encodeRisuSaveLegacy(db), (key: string) =>
        key === 'coldstorage/cold' ? Buffer.from(JSON.stringify(messages)) : null)
    const restored = stageCanonicalDatabase(root, decoded)
    expect(restored.characters[0].chats[0].message).toEqual(messages)
    expect(restored.extension).toEqual(db.extension)
})

test.each(['inline', 'empty', 'cold-chat', 'cold-character'])('imports a legacy hybrid %s chat without losing its payload', async source => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-hybrid-import-')); roots.push(root)
    const chat = { id: 'chat', name: 'Imported chat', _stub: true, folderId: 'folder', modules: ['module'],
        message: source === 'empty' ? [] : [{ role: 'char', data: 'Preserved conversation', extension: { swipes: ['alternate'] } }],
        localLore: [{ key: 'lore', content: 'Preserved lore' }], scriptstate: { score: 7 }, note: 'Preserved note' }
    const character = { chaId: 'char', chats: [chat] }
    const incoming = source === 'cold-character' ? { chaId: 'char', coldstorage: 'cold', chats: [] }
        : source === 'cold-chat' ? { ...character, chats: [{ ...chat, message: [{ data: '\uEF01COLDSTORAGE\uEF01cold' }] }] }
        : character
    const decoded = await decodeImportDatabase(encodeRisuSaveLegacy({ characters: [incoming] }), (key: string) =>
        key === 'coldstorage/cold' ? Buffer.from(JSON.stringify(source === 'cold-character' ? { character } : chat)) : null)
    const restored = stageCanonicalDatabase(root, decoded)
    const { _stub, ...expected } = chat
    expect(restored.characters[0].chats[0]).toEqual(expected)
})

test.each([undefined, null, 'invalid'])('still rejects a legacy stub with message=%s before saving canonical files', async message => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-incomplete-import-')); roots.push(root)
    const decoded = await decodeImportDatabase(encodeRisuSaveLegacy({
        characters: [{ chaId: 'char', chats: [{ id: 'chat', _stub: true, message }] }],
    }), () => null)
    expect(() => stageCanonicalDatabase(root, decoded)).toThrow('Incomplete chat: hydrate messages before saving canonical files')
    expect(fs.existsSync(path.join(root, 'characters'))).toBe(false)
})

test('strict staged import preserves all fields while assigning independent owner references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owner-import-')); roots.push(root)
    const db = { characters: [{ chaId: 'c', image: 'assets/a', chats: [] }], personas: [{ id: 'p', image: 'assets/a' }],
        modules: [], botPresets: [], loreBook: [], extension: { unchanged: [0, false, 'assets/not-owner'] } }
    const before = structuredClone(db)
    const restored = stageCanonicalDatabase(root, db, { strictAssets: true, readAsset: () => Buffer.from('image') })
    expect(restored.characters[0].image).not.toBe(restored.personas[0].image)
    expect(restored.extension).toEqual(before.extension)
    expect(db).toEqual(before)
})
