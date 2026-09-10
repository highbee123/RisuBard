import { describe, expect, it } from 'vitest'

const { decodeAssetBulkWrite } = require('./asset-bulk-protocol.cjs')

function payload(entries: Array<{ key: string, value: Buffer }>) {
    const keys = entries.map(entry => Buffer.from(entry.key))
    const body = Buffer.alloc(4 + entries.reduce((total, entry, index) => total + 8 + keys[index].length + entry.value.length, 0))
    let offset = 0
    body.writeUInt32BE(entries.length, offset); offset += 4
    for (let index = 0; index < entries.length; index++) {
        body.writeUInt32BE(keys[index].length, offset); offset += 4
        keys[index].copy(body, offset); offset += keys[index].length
        body.writeUInt32BE(entries[index].value.length, offset); offset += 4
        entries[index].value.copy(body, offset); offset += entries[index].value.length
    }
    return body
}

describe('binary asset bulk-write protocol', () => {
    it('decodes UTF-8 keys and unexpanded image bytes', () => {
        const entries = [{ key: 'assets/한글.webp', value: Buffer.from([0, 255, 1, 2]) }]
        expect(decodeAssetBulkWrite(payload(entries))).toEqual(entries)
    })

    it('rejects truncated and oversized batches', () => {
        expect(() => decodeAssetBulkWrite(Buffer.from([0, 0, 0]))).toThrow(/truncated/i)
        expect(() => decodeAssetBulkWrite(payload([{ key: 'a', value: Buffer.alloc(0) }]), { maxEntries: 0 })).toThrow(/too large/i)
    })
})
