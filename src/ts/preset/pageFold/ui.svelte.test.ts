import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync, tick } from 'svelte'
import { configure } from './runtime.mjs'
import ModelPresetPdfSettings from 'src/lib/Setting/Pages/Model/ModelPresetPdfSettings.svelte'
import PageFoldStats from 'src/lib/Setting/Pages/PageFoldStats.svelte'
import { language } from 'src/lang'

vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn(async () => true) }))
let mounted: ReturnType<typeof mount> | undefined
beforeEach(() => {
    configure({ authHeaders: async () => ({}) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ total: { requests: 0 } }))))
})
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('keeps PDF settings off by default, expands on enable and preserves PDF and cache settings across toggles and model changes', async () => {
    const preset: any = $state({ id: 'p', name: 'Existing', profileSnapshot: { modelId: 'gemini-demo' }, promptCaching: { enabled: true, ttlSec: 600 } })
    mounted = mount(ModelPresetPdfSettings, { target: document.body, props: { preset } })
    flushSync()
    let toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('[aria-label="' + language.pageFold.font + '"]')).toBeNull()
    expect(preset.pageFold).toBeUndefined()
    toggle.click(); flushSync()
    expect(preset.pageFold.enabled).toBe(true)
    expect(preset.promptCaching).toEqual({ enabled: true, ttlSec: 600 })
    expect(document.body.textContent).not.toContain(language.pageFold.usage)
    expect(document.body.textContent).toContain(language.pageFold.openStats)
    expect(document.body.textContent).toContain(language.pageFold.priceSettings)
    expect(fetch).not.toHaveBeenCalled()
    const font = document.querySelector<HTMLInputElement>('[aria-label="' + language.pageFold.font + '"]')!
    font.value = '2.5'; font.dispatchEvent(new Event('change', { bubbles: true })); flushSync()
    expect(preset.pageFold.fontSize).toBe(2.5)
    preset.profileSnapshot.modelId = 'claude-demo'; flushSync()
    expect(document.querySelector('[data-pagefold-settings]')).toBeNull()
    expect(document.querySelector('[aria-label="' + language.pageFold.font + '"]')).toBeNull()
    preset.profileSnapshot.modelId = 'google/GEMINI-demo'; flushSync()
    toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(preset.pageFold.fontSize).toBe(2.5)
    toggle.click(); flushSync()
    expect(document.querySelector('#pagefold-font')).toBeNull()
    expect(document.body.textContent).not.toContain(language.pageFold.priceSettings)
    expect(document.body.textContent).toContain(language.pageFold.openStats)
    expect(preset.promptCaching).toEqual({ enabled: true, ttlSec: 600 })
    expect(document.querySelector('[data-pagefold-settings]')?.classList.contains('border')).toBe(false)
    expect(document.querySelector('#pagefold-native-style')).toBeNull()
    await tick()
})

it('loads preset statistics and opens the selected request detail using the shared dialog', async () => {
    const record = { id: 1, timestamp: 1, model: 'gemini-demo', success: true, inputTokens: 20, outputTokens: 10, pageFold: { pages: 1, baselineTokens: 100, savedTokens: 80, pdfContent: 'PDF transcript' } }
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/1')
        ? { content: { ...record, requestBody: '{"request":true}', responseBody: '{"response":true}' } }
        : { total: { requests: 1, userRequests: 1, comparableRequests: 1, savedTokens: 80, baselineTokens: 100 }, rows: [record], byModel: [], daily: [], filters: { presets: [], models: [], providers: [], sources: [] } })))
    vi.stubGlobal('fetch', fetchMock)
    mounted = mount(PageFoldStats, { target: document.body, props: { open: true, presetId: 'p' } })
    await vi.waitFor(() => expect(document.body.textContent).toContain('gemini-demo'))
    expect(fetchMock.mock.calls[0][0]).toContain('preset=p')
    const detail = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === language.pageFold.detail)!
    detail.click()
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/1'))).toBe(true))
    await vi.waitFor(() => expect(document.body.textContent).toContain('gemini-demo'))
    const pdfTab = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === language.pageFold.pdfBody)!
    pdfTab.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('PDF transcript'))
})
