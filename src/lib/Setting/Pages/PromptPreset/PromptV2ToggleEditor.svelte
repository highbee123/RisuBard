<script lang="ts">
    import { CheckIcon, ClipboardIcon, ListFilterIcon, SlidersHorizontalIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { parsePromptV2ToggleTree, type PromptV2ToggleDefinition } from 'src/ts/promptV2'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'

    let {
        view,
        template = $bindable(),
    }: {
        view: 'library' | 'source'
        template: string
    } = $props()

    let search = $state('')
    let copiedKey = $state('')
    let copyTimer: ReturnType<typeof setTimeout> | undefined
    const tree = $derived(parsePromptV2ToggleTree(template))
    const visibleDefinitions = $derived.by(() => {
        const query = search.trim().toLocaleLowerCase()
        if (!query) return tree.definitions
        return tree.definitions.filter((definition) =>
            definition.label.toLocaleLowerCase().includes(query)
            || definition.key.toLocaleLowerCase().includes(query)
            || definition.group?.toLocaleLowerCase().includes(query),
        )
    })

    async function copyKey(definition: PromptV2ToggleDefinition) {
        if (!navigator.clipboard?.writeText) return
        await navigator.clipboard.writeText(definition.key)
        copiedKey = definition.key
        if (copyTimer) clearTimeout(copyTimer)
        copyTimer = setTimeout(() => copiedKey = '', 1400)
    }
</script>

{#if view === 'library'}
    <section class="flex h-full min-h-0 flex-col" aria-label={language.promptV2.variableLibrary}>
        <header class="prompt-v2-pane-header border-b border-darkborderc px-4 py-3">
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 font-medium">
                    <ListFilterIcon size={16} class="text-borderc" />
                    <span>{language.promptV2.variableLibrary}</span>
                </div>
                <span class="rounded-full bg-darkbutton px-2 py-0.5 text-[11px] text-textcolor2">
                    {language.promptV2.toggleCount(tree.definitions.length)}
                </span>
            </div>
            <div class="relative mt-3">
                <ListFilterIcon size={14} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2" />
                <input
                    class="h-10 w-full rounded-md border border-darkborderc bg-transparent pl-9 pr-3 text-sm outline-none placeholder:text-textcolor2 focus:border-borderc focus:ring-2 focus:ring-borderc/50"
                    bind:value={search}
                    placeholder={language.promptV2.searchVariables}
                />
            </div>
        </header>

        <div class="min-h-0 grow overflow-y-auto p-2">
            {#if visibleDefinitions.length > 0}
                <div class="flex flex-col gap-1">
                    {#each visibleDefinitions as definition (definition)}
                        <button
                            type="button"
                            class="group flex min-h-14 w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-darkborderc hover:bg-selected/25 focus-visible:border-borderc focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-borderc/50"
                            onclick={() => copyKey(definition)}
                            title={language.promptV2.copyKey}
                        >
                            <div class="min-w-0 grow">
                                <div class="truncate text-sm font-medium">{definition.label}</div>
                                <div class="mt-0.5 truncate font-mono text-[11px] text-textcolor2">{definition.key}</div>
                                {#if definition.group}<div class="mt-0.5 truncate text-[11px] text-textcolor2">{definition.group}</div>{/if}
                            </div>
                            {#if copiedKey === definition.key}
                                <CheckIcon size={15} class="shrink-0 text-success" />
                            {:else}
                                <ClipboardIcon size={15} class="shrink-0 text-textcolor2 opacity-50 group-hover:opacity-100" />
                            {/if}
                        </button>
                    {/each}
                </div>
            {:else}
                <div class="flex min-h-44 items-center justify-center px-5 text-center text-sm text-textcolor2">
                    {language.promptV2.noToggleVariables}
                </div>
            {/if}
        </div>
    </section>
{:else}
    <section class="flex h-full min-h-0 flex-col" aria-label={language.promptV2.toggleSource}>
        <header class="prompt-v2-pane-header border-b border-darkborderc px-4 py-3">
            <div class="flex items-center gap-2 font-medium">
                <SlidersHorizontalIcon size={16} class="text-borderc" />
                <span>{language.promptV2.toggleSource}</span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-textcolor2">{language.promptV2.toggleSourceHint}</p>
        </header>
        <div class="min-h-0 grow p-3">
            <TextAreaInput
                bind:value={template}
                fullwidth
                height="full"
                resizable
                highlight
                optimaizedInput={false}
                placeholder={language.promptV2.toggleSourcePlaceholder}
                popupLanguage="plaintext"
            />
        </div>
    </section>
{/if}
