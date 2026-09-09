<script lang="ts">
    import { language } from 'src/lang'
    let { total, compact = false }: { total: Record<string, number>, compact?: boolean } = $props()
    const l = language.pageFold
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'
    const cards = $derived([
        [l.userRequests, n(total.userRequests)], [l.requests, n(total.requests)],
        [l.saved, n(total.comparableRequests ? total.savedTokens : null)],
        [l.savedUsd, total.pricedRequests ? '$' + total.savedUsd.toFixed(4) : l.unknownPrice],
    ])
    const details = $derived([
        [l.successes, n(total.successes)], [l.pages, n(total.pages)],
        [l.rate, total.baselineTokens > 0 ? n(total.savedTokens / total.baselineTokens * 100) + '%' : l.incomparable],
        [l.input, n(total.inputKnown ? total.inputTokens : null)],
        [l.output, n(total.outputKnown ? total.outputTokens : null)],
        [l.reasoning, n(total.reasoningKnown ? total.reasoningTokens : null)],
    ])
</script>
{#if !total.requests}
    <p class="text-sm text-textcolor2 py-2">{l.empty}</p>
{:else}
    {#if compact}
        <p class="text-xs text-textcolor2 leading-relaxed">{cards.map(([label, value]) => `${label}: ${value}`).join(' · ')}</p>
    {:else}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            {#each cards as [label, value]}
                <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
                    <div class="text-textcolor2 text-xs mb-1">{label}</div>
                    <div class="text-textcolor text-2xl font-semibold tabular-nums">{value}</div>
                </div>
            {/each}
        </div>
    {/if}
    <p class="text-xs text-textcolor2 leading-relaxed">{details.map(([label, value]) => `${label}: ${value}`).join(' · ')}</p>
{/if}
