import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
const require = createRequire(import.meta.url)
const { createRequestLogs } = require('./request-logs.cjs')
const { clean, summary } = require('./pagefold-logs.cjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) { if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('risubard-pagefold-test-')) throw Error('Unsafe test cleanup'); fs.rmSync(dir, { recursive: true, force: true }) } })
function setup() { const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-pagefold-test-')); dirs.push(saveDir); return { saveDir, logs: createRequestLogs({ saveDir }) } }
const row = (id: string, presetId='p1'): any => ({ url: 'https://example.test', category: 'llm', source: 'main', success: true, inputTokens: 20, outputTokens: 5, responseBody: 'response', requestBody: 'request', pageFold: { version: 1, requestId: id, presetId, pages: 1, baselineTokens: 100, savedTokens: 80, savedUsd: .00008, inputPrice: 1, comparable: true, pdfContent: 'PDF text' } })
describe('PageFold statistics use the existing log store', () => {
    it('stores details separately from durable usage and deduplicates the same attempt', () => {
        const { saveDir, logs } = setup()
        expect(logs.addRequestLogBatch([row('attempt1')])).toBe(1)
        expect(logs.addRequestLogBatch([row('attempt1')])).toBe(0)
        const detail = logs.getRequestLog(1)
        expect(detail.pageFold.pdfContent).toBe('PDF text')
        const usage = JSON.parse(fs.readFileSync(path.join(saveDir, 'request-logs', 'usage.jsonl'), 'utf8').trim())
        expect(usage.pageFold.savedTokens).toBe(80)
        expect(usage.pageFold.pdfContent).toBeUndefined()
        expect(usage.requestBody).toBeUndefined()
        logs.clearRequestLogs()
        expect(logs.queryUsage({}).total.requests).toBe(1)
    })
    it('preserves non-PDF usage and statistics fields across store reopening', () => {
        const { saveDir, logs } = setup()
        logs.addRequestLogBatch([{ ...row('normal'), pageFold: undefined }, row('pdf')])
        const reopened = createRequestLogs({ saveDir })
        expect(reopened.queryUsage({}).total.requests).toBe(2)
        expect(reopened.getRequestLog(2).pageFold.savedTokens).toBe(80)
    })
    it('counts increases against net savings and excludes unavailable comparisons', () => {
        const a = row('a'), b = row('b'), c = row('c')
        b.pageFold.savedTokens = -100; b.pageFold.savedUsd = -.0001
        c.pageFold.comparable = false; c.pageFold.savedTokens = null
        expect(summary([a,b,c]).savedTokens).toBe(-20)
        expect(summary([a,b,c]).comparableRequests).toBe(2)
        expect(summary([a,b,c]).requests).toBe(3)
    })
    it('redacts secrets from exported nested values', () => {
        expect(clean({ nested: { 'x-api-key': 'secret', access_token: 'secret' } })).toEqual({ nested: { 'x-api-key': '[Credentials redacted]', access_token: '[Credentials redacted]' } })
    })
})


it('filters statistics but exports all saved PDF logs and resets all PDF records', async () => {
    const { logs } = setup()
    logs.addRequestLogBatch([{...row('a'),model:'gemini-a',provider:'google'}, {...row('b','p2'),model:'gemini-b',provider:'google'}, {...row('normal'),pageFold:undefined}])
    const app = express(); logs.registerRoutes(app)
    const server = app.listen(0,'127.0.0.1')
    await new Promise<void>(resolve => server.once('listening',resolve))
    const url = 'http://127.0.0.1:'+(server.address() as any).port+'/api/request-logs/pagefold'
    try {
        const data = await (await fetch(url+'?preset=p1&model=gemini-a')).json()
        expect(data.total.requests).toBe(1); expect(data.daily).toHaveLength(1); expect(data.filters.presets).toHaveLength(2)
        expect(Object.keys(data.filters).sort()).toEqual(['models', 'presets'])
        const exported = await (await fetch(url+'?preset=p1&export=1')).json()
        expect(exported.logs).toHaveLength(2)
        expect(exported.logs.map((entry: any) => entry.pageFold.presetId).sort()).toEqual(['p1', 'p2'])
        expect(exported.logs[0].requestBody).toBe('request')
        logs.clearRequestLogs()
        const withoutDetails = await (await fetch(url+'?preset=p1&export=1')).json()
        expect(withoutDetails.logs).toHaveLength(0)
        expect((await fetch(url+'?preset=p1',{method:'DELETE'})).ok).toBe(true)
        expect(logs.queryUsage({}).total.requests).toBe(1)
        expect((await (await fetch(url)).json()).rows).toHaveLength(0)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
})

it('exports more than 1000 saved PDF records with redaction on every record', async () => {
    const { logs } = setup()
    const entries = Array.from({ length: 1002 }, (_, index) => ({
        ...row('export-' + index), requestHeaders: JSON.stringify({ authorization: 'secret-' + index }),
    }))
    for (let offset = 0; offset < entries.length; offset += 50) logs.addRequestLogBatch(entries.slice(offset, offset + 50))
    logs.addRequestLogBatch([{ ...row('non-pdf'), pageFold: undefined }])
    const app = express(); logs.registerRoutes(app)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
        const result = await (await fetch('http://127.0.0.1:' + (server.address() as any).port + '/api/request-logs/pagefold?export=1')).json()
        expect(result.logs).toHaveLength(1002)
        expect(result.logs.every((entry: any) => !entry.requestHeaders.includes('secret-') && entry.requestHeaders.includes('REDACTED'))).toBe(true)
        expect(new Set(result.logs.map((entry: any) => entry.pageFold.requestId)).size).toBe(1002)
        expect(logs.queryUsage({}).total.requests).toBe(1003)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
