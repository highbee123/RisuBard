import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('database.bin compatibility cache recovery', () => {
    it('exports native files on demand without restoring old SQLite or a monolithic cache', () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-native-adapter-'))
        roots.push(dataRoot)
        createUserDataRepository({ dataRoot, formatVersion: 2 }).importLegacyDatabase({
            characters: [{ chaId: 'a', name: 'Native', desc: 'current', chats: [] }],
            botPresets: [], modules: [], personas: [], loreBook: [],
        }, { mode: 'sync', strictAssets: true })
        fs.writeFileSync(path.join(dataRoot, 'settings/native-runtime.json'), JSON.stringify({ schemaVersion: 1, mode: 'native-documents' }))
        fs.writeFileSync(path.join(dataRoot, 'risuai.db'), 'obsolete source must not be opened')
        const script = [
            "const db = require('./server/node/db.cjs')",
            "if (!db.kvGet('database/database.bin')?.length) process.exit(2)",
            "if (db.kvSize('database/database.bin')) process.exit(3)",
            "process.stdout.write('native')",
        ].join(';')
        expect(execFileSync(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, RISUBARD_DATA_ROOT: dataRoot }, encoding: 'utf8',
        })).toBe('native')
    })

    it('rebuilds a deleted cache from canonical entity files', () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-cache-recovery-'))
        roots.push(dataRoot)
        createUserDataRepository({ dataRoot }).importLegacyDatabase({
            language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [],
            characters: [{ chaId: 'character-1', name: 'Canonical', chats: [] }],
        }, { mode: 'replace' })

        const script = [
            "const db = require('./server/node/db.cjs')",
            "const value = db.kvGet('database/database.bin')",
            "if (!value || !db.kvGet('database/database.bin')) process.exit(2)",
            "process.stdout.write(String(value.length))",
        ].join(';')
        const output = execFileSync(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, RISUBARD_DATA_ROOT: dataRoot },
            encoding: 'utf8',
        })
        expect(Number(output)).toBeGreaterThan(0)
    })
})
