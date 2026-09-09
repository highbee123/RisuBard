<script lang="ts">
    import { language } from 'src/lang'
    import { api } from 'src/ts/preset/pageFold/runtime.mjs'
    import { alertConfirm } from 'src/ts/alert'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import SettingTabs from 'src/lib/UI/GUI/SettingTabs.svelte'
    import PageFoldSummary from './PageFoldSummary.svelte'

    let { open = $bindable(false), presetId = '' }: { open?: boolean, presetId?: string } = $props()
    const l = language.pageFold
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'
    type Row = { id: number, timestamp: number, model: string, inputTokens?: number, outputTokens?: number, durationMs?: number, aborted?: boolean, success?: boolean, requestBody?: string, responseBody?: string, requestHeaders?: string, pageFold: Record<string, any> }
    type Report = { total: Record<string, number>, byModel: Record<string, any>[], daily: Record<string, any>[], rows: Row[], nextBefore?: string, filters: { presets: { id: string, name: string }[], models: string[], providers: string[], sources: string[] } }
    let scope = $state(''), period = $state('0'), model = $state('')
    let report = $state<Report | null>(null), rows = $state<Row[]>([])
    let loading = $state(false), error = $state('')
    let sequence = 0
    $effect(() => { scope = presetId })
    const query = $derived('?preset=' + encodeURIComponent(scope) + '&model=' + encodeURIComponent(model) + '&since=' + (Number(period) ? Date.now() - Number(period) * 86400000 : 0))
    async function load(q: string, append = false) {
        const seq = ++sequence
        loading = true; error = ''
        try {
            const data: Report = await api(q + (append && report?.nextBefore ? '&before=' + report.nextBefore : ''))
            if (seq !== sequence) return
            report = data; rows = append ? [...rows, ...data.rows] : data.rows
        } catch (e) { if (seq === sequence) error = e instanceof Error ? e.message : String(e) }
        finally { if (seq === sequence) loading = false }
    }
    $effect(() => { if (open) { void load(query); return () => { ++sequence } } })
    async function exportLogs() {
        if (!await alertConfirm(l.exportConfirm)) return
        try {
            const data = await api('?export=1')
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
            const link = document.createElement('a')
            link.href = url; link.download = 'pagefold-logs-' + new Date().toISOString().slice(0, 10) + '.json'; link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (e) { error = e instanceof Error ? e.message : String(e) }
    }
    async function reset() {
        if (!await alertConfirm(l.resetConfirm)) return
        try { await api('', { method: 'DELETE' }); await load(query) }
        catch (e) { error = e instanceof Error ? e.message : String(e) }
    }
    let detailOpen = $state(false), detail = $state<Row | null>(null), detailError = $state(''), selectedTab = $state(3)
    let detailSequence = 0
    async function openDetail(id: number) {
        const seq = ++detailSequence
        detailOpen = true; detail = null; detailError = ''; selectedTab = 3
        try { const data = await api('/' + id); if (seq === detailSequence) detail = data.content }
        catch (e) { if (seq === detailSequence) detailError = e instanceof Error ? e.message : String(e) }
    }
    const detailText = $derived.by(() => {
        if (!detail) return ''
        const views = [detail.requestBody, detail.pageFold?.pdfContent, detail.responseBody,
            JSON.stringify({ ...detail, requestBody: undefined, responseBody: undefined, requestHeaders: undefined, pageFold: { ...detail.pageFold, pdfContent: undefined } }, null, 2)]
        const text = views[selectedTab]
        try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text ?? l.missingBody }
    })
</script>

{#snippet statsTable(title: string, headers: string[], values: unknown[][])}
    <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden mb-4">
        <h3 class="px-3 py-2 border-b border-darkborderc/50 text-textcolor text-sm font-semibold">{title}</h3>
        <div class="overflow-x-auto">
            <table class="w-full text-xs">
                <thead><tr class="text-textcolor2 border-b border-darkborderc/50">
                    {#each headers as header}<th class="px-3 py-2 text-left font-medium whitespace-nowrap">{header}</th>{/each}
                </tr></thead>
                <tbody>{#each values as cells}<tr class="border-b border-darkborderc/30 hover:bg-selected/20">
                    {#each cells as value}<td class="px-3 py-2 text-textcolor tabular-nums whitespace-nowrap">{typeof value === 'number' ? n(value) : String(value ?? '—')}</td>{/each}
                </tr>{/each}</tbody>
            </table>
        </div>
    </div>
{/snippet}

<ShDialog bind:open size="xl" tier="base" closeOnEscape>
    {#snippet title()}{l.statsTitle}{/snippet}
    <div class="flex flex-wrap items-center gap-2 mb-4">
        <ShSelect bind:value={scope} size="sm">
            <OptionInput value="">{l.allPresets}</OptionInput>
            {#if scope && !report?.filters.presets.some(p => p.id === scope)}<OptionInput value={scope}>{l.currentPreset}</OptionInput>{/if}
            {#each report?.filters.presets ?? [] as p}<OptionInput value={p.id}>{p.name}</OptionInput>{/each}
        </ShSelect>
        <ShSelect bind:value={period} size="sm">
            {#each [['0', l.allPeriod], ['7', l.days7], ['30', l.days30], ['90', l.days90]] as [value, label]}<OptionInput {value}>{label}</OptionInput>{/each}
        </ShSelect>
        <ShSelect bind:value={model} size="sm">
            <OptionInput value="">{l.allModels}</OptionInput>
            {#if model && !report?.filters.models.includes(model)}<OptionInput value={model}>{model}</OptionInput>{/if}
            {#each report?.filters.models ?? [] as value}<OptionInput {value}>{value}</OptionInput>{/each}
        </ShSelect>
        <ShButton size="sm" variant="outline" disabled={loading} onclick={() => load(query)}>{l.refresh}</ShButton>
        <ShButton size="sm" variant="outline" onclick={exportLogs}>{l.export}</ShButton>
        <ShButton size="sm" variant="destructive" onclick={reset}>{l.reset}</ShButton>
    </div>
    {#if error}<p class="text-sm text-draculared">{error}</p>{/if}
    {#if loading && !report}<p class="text-sm text-textcolor2 py-8 text-center">{l.loading}</p>{/if}
    {#if report}
        <PageFoldSummary total={report.total} />
        <p class="text-xs text-textcolor2 my-4">{l.comparisonHelp}</p>
        {@render statsTable(l.byModel, [l.modelProvider, l.requests, l.successes, l.input, l.output, l.saved], report.byModel.map(r => [r.model + ' / ' + r.provider, r.requests, r.successes, r.inputKnown ? r.inputTokens : null, r.outputKnown ? r.outputTokens : null, r.comparableRequests ? r.savedTokens : null]))}
        {@render statsTable(l.daily, [l.date, l.requests, l.successRate, l.input, l.saved], report.daily.map(r => [r.day, r.requests, n(r.successes / r.requests * 100) + '%', r.inputKnown ? r.inputTokens : null, r.comparableRequests ? r.savedTokens : null]))}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            <h3 class="px-3 py-2 border-b border-darkborderc/50 text-textcolor text-sm font-semibold">{l.recent}</h3>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead><tr class="text-textcolor2 border-b border-darkborderc/50">
                        {#each [l.time, l.preset, l.title, l.inputFlow, l.rate, l.output, l.duration, l.status, l.detail] as header}<th class="px-3 py-2 text-left font-medium whitespace-nowrap">{header}</th>{/each}
                    </tr></thead>
                    <tbody>{#each rows as row (row.id)}
                        <tr class="border-b border-darkborderc/30 hover:bg-selected/20">
                            {#each [new Date(row.timestamp).toLocaleString(), row.pageFold?.presetName ?? row.model, n(row.pageFold?.pages), n(row.pageFold?.baselineTokens) + ' → ' + n(row.inputTokens), row.pageFold?.baselineTokens > 0 && row.pageFold.savedTokens != null ? n(row.pageFold.savedTokens / row.pageFold.baselineTokens * 100) + '%' : l.incomparable, n(row.outputTokens), n(row.durationMs == null ? null : row.durationMs / 1000), row.aborted ? l.aborted : row.success ? l.successes : l.failed] as value}
                                <td class="px-3 py-2 text-textcolor whitespace-nowrap tabular-nums">{value}</td>
                            {/each}
                            <td class="px-3 py-2"><ShButton size="xs" variant="ghost" onclick={() => openDetail(row.id)}>{l.detail}</ShButton></td>
                        </tr>
                    {/each}</tbody>
                </table>
            </div>
        </div>
        {#if report.nextBefore}<ShButton size="sm" variant="outline" disabled={loading} onclick={() => load(query, true)}>{l.more}</ShButton>{/if}
    {/if}
</ShDialog>
{#if detailOpen}
    <ShDialog bind:open={detailOpen} size="xl" tier="alert" closeOnEscape>
        {#snippet title()}{l.detailTitle}{/snippet}
        <SettingTabs bind:selected={selectedTab} tabs={[l.requestBody, l.pdfBody, l.responseBody, l.metadata].map((label, value) => ({ label, value }))} />
        {#if detailError}<p class="text-sm text-draculared">{detailError}</p>
        {:else if !detail}<p class="text-sm text-textcolor2">{l.loading}</p>
        {:else}<pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 max-h-[55vh] overflow-y-auto text-textcolor font-mono text-xs">{detailText}</pre>{/if}
    </ShDialog>
{/if}
