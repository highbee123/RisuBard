import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')

describe('bootstrap performance boundaries', () => {
    it('bootstraps native documents without a legacy database decode or backup fallback', () => {
        expect(source).toContain('await runtime.bootstrap()')
        expect(source).not.toMatch(/forageStorage\.(?:getItem|setItem)\('database\/database.bin'/)
        expect(source).not.toContain('await decodeRisuSave(')
        expect(source).not.toContain('await getDbBackups(')
    })

    it('keeps the default cleanup scan prefix-bounded', () => {
        expect(source).toContain("forageStorage.keys('remotes/')")
        expect(source).toContain("forageStorage.keys('assets/')")
        expect(source).toContain("forageStorage.keys('cache/plugin-storage/')")
        expect(source).not.toMatch(/forageStorage\.keys\(\s*\)/)
    })
})
