import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, state, prepare, finalizeLogs, sanitize, wrapFetch } from './runtime.mjs'
import { generateTranscriptPdf } from './vendor.mjs'
import { sendGoogleChatRequest, streamGoogleChatRequest } from '../adapter/googleGemini'
import { sendChatRequest } from '../adapter/openaiCompatible'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import type { AdapterChatMessage } from '../adapter/types'

const preset = (modelId = 'gemini-demo', enabled = true): any => ({
    id: 'preset-1', name: '프리셋', userValues: {},
    pageFold: { enabled, packagingMode: 'maximum', fontSize: 1, mergeConsecutiveRoles: false, inputPrice: 1 },
    profileSnapshot: {
        profileId: 'test', providerBaseId: 'google', adapterKind: 'google-gemini', modelId,
        auth: { kind: 'x-goog-api-key', fields: ['apiKey'] }, endpoint: { kind: 'static', url: 'https://example.test/v1beta/models' },
        schema: [], defaults: { generationConfig: { temperature: .7, topP: .8 } },
    },
})
const messages = [{ role: 'system', content: '시스템 지시' }, { role: 'user', content: '안녕\n두 번째 줄' }] as any
const response = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '첫째\\n둘째' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } }), { headers: { 'content-type': 'application/json' } })

// Mirrors googleGemini.test.ts fixtures for the existing structured-output test.
function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:google',
        profileVersion: 1,
        providerBaseId: 'google',
        providerBaseVersion: 1,
        adapterKind: 'google-gemini',
        auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1beta/models' },
        modelId: 'gemini-demo',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                default: 'gemini-demo',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-google',
        name: 'Gemini',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

const messagesWithSystem: AdapterChatMessage[] = [
    { role: 'system', content: 'You are factual.' },
    { role: 'user', content: 'Hi' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

function captureFetch(response: Response | (() => Response)): {
    fetchImpl: typeof fetch
    calls: CapturedCall[]
} {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = init?.headers as Record<string, string> | undefined
        const body = init?.body != null ? JSON.parse(init.body as string) : {}
        calls.push({
            url,
            method: (init?.method ?? 'GET') as string,
            headers: headers ?? {},
            body,
        })
        return typeof response === 'function' ? response() : response
    }
    return { fetchImpl, calls }
}

beforeEach(() => configure({}))
describe('PageFold preset eligibility and wire behavior', () => {
    it('uses the effective model ID, never the display name; stale flags cannot enable non-Gemini', () => {
        const p = preset('claude'); p.name = 'Gemini'; expect(state(p).active).toBe(false)
        p.profileSnapshot.schema = [{ key: 'modelId', default: 'google/GEMINI-test' }]
        expect(state(p).active).toBe(true)
        p.userValues.modelId = 'gpt-test'; expect(state(p).active).toBe(false)
        p.userValues.modelId = ''; expect(state(p).eligible).toBe(false)
        p.userValues.modelId = 'gemini-test'; p.pageFold.enabled = false; expect(state(p).active).toBe(false)
    })
    it('OFF returns identical object without generating PDF or mutating the request', async () => {
        const original: any = { body: { contents: ['original'] } }; const copy = structuredClone(original)
        expect(await prepare(original, preset('gemini-demo', false), { messages }, 'google')).toBe(original)
        expect(original).toEqual(copy)
    })
    it('native Gemini preserves auth, endpoint and generation settings while converting input', async () => {
        const preset = makePreset({
            pageFold: { enabled: true, packagingMode: 'maximum', fontSize: 1, mergeConsecutiveRoles: false },
            userValues: { modelId: 'gemini-3.1-pro-preview' },
            customBody: {
                generationConfig: {
                    temperature: 0.25,
                    maxOutputTokens: 8192,
                    thinkingConfig: {
                        thinkingLevel: 'high',
                        includeThoughts: true,
                    },
                    responseMimeType: 'text/plain',
                    responseSchema: { type: 'string' },
                },
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [{
                    content: { parts: [{ text: '{"operations":[]}' }] },
                }],
            }),
        )

        await sendGoogleChatRequest(
            preset,
            {
                messages: messagesWithSystem,
                fetchImpl,
                temperature: 0,
                maxOutputTokens: 4096,
                reasoningEffort: 'minimal',
                responseSchema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        schemaVersion: { const: 2 },
                        operations: {
                            type: 'array',
                            items: {
                                oneOf: [
                                    { type: 'object' },
                                    { type: 'string' },
                                ],
                            },
                        },
                    },
                },
            },
            { apiKey: 'k' },
        )

        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-3.1-pro-preview:generateContent')
        expect(calls[0].headers['x-goog-api-key']).toBe('k')
        const contents = calls[0].body.contents as any[]
        expect(contents[0].parts[0].inlineData.mimeType).toBe('application/pdf')
        expect(atob(contents[0].parts[0].inlineData.data)).toMatch(/^%PDF/)
        expect(calls[0].body.generationConfig).toEqual({
            mediaResolution: 'MEDIA_RESOLUTION_LOW',
            temperature: 0,
            maxOutputTokens: 4096,
            thinkingConfig: {
                thinkingLevel: 'low',
                includeThoughts: false,
            },
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'object',
                properties: {
                    schemaVersion: {
                        type: 'integer',
                        minimum: 2,
                        maximum: 2,
                    },
                    operations: {
                        type: 'array',
                        items: {
                            anyOf: [
                                { type: 'object' },
                                { type: 'string' },
                            ],
                        },
                    },
                },
            },
        })
    })
    it('forces LOW only for enabled native Gemini PDF requests, including streaming', async () => {
        const p = preset(); p.profileSnapshot.defaults.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_HIGH'
        const fetchImpl = vi.fn(async () => response())
        await sendGoogleChatRequest(p, { messages, fetchImpl }, { apiKey: 'k' })
        expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW')
        p.pageFold.enabled = false
        await sendGoogleChatRequest(p, { messages, fetchImpl }, { apiKey: 'k' })
        expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH')
        p.pageFold.enabled = true
        p.profileSnapshot.modelId = 'other-model'
        await sendGoogleChatRequest(p, { messages, fetchImpl }, { apiKey: 'k' })
        expect(JSON.parse((fetchImpl.mock.calls[2] as any)[1].body).generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH')
        p.profileSnapshot.modelId = 'gemini-demo'
        const streamFetch = vi.fn(async () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
        for await (const delta of streamGoogleChatRequest(p, { messages, fetchImpl: streamFetch }, { apiKey: 'k' })) { /* drain */ }
        expect(JSON.parse((streamFetch.mock.calls[0] as any)[1].body).generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW')
    })
    it('OpenAI compatible requests retain extra parameters and existing plugin entries', async () => {
        const p = preset('google/gemini-demo'); p.profileSnapshot.adapterKind = 'openai-compatible'; p.profileSnapshot.providerBaseId = 'openrouter'
        p.profileSnapshot.endpoint.url = 'https://example.test/chat/completions'; p.profileSnapshot.auth = { kind: 'bearer' }
        p.profileSnapshot.defaults = { temperature: .6, reasoning: { effort: 'high' }, plugins: [{ id: 'response-healing' }] }
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { headers: { 'content-type': 'application/json' } }))
        await sendChatRequest(p, { messages, fetchImpl }, { apiKey: 'test-key' })
        const init = (fetchImpl.mock.calls[0] as any)[1]; const body = JSON.parse(init.body)
        expect(body.temperature).toBe(.6); expect(body.reasoning.effort).toBe('high')
        expect(body.generationConfig).toBeUndefined()
        expect(body.plugins).toEqual([{ id: 'response-healing' }, { id: 'file-parser', pdf: { engine: 'native' } }])
        expect(body.messages[1].content[0].file.file_data).toMatch(/^data:application\/pdf;base64,/)
    })
    it('preserves images and opaque tool messages; excludes incompatible token comparisons', async () => {
        const p = preset(); const input: any = [messages[0], { ...messages[1], images: [{ mime: 'image/png', base64: 'YWJj' }] }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', arguments: '{}' }], providerEcho: [{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'opaque' }] }, { role: 'tool', content: 'result', name: 'lookup', toolCallId: 't1' }]
        const fetchImpl = vi.fn(async () => response())
        await sendGoogleChatRequest(p, { messages: input, tools: [{ name: 'lookup', parameters: {} }], fetchImpl }, { apiKey: 'k' })
        const init = (fetchImpl.mock.calls[0] as any)[1]; const body = JSON.parse(init.body)
        expect(body.contents[0].parts.some((p: any) => p.inlineData?.mimeType === 'image/png')).toBe(true)
        expect(body.contents[1].parts[0].thoughtSignature).toBe('opaque')
        expect(body.contents[2].parts[0].functionResponse.response.result).toBe('result')
        expect(init.__pageFold.comparable).toBe(false)
    })
    it('abort before preparation never sends a request', async () => {
        const c = new AbortController(); c.abort(); const fetchImpl = vi.fn()
        await expect(sendGoogleChatRequest(preset(), { messages, fetchImpl, abortSignal: c.signal }, { apiKey: 'k' })).rejects.toThrow()
        expect(fetchImpl).not.toHaveBeenCalled()
    })
    it('balanced mode keeps system instructions outside the PDF and disables cachedContent', async () => {
        const p = preset(); p.pageFold.packagingMode = 'balanced'
        const body: any = { url: 'https://example.test', body: { contents: [], cachedContent: 'old' } }
        const result = await prepare(body, p, { messages }, 'google')
        expect(result.body.systemInstruction.parts[0].text).toContain('시스템 지시')
        expect(result.__pageFold.pdfContent).not.toContain('시스템 지시')
        expect(result.body.cachedContent).toBeUndefined()
    })
})
describe('PageFold usage and response correctness', () => {
    it('keeps negative savings and valid zero usage; drops bodies when logging is off', () => {
        const rows: any = [{ success: true, pageFold: { kind: 'google', comparable: true, baselineTokens: 10, inputPrice: 1, pdfContent: 'secret' }, responseBody: JSON.stringify({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }) }]
        finalizeLogs(rows, false)
        expect(rows[0].pageFold.savedTokens).toBe(-10)
        expect(rows[0].outputTokens).toBe(3)
        expect(rows[0].reasoningTokens).toBe(2)
        expect(rows[0].pageFold.responseTokens).toBe(3)
        expect(rows[0].responseBody).toBeUndefined(); expect(rows[0].pageFold.pdfContent).toBeUndefined()
        rows[0].inputTokens = 0; finalizeLogs(rows, false); expect(rows[0].pageFold.savedTokens).toBe(10)
        expect(rows[0].pageFold.responseTokens).toBe(3)
    })
    it('does not invent usage or price when they are unavailable', () => {
        const rows: any = [{ success: true, pageFold: { comparable: true, baselineTokens: 100, inputPrice: null } }]
        finalizeLogs(rows, true)
        expect(rows[0].pageFold.savedTokens).toBeNull(); expect(rows[0].pageFold.savedUsd).toBeNull()
    })
    it('redacts authorization and inline binary content recursively', () => {
        expect(sanitize({ authorization: 'secret', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'base64' } }] })).toEqual({ authorization: '[인증정보 제거]', parts: [{ inlineData: { mimeType: 'application/pdf', data: '[첨부 데이터 생략]' } }] })
    })
    it('restores split newline markers in SSE and leaves code and reasoning intact', async () => {
        const frames = [
            { candidates: [{ content: { parts: [{ text: 'reason\\n', thought: true }, { text: 'first\\' }] } }] },
            { candidates: [{ content: { parts: [{ text: 'nsecond `code\\n`' }] }, finishReason: 'STOP' }] },
        ]
        const raw = frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('')
        const fetchImpl = vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }))
        const deltas = []
        for await (const delta of streamGoogleChatRequest(preset(), { messages, fetchImpl }, { apiKey: 'k' })) deltas.push(delta)
        expect(deltas[0].raw.candidates[0].content.parts[0].text).toBe('reason\\n')
        expect(deltas.map(d => d.textDelta).join('')).toBe('first\nsecond `code\\n`')
    })
    it('does not modify structured JSON responses', async () => {
        const r = new Response('{"escaped":"\\\\n"}', { headers: { 'content-type': 'application/json' } })
        const fn = wrapFetch(preset(), {}, { __pageFold: { structuredOutput: true } }, async () => r)
        expect(await fn('https://example.test', {})).toBe(r)
    })
    it('generates a nonempty Unicode PDF with an explicit text mapping', async () => {
        const pdf = await generateTranscriptPdf('한글 日本語 English\n줄바꿈', { fontSize: 1 })
        expect(pdf.pageCount).toBe(1)
        const text = new TextDecoder('latin1').decode(pdf.bytes)
        expect(text).toContain('/ToUnicode'); expect(text).toContain('%%EOF')
    })
})
