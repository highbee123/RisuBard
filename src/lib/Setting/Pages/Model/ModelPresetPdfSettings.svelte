<script lang="ts">
    import { language } from 'src/lang'
    import type { ModelPreset, ModelPresetPdfConfig } from 'src/ts/preset/types'
    import { state as pdfState, config } from 'src/ts/preset/pageFold/runtime.mjs'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import ShAccordion from 'src/lib/UI/GUI/ShAccordion.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import PageFoldStats from '../PageFoldStats.svelte'

    let { preset }: { preset: ModelPreset } = $props()
    const l = language.pageFold
    const status = $derived(pdfState(preset))
    const settings = $derived(config(preset))
    let priceOpen = $state(false), statsOpen = $state(false)
    function save(values: Partial<ModelPresetPdfConfig>) {
        preset.pageFold = { ...settings, ...values } as ModelPresetPdfConfig
        preset.updatedAt = Date.now()
    }
    $effect(() => {
        preset.id
        priceOpen = false; statsOpen = false
    })
    $effect(() => { if (!status.active) statsOpen = false })
</script>

{#if status.eligible}
<div class="flex flex-col gap-4 mb-6" data-pagefold-settings>
    <h3 class="text-sm font-semibold text-textcolor2 uppercase tracking-wide">{l.title}</h3>
    <div class="flex items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-sm text-textcolor">{l.enable}</span>
            <span class="text-xs text-textcolor2">{status.eligible ? l.help : l.ineligible}</span>
        </div>
        <div class="flex items-center gap-3 shrink-0">
            <ShButton size="sm" variant="outline" onclick={() => statsOpen = true}>{l.openStats}</ShButton>
            <ShSwitch ariaLabel={l.enable} checked={status.active} disabled={!status.eligible}
                onCheckedChange={(enabled) => { if (status.eligible) save({ enabled }) }} />
        </div>
    </div>
    {#if status.active}
        <div class="flex flex-col gap-4 pl-4 py-2">
                <div class="flex items-center justify-between gap-3">
                    <span class="text-sm text-textcolor">{l.mode}</span>
                    <ShSelect value={settings.packagingMode} onchange={(e) => save({ packagingMode: e.currentTarget.value as 'maximum' | 'balanced' })} className="max-w-64">
                        <OptionInput value="maximum">{l.maximum}</OptionInput>
                        <OptionInput value="balanced">{l.balanced}</OptionInput>
                    </ShSelect>
                </div>
                <div class="flex items-center justify-between gap-3">
                    <label for="pagefold-font" class="text-sm text-textcolor">{l.font}</label>
                    <ShInput id="pagefold-font" aria-label={l.font} type="number" min={0.5} max={12} step={0.1} className="w-32 shrink-0"
                        value={String(settings.fontSize)} onchange={(e) => save({ fontSize: e.currentTarget.value ? Number(e.currentTarget.value) : 1 })} />
                </div>
                <div class="flex items-center justify-between gap-3">
                    <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-sm text-textcolor">{l.merge}</span>
                        <span class="text-xs text-textcolor2">{l.mergeHelp}</span>
                    </div>
                    <ShSwitch ariaLabel={l.merge} checked={settings.mergeConsecutiveRoles} onCheckedChange={(mergeConsecutiveRoles) => save({ mergeConsecutiveRoles })} />
                </div>

    <ShAccordion name={l.priceSettings} variant="plain" bind:open={priceOpen}
        class="[&>div:first-child>button]:px-0 [&>div:first-child>button]:text-sm [&>div:first-child>button]:font-normal [&>div:first-child>button]:text-textcolor">
        <div class="flex flex-col gap-2 pl-4 py-2">
            <div class="flex items-center justify-between gap-3">
                <label for="pagefold-price" class="text-sm text-textcolor">{l.price}</label>
                <ShInput id="pagefold-price" type="number" min={0} step={0.0001} placeholder={l.unknownPrice} className="w-32 shrink-0"
                    value={settings.inputPrice == null ? '' : String(settings.inputPrice)} onchange={(e) => save({ inputPrice: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })} />
            </div>
            <p class="text-xs text-textcolor2">{l.priceHelp}</p>
        </div>
    </ShAccordion>
        </div>
    {/if}
</div>
{#if statsOpen}<PageFoldStats bind:open={statsOpen} presetId={preset.id} />{/if}
{/if}
