<script lang="ts">
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import PageFoldStats from './PageFoldStats.svelte'
    let open = $state(false)
</script>
<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
    <div class="flex flex-col gap-0.5 min-w-0">
        <h3 class="text-sm font-semibold text-textcolor">{language.pageFold.statsTitle}</h3>
        <p class="text-xs text-textcolor2">{language.pageFold.statsHelp}</p>
    </div>
    <ShButton size="sm" variant="outline" onclick={() => open = true}>{language.pageFold.openStats}</ShButton>
</div>
{#if open}<PageFoldStats bind:open />{/if}
