import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

function root(name: string) {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
    roots.push(value)
    return value
}

function writeV2(dataRoot: string, label: string, bytes: Buffer) {
    const value = {
        characters: [{
            chaId: 'shared-character-id',
            name: '동일 캐릭터',
            description: 'shared-module-id',
            image: 'assets/shared.png',
            modules: ['shared-module-id'],
            chats: [{ id: 'chat-1', name: '대화', message: [{ role: 'user', data: label }] }],
        }],
        modules: [{ id: 'shared-module-id', name: '동일 모듈', description: label }],
        personas: [],
        botPresets: [],
        loreBook: [],
    }
    createUserDataRepository({
        dataRoot,
        formatVersion: 2,
        readAsset: (key: string) => key === 'assets/shared.png' ? bytes : null,
    }).importLegacyDatabase(value, {
        mode: 'replace',
        strictAssets: true,
        allAssetKeys: ['assets/shared.png'],
    })
    return value
}

function snapshot(dataRoot: string) {
    const result: Record<string, string> = {}
    const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(absolute)
            else result[path.relative(dataRoot, absolute)] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
        }
    }
    visit(dataRoot)
    return result
}

describe('V2 item import', () => {
    it('previews entities and their dependencies without changing the source', () => {
        const sourceRoot = root('rb-v2-source')
        const targetRoot = root('rb-v2-target')
        writeV2(sourceRoot, 'source', Buffer.from('source-image'))
        writeV2(targetRoot, 'target', Buffer.from('target-image'))
        const moduleFile = path.join(sourceRoot, 'modules/동일 모듈/module.json')
        const editedModule = JSON.parse(fs.readFileSync(moduleFile, 'utf8'))
        editedModule.name = '디스크에서 수정한 모듈'
        fs.writeFileSync(moduleFile, JSON.stringify(editedModule, null, 2))
        const before = snapshot(sourceRoot)

        const { createV2ItemImportService } = require('./v2-item-import.cjs')
        const preview = createV2ItemImportService({ targetRoot }).preview(sourceRoot)

        expect(preview.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'character', id: 'shared-character-id', name: '동일 캐릭터' }),
            expect.objectContaining({ kind: 'module', id: 'shared-module-id', name: '디스크에서 수정한 모듈' }),
        ]))
        expect(preview.items.find((item: any) => item.kind === 'character').dependencies)
            .toContainEqual(expect.objectContaining({ kind: 'module', id: 'shared-module-id', name: '디스크에서 수정한 모듈' }))
        expect(snapshot(sourceRoot)).toEqual(before)
    })

    it('atomically imports a selection, dependencies, references, and colliding assets', () => {
        const sourceRoot = root('rb-v2-source')
        const targetRoot = root('rb-v2-target')
        writeV2(sourceRoot, 'source', Buffer.from('source-image'))
        writeV2(targetRoot, 'target', Buffer.from('target-image'))
        const sourceBefore = snapshot(sourceRoot)

        const { createV2ItemImportService } = require('./v2-item-import.cjs')
        const result = createV2ItemImportService({ targetRoot }).execute({
            sourceRoot,
            selection: [{ kind: 'character', id: 'shared-character-id' }],
            includeDependencies: true,
        })

        const reopened = createUserDataRepository({ dataRoot: targetRoot })
        const merged = reopened.exportLegacyDatabase()
        expect(result.imported).toEqual({ characters: 1, modules: 1, personas: 0, prompts: 0, lorebooks: 0 })
        expect(merged.characters).toHaveLength(2)
        expect(merged.modules).toHaveLength(2)
        const importedCharacter = merged.characters.find((item: any) => item.chats?.[0]?.message?.[0]?.data === 'source')
        const importedModule = merged.modules.find((item: any) => item.description === 'source')
        expect(importedCharacter.chaId).not.toBe('shared-character-id')
        expect(importedModule.id).not.toBe('shared-module-id')
        expect(importedCharacter.modules).toEqual([importedModule.id])
        expect(importedCharacter.description).toBe('shared-module-id')
        expect(importedCharacter.image).not.toBe('assets/shared.png')

        const { readOwnedAsset, readOwnedAssetIndex } = require('./owned-assets.cjs')
        const assetIndex = readOwnedAssetIndex(targetRoot)
        expect(readOwnedAsset(targetRoot, 'assets/shared.png', assetIndex)?.toString()).toBe('target-image')
        expect(readOwnedAsset(targetRoot, importedCharacter.image, assetIndex)?.toString()).toBe('source-image')
        expect(fs.existsSync(path.join(targetRoot, 'characters/동일 캐릭터 (2)/character.json'))).toBe(true)
        expect(fs.existsSync(path.join(targetRoot, 'modules/동일 모듈 (2)/module.json'))).toBe(true)
        expect(snapshot(sourceRoot)).toEqual(sourceBefore)
    })

    it('leaves the target untouched when a referenced source asset is missing', () => {
        const sourceRoot = root('rb-v2-source')
        const targetRoot = root('rb-v2-target')
        writeV2(sourceRoot, 'source', Buffer.from('source-image'))
        writeV2(targetRoot, 'target', Buffer.from('target-image'))
        const { readOwnedAssetIndex } = require('./owned-assets.cjs')
        const sourceIndex = readOwnedAssetIndex(sourceRoot)
        fs.unlinkSync(path.join(sourceRoot, sourceIndex.entries['assets/shared.png'].paths[0]))
        const before = snapshot(targetRoot)

        const { createV2ItemImportService } = require('./v2-item-import.cjs')
        expect(() => createV2ItemImportService({ targetRoot }).execute({
            sourceRoot,
            selection: [{ kind: 'character', id: 'shared-character-id' }],
            includeDependencies: true,
        })).toThrow(/asset|missing|unreadable/i)

        expect(snapshot(targetRoot)).toEqual(before)
        expect(fs.readdirSync(path.join(targetRoot, '.journal'))).toEqual([])
    })

    it('restores the exact target snapshot when publication fails after it begins', () => {
        const sourceRoot = root('rb-v2-source')
        const targetRoot = root('rb-v2-target')
        writeV2(sourceRoot, 'source', Buffer.from('source-image'))
        writeV2(targetRoot, 'target', Buffer.from('target-image'))
        const before = snapshot(targetRoot)
        const { createV2ItemImportService } = require('./v2-item-import.cjs')

        expect(() => createV2ItemImportService({ targetRoot, failAfterPublish: 1 }).execute({
            sourceRoot,
            selection: [{ kind: 'character', id: 'shared-character-id' }],
        })).toThrow(/simulated/)

        expect(snapshot(targetRoot)).toEqual(before)
        expect(fs.readdirSync(path.join(targetRoot, '.journal'))).toEqual([])
    })

    it('rejects execution when the previewed source snapshot has changed', () => {
        const sourceRoot = root('rb-v2-source')
        const targetRoot = root('rb-v2-target')
        writeV2(sourceRoot, 'source', Buffer.from('source-image'))
        writeV2(targetRoot, 'target', Buffer.from('target-image'))
        const before = snapshot(targetRoot)
        const { createV2ItemImportService } = require('./v2-item-import.cjs')
        const service = createV2ItemImportService({ targetRoot })
        const preview = service.preview(sourceRoot)
        const moduleFile = path.join(sourceRoot, 'modules/동일 모듈/module.json')
        const module = JSON.parse(fs.readFileSync(moduleFile, 'utf8'))
        module.name = 'changed after preview'
        fs.writeFileSync(moduleFile, JSON.stringify(module, null, 2))

        expect(() => service.execute({
            sourceRoot,
            revision: preview.revision,
            selection: [{ kind: 'character', id: 'shared-character-id' }],
        })).toThrow(/preview|changed/i)
        expect(snapshot(targetRoot)).toEqual(before)
    })
})
