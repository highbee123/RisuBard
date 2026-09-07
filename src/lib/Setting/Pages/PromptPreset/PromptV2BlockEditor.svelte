<script lang="ts">
    import {
        AlertTriangleIcon,
        BracesIcon,
        CheckIcon,
        ClipboardIcon,
        PlusIcon,
        Settings2Icon,
        SlidersHorizontalIcon,
        Trash2Icon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { findTextareaMatch, revealTextareaMatch } from 'src/ts/gui/textareaSearch'
    import { persistElementHeight } from 'src/ts/gui/resizableSize'
    import type { PromptItem, PromptRole, PromptType } from 'src/ts/process/prompt'
    import {
        compilePromptV2Text,
        createPromptV2BodyPreviewSegments,
        evaluatePromptV2Activation,
        getPromptV2TextSource,
        parsePromptV2Text,
        setPromptV2TextSource,
        type PromptV2Activation,
        type PromptV2Condition,
        type PromptV2ToggleDefinition,
    } from 'src/ts/promptV2'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'

    let {
        item,
        definitions,
        previewValues,
        onReplace,
        onOpenToggleSetup,
    }: {
        item?: PromptItem
        definitions: PromptV2ToggleDefinition[]
        previewValues: Record<string, string>
        onReplace: (item: PromptItem) => void
        onOpenToggleSetup: () => void
    } = $props()

    let variableSearch = $state('')
    let copiedKey = $state('')
    let copyTimer: ReturnType<typeof setTimeout> | undefined
    let conditionError = $state('')
    let bodyPreviewElement: HTMLPreElement | undefined = $state()
    let bodyField: HTMLTextAreaElement | undefined = $state()
    let lastSearch: { item: PromptItem; query: string } | undefined

    export function findInBody(search: string) {
        if (!bodyField || !item) return
        const query = search.trim()
        const continuing = lastSearch?.item === item && lastSearch.query === query
        const match = findTextareaMatch(bodyField.value, query, continuing ? bodyField.selectionEnd : 0)
        if (!match) return
        revealTextareaMatch(bodyField, match)
        if (bodyPreviewElement) bodyPreviewElement.scrollTop = bodyField.scrollTop
        lastSearch = { item, query }
    }

    const textSource = $derived(item ? getPromptV2TextSource(item) : null)
    const parsedText = $derived(textSource ? parsePromptV2Text(textSource.source) : null)
    const previewState = $derived(
        parsedText?.activation
            ? evaluatePromptV2Activation(parsedText.activation, previewValues)
            : null,
    )
    const bodyPreviewSegments = $derived(
        parsedText
            ? createPromptV2BodyPreviewSegments(parsedText.body, previewValues, previewState)
            : [],
    )
    const hasBodyPreview = $derived(bodyPreviewSegments.some((segment) => segment.state !== 'neutral'))
    const visibleDefinitions = $derived.by(() => {
        const query = variableSearch.trim().toLocaleLowerCase()
        if (!query) return definitions
        return definitions.filter((definition) =>
            definition.label.toLocaleLowerCase().includes(query)
            || definition.key.toLocaleLowerCase().includes(query)
            || definition.group?.toLocaleLowerCase().includes(query),
        )
    })

    function patchItem(patch: Record<string, unknown>) {
        if (!item) return
        onReplace({ ...item, ...patch } as PromptItem)
    }

    function defaultValue(definition?: PromptV2ToggleDefinition): string {
        if (definition?.type === 'switch') return '1'
        return '0'
    }

    function applyText(body: string, activation: PromptV2Activation | null = parsedText?.activation ?? null) {
        if (!item || !textSource || !parsedText?.editable) return
        try {
            const next = { ...item } as PromptItem
            setPromptV2TextSource(next, compilePromptV2Text(body, activation))
            conditionError = ''
            onReplace(next)
        } catch (error) {
            conditionError = error instanceof Error ? error.message : String(error)
        }
    }

    function enableConditions() {
        if (!parsedText?.editable || parsedText.activation || definitions.length === 0) return
        const definition = definitions[0]
        applyText(parsedText.body, {
            join: 'and',
            conditions: [{ key: definition.key, operator: 'is', value: defaultValue(definition) }],
        })
    }

    function updateActivation(patch: Partial<PromptV2Activation>) {
        if (!parsedText?.activation) return
        applyText(parsedText.body, { ...parsedText.activation, ...patch })
    }

    function updateCondition(index: number, patch: Partial<PromptV2Condition>) {
        if (!parsedText?.activation) return
        const conditions = parsedText.activation.conditions.map((condition, conditionIndex) =>
            conditionIndex === index ? { ...condition, ...patch } : condition,
        )
        updateActivation({ conditions })
    }

    function selectConditionVariable(index: number, key: string) {
        const definition = definitions.find((entry) => entry.key === key)
        updateCondition(index, { key, value: defaultValue(definition) })
    }

    function addCondition(definition = definitions[0]) {
        if (!definition || !parsedText?.editable) return
        if (!parsedText.activation) {
            applyText(parsedText.body, {
                join: 'and',
                conditions: [{ key: definition.key, operator: 'is', value: defaultValue(definition) }],
            })
            return
        }
        updateActivation({
            conditions: [
                ...parsedText.activation.conditions,
                { key: definition.key, operator: 'is', value: defaultValue(definition) },
            ],
        })
    }

    function removeCondition(index: number) {
        if (!parsedText?.activation) return
        const conditions = parsedText.activation.conditions.filter((_, conditionIndex) => conditionIndex !== index)
        if (conditions.length === 0) {
            applyText(parsedText.body, null)
        } else {
            updateActivation({ conditions })
        }
    }

    function replaceType(type: PromptType) {
        if (!item || type === item.type) return
        const name = item.name
        let next: PromptItem
        if (type === 'plain' || type === 'jailbreak' || type === 'cot') {
            next = { type, type2: 'normal', text: '', role: 'system', name }
        } else if (type === 'chatML') {
            next = { type, text: '', name }
        } else if (type === 'chat') {
            next = { type, rangeStart: -1000, rangeEnd: 'end', name }
        } else if (type === 'cache') {
            next = { type, name: name ?? '', depth: 1, role: 'all' }
        } else if (type === 'authornote') {
            next = { type, name, defaultText: '', role2: 'system' }
        } else {
            next = { type, name, role2: type === 'lorebook' || type === 'postEverything' ? undefined : 'system' }
        }

        if (textSource && parsedText?.editable && getPromptV2TextSource(next)) {
            setPromptV2TextSource(next, compilePromptV2Text(parsedText.body, parsedText.activation))
        }
        onReplace(next)
    }

    function conditionDefinition(condition: PromptV2Condition): PromptV2ToggleDefinition | undefined {
        return definitions.find((definition) => definition.key === condition.key)
    }

    async function copyVariableKey(definition: PromptV2ToggleDefinition) {
        if (!navigator.clipboard?.writeText) return
        await navigator.clipboard.writeText(definition.key)
        copiedKey = definition.key
        if (copyTimer) clearTimeout(copyTimer)
        copyTimer = setTimeout(() => copiedKey = '', 1400)
    }

    function hasRole2(value: PromptItem): value is PromptItem & { role2?: PromptRole } {
        return value.type === 'persona' || value.type === 'description' || value.type === 'authornote' || value.type === 'memory'
    }

    function syncBodyPreviewScroll(event: Event) {
        if (!bodyPreviewElement) return
        const field = event.currentTarget as HTMLTextAreaElement
        bodyPreviewElement.scrollTop = field.scrollTop
        bodyPreviewElement.scrollLeft = field.scrollLeft
    }
</script>

{#if item}
    <section class="flex h-full min-h-0 flex-col" aria-label={language.promptV2.editor}>
        <header class="prompt-v2-pane-header flex items-center justify-between gap-3 border-b border-darkborderc px-4 py-3">
            <div class="min-w-0">
                <div class="flex items-center gap-2 font-medium">
                    <Settings2Icon size={16} class="text-borderc" />
                    <span>{item.name?.trim() || language.promptV2.editor}</span>
                </div>
                <p class="mt-1 text-xs text-textcolor2">{item.type}</p>
            </div>
            <span class="rounded-full border border-darkborderc bg-darkbutton px-2 py-1 text-[11px] text-textcolor2">
                {parsedText?.activation ? parsedText.activation.join.toUpperCase() : language.promptV2.always}
            </span>
        </header>

        <div class="min-h-0 grow overflow-y-auto p-4">
            {#if textSource && parsedText?.editable}
                <section class="editor-card">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 class="text-sm font-semibold">{language.promptV2.activation}</h3>
                            <p class="mt-1 text-xs text-textcolor2">
                                {parsedText.activation ? language.promptV2.activationConditional : language.promptV2.activationAlways}
                            </p>
                        </div>
                        <ShSwitch
                            checked={!!parsedText.activation}
                            disabled={!parsedText.activation && definitions.length === 0}
                            onCheckedChange={(checked) => checked ? enableConditions() : applyText(parsedText.body, null)}
                        />
                    </div>

                    {#if parsedText.activation}
                        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-darkborderc pt-4">
                            <span class="text-xs font-medium text-textcolor2">{language.promptV2.activation}</span>
                            <select
                                class="field-control h-9 min-w-48 text-sm"
                                value={parsedText.activation.join}
                                onchange={(event) => updateActivation({ join: event.currentTarget.value as 'and' | 'or' })}
                            >
                                <option value="and">{language.promptV2.matchAll}</option>
                                <option value="or">{language.promptV2.matchAny}</option>
                            </select>
                        </div>

                        <div class="mt-3 flex flex-col gap-2">
                            {#each parsedText.activation.conditions as condition, conditionIndex}
                                {@const definition = conditionDefinition(condition)}
                                <div class="condition-row">
                                    <span class="condition-index">{conditionIndex + 1}</span>
                                    <label class="sr-only" for="condition-key-{conditionIndex}">{language.promptV2.rawVariableKey}</label>
                                    <select
                                        id="condition-key-{conditionIndex}"
                                        class="field-control min-w-0 grow"
                                        value={condition.key}
                                        onchange={(event) => selectConditionVariable(conditionIndex, event.currentTarget.value)}
                                    >
                                        {#if !definition}<option value={condition.key}>{condition.key}</option>{/if}
                                        {#each definitions as entry}
                                            <option value={entry.key}>{entry.group ? `${entry.group} · ` : ''}{entry.label}</option>
                                        {/each}
                                    </select>
                                    <select
                                        class="field-control w-28 shrink-0"
                                        value={condition.operator}
                                        aria-label={language.promptV2.activation}
                                        onchange={(event) => updateCondition(conditionIndex, { operator: event.currentTarget.value as 'is' | 'isnot' })}
                                    >
                                        <option value="is">{language.promptV2.is}</option>
                                        <option value="isnot">{language.promptV2.isNot}</option>
                                    </select>

                                    {#if definition?.type === 'switch'}
                                        <select
                                            class="field-control w-24 shrink-0"
                                            value={condition.value}
                                            aria-label={language.promptV2.conditionValue}
                                            onchange={(event) => updateCondition(conditionIndex, { value: event.currentTarget.value })}
                                        >
                                            <option value="1">{language.promptV2.on}</option>
                                            <option value="0">{language.promptV2.off}</option>
                                        </select>
                                    {:else if definition?.type === 'select' && definition.options.length > 0}
                                        <select
                                            class="field-control w-36 shrink-0"
                                            value={condition.value}
                                            aria-label={language.promptV2.conditionValue}
                                            onchange={(event) => updateCondition(conditionIndex, { value: event.currentTarget.value })}
                                        >
                                            {#each definition.options as option, optionIndex}
                                                <option value={String(optionIndex)}>{option}</option>
                                            {/each}
                                        </select>
                                    {:else}
                                        <input
                                            class="field-control w-36 shrink-0"
                                            value={condition.value}
                                            aria-label={language.promptV2.conditionValue}
                                            oninput={(event) => updateCondition(conditionIndex, { value: event.currentTarget.value })}
                                        />
                                    {/if}

                                    <ShButton
                                        size="icon-sm"
                                        variant="ghost"
                                        onclick={() => removeCondition(conditionIndex)}
                                        title={language.remove}
                                        aria-label={language.remove}
                                    ><Trash2Icon size={15} /></ShButton>
                                </div>
                            {/each}
                        </div>

                        <div class="mt-3 flex justify-end">
                            <ShButton size="sm" variant="outline" onclick={() => addCondition()} disabled={definitions.length === 0}>
                                <PlusIcon size={14} />
                                {language.promptV2.addCondition}
                            </ShButton>
                        </div>
                    {:else if definitions.length === 0}
                        <div class="mt-4 rounded-lg border border-dashed border-darkborderc p-3 text-sm text-textcolor2">
                            <p>{language.promptV2.noToggleVariables}</p>
                            <ShButton size="sm" variant="outline" className="mt-3" onclick={onOpenToggleSetup}>
                                <SlidersHorizontalIcon size={14} />
                                {language.promptV2.togglesMode}
                            </ShButton>
                        </div>
                    {/if}

                    {#if conditionError}
                        <p class="mt-3 text-xs text-danger">{conditionError}</p>
                    {/if}
                </section>
            {:else if parsedText && !parsedText.editable}
                <ShAlert variant="warning" className="mb-4">
                    {#snippet icon()}<AlertTriangleIcon />{/snippet}
                    {#snippet title()}{language.promptV2.manualConditionTitle}{/snippet}
                    {language.promptV2.manualConditionDescription}
                </ShAlert>
            {:else}
                <ShAlert variant="info" className="mb-4">
                    {#snippet icon()}<BracesIcon />{/snippet}
                    {language.promptV2.unsupportedActivation}
                </ShAlert>
            {/if}

            {#if textSource && parsedText}
                <section class="editor-card mt-4">
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <h3 class="text-sm font-semibold">
                            {textSource.field === 'innerFormat' ? language.promptV2.innerFormat : language.promptV2.promptBody}
                        </h3>
                        <div class="flex items-center gap-2">
                            {#if previewState !== null}
                                <span
                                    class="preview-state-pill"
                                    class:preview-state-pill--active={previewState}
                                    class:preview-state-pill--inactive={!previewState}
                                >
                                    {previewState ? language.promptV2.active : language.promptV2.inactive}
                                </span>
                            {/if}
                            {#if parsedText.format === 'legacy'}
                                <span class="rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[11px] text-warning">Legacy</span>
                            {/if}
                        </div>
                    </div>
                    <div
                        class="prompt-body-editor"
                        class:prompt-body-editor--active={previewState === true}
                        class:prompt-body-editor--inactive={previewState === false}
                    >
                        {#if hasBodyPreview}
                            <pre class="prompt-body-preview" bind:this={bodyPreviewElement} aria-hidden="true">{#each bodyPreviewSegments as segment}<span
                                class:prompt-body-preview-text--active={segment.state === 'active'}
                                class:prompt-body-preview-text--inactive={segment.state === 'inactive'}
                            >{segment.text}</span>{/each}{'\n'}</pre>
                        {/if}
                        <textarea
                            class="prompt-body-field"
                            bind:this={bodyField}
                            use:persistElementHeight={'prompt-v2-body'}
                            class:prompt-body-field--preview={hasBodyPreview}
                            class:prompt-body-field--active={previewState === true}
                            class:prompt-body-field--inactive={previewState === false}
                            value={parsedText.body}
                            readonly={!parsedText.editable}
                            spellcheck="false"
                            onscroll={syncBodyPreviewScroll}
                            oninput={(event) => applyText(event.currentTarget.value)}
                        ></textarea>
                    </div>
                </section>
            {/if}

            <details class="editor-card mt-4" open={!textSource}>
                <summary class="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm font-semibold">
                    <Settings2Icon size={15} class="text-textcolor2" />
                    {language.promptV2.blockSettings}
                </summary>
                <div class="mt-4 grid gap-4 sm:grid-cols-2">
                    <label class="field-label sm:col-span-2">
                        <span>{language.name}</span>
                        <input class="field-control" value={item.name ?? ''} oninput={(event) => patchItem({ name: event.currentTarget.value })} />
                    </label>
                    <label class="field-label">
                        <span>{language.type}</span>
                        <select class="field-control" value={item.type} onchange={(event) => replaceType(event.currentTarget.value as PromptType)}>
                            <option value="plain">{language.formating.plain}</option>
                            <option value="jailbreak">{language.formating.jailbreak}</option>
                            <option value="chat">{language.Chat}</option>
                            <option value="persona">{language.formating.personaPrompt}</option>
                            <option value="description">{language.formating.description}</option>
                            <option value="authornote">{language.formating.authorNote}</option>
                            <option value="lorebook">{language.formating.lorebook}</option>
                            <option value="memory">{language.formating.memory}</option>
                            <option value="postEverything">{language.formating.postEverything}</option>
                            <option value="chatML">ChatML</option>
                            <option value="cache">{language.cachePoint}</option>
                            <option value="cot">{language.cot}</option>
                        </select>
                    </label>

                    {#if item.type === 'plain' || item.type === 'jailbreak' || item.type === 'cot'}
                        <label class="field-label">
                            <span>{language.specialType}</span>
                            <select class="field-control" value={item.type2} onchange={(event) => patchItem({ type2: event.currentTarget.value })}>
                                <option value="normal">{language.noSpecialType}</option>
                                <option value="main">{language.mainPrompt}</option>
                                <option value="globalNote">{language.globalNote}</option>
                            </select>
                        </label>
                        <label class="field-label">
                            <span>{language.role}</span>
                            <select class="field-control" value={item.role} onchange={(event) => patchItem({ role: event.currentTarget.value })}>
                                <option value="user">{language.user}</option>
                                <option value="bot">{language.character}</option>
                                <option value="system">{language.systemPrompt}</option>
                            </select>
                        </label>
                    {/if}

                    {#if hasRole2(item)}
                        <label class="field-label">
                            <span>{language.role}</span>
                            <select class="field-control" value={item.role2 ?? 'system'} onchange={(event) => patchItem({ role2: event.currentTarget.value })}>
                                <option value="user">{language.user}</option>
                                <option value="bot">{language.character}</option>
                                <option value="system">{language.systemPrompt}</option>
                            </select>
                        </label>
                    {/if}

                    {#if item.type === 'authornote'}
                        <label class="field-label sm:col-span-2">
                            <span>{language.defaultPrompt}</span>
                            <input class="field-control" value={item.defaultText ?? ''} oninput={(event) => patchItem({ defaultText: event.currentTarget.value })} />
                        </label>
                    {/if}

                    {#if item.type === 'cache'}
                        <label class="field-label">
                            <span>{language.depth}</span>
                            <input class="field-control" type="number" min="0" value={item.depth} oninput={(event) => patchItem({ depth: Number(event.currentTarget.value) })} />
                        </label>
                        <label class="field-label">
                            <span>{language.role}</span>
                            <select class="field-control" value={item.role} onchange={(event) => patchItem({ role: event.currentTarget.value })}>
                                <option value="all">{language.all}</option>
                                <option value="user">{language.user}</option>
                                <option value="assistant">{language.character}</option>
                                <option value="system">{language.systemPrompt}</option>
                            </select>
                        </label>
                    {/if}

                    {#if item.type === 'chat'}
                        <div class="flex items-center justify-between gap-3 sm:col-span-2">
                            <div>
                                <div class="text-sm">{language.advanced}</div>
                                <div class="mt-1 text-xs text-textcolor2">{language.untilChatEnd}</div>
                            </div>
                            <ShSwitch
                                checked={item.rangeStart !== -1000}
                                onCheckedChange={(checked) => patchItem({ rangeStart: checked ? 0 : -1000, rangeEnd: 'end' })}
                            />
                        </div>
                        {#if item.rangeStart !== -1000}
                            <label class="field-label">
                                <span>{language.rangeStart}</span>
                                <input class="field-control" type="number" value={item.rangeStart} oninput={(event) => patchItem({ rangeStart: Number(event.currentTarget.value) })} />
                            </label>
                            <label class="field-label">
                                <span>{language.rangeEnd}</span>
                                <input
                                    class="field-control"
                                    type="number"
                                    disabled={item.rangeEnd === 'end'}
                                    value={item.rangeEnd === 'end' ? 0 : item.rangeEnd}
                                    oninput={(event) => patchItem({ rangeEnd: Number(event.currentTarget.value) })}
                                />
                                <label class="mt-2 flex items-center gap-2 text-xs text-textcolor2">
                                    <input type="checkbox" checked={item.rangeEnd === 'end'} onchange={(event) => patchItem({ rangeEnd: event.currentTarget.checked ? 'end' : 0 })} />
                                    {language.untilChatEnd}
                                </label>
                            </label>
                        {/if}
                    {/if}
                </div>
            </details>

            {#if textSource && parsedText?.editable}
                <details class="editor-card mt-4">
                    <summary class="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
                        <span class="flex items-center gap-2"><BracesIcon size={15} class="text-textcolor2" />{language.promptV2.variableLibrary}</span>
                        <span class="text-xs font-normal text-textcolor2">{language.promptV2.toggleCount(definitions.length)}</span>
                    </summary>
                    <div class="relative mt-3">
                        <input class="field-control pl-3" bind:value={variableSearch} placeholder={language.promptV2.searchVariables} />
                    </div>
                    <div class="mt-2 grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
                        {#each visibleDefinitions as definition (definition)}
                            <div class="flex min-w-0 items-center gap-1 rounded-lg border border-darkborderc p-2">
                                <div class="min-w-0 grow">
                                    <div class="truncate text-xs font-medium">{definition.label}</div>
                                    <div class="mt-0.5 truncate font-mono text-[10px] text-textcolor2">{definition.key}</div>
                                </div>
                                <ShButton size="icon-xs" variant="ghost" onclick={() => copyVariableKey(definition)} title={language.promptV2.copyKey} aria-label={language.promptV2.copyKey}>
                                    {#if copiedKey === definition.key}<CheckIcon class="text-success" />{:else}<ClipboardIcon />{/if}
                                </ShButton>
                                <ShButton size="icon-xs" variant="ghost" onclick={() => addCondition(definition)} title={language.promptV2.insertCondition} aria-label={language.promptV2.insertCondition}>
                                    <PlusIcon />
                                </ShButton>
                            </div>
                        {/each}
                    </div>
                </details>
            {/if}
        </div>
    </section>
{:else}
    <div class="flex h-full min-h-80 flex-col items-center justify-center px-8 text-center">
        <BracesIcon size={28} class="mb-3 text-textcolor2" />
        <p class="text-sm font-medium">{language.promptV2.selectBlock}</p>
        <p class="mt-1 max-w-sm text-xs leading-relaxed text-textcolor2">{language.promptV2.workspaceHelp}</p>
    </div>
{/if}

<style>
    .editor-card {
        border: 1px solid var(--color-darkborderc);
        border-radius: .75rem;
        background: color-mix(in srgb, var(--color-darkbg) 78%, transparent);
        padding: 1rem;
    }

    .field-label {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: .4rem;
        color: var(--color-textcolor2);
        font-size: .75rem;
    }

    .field-control {
        width: 100%;
        min-height: 2.5rem;
        border: 1px solid var(--color-darkborderc);
        border-radius: .45rem;
        padding: .45rem .7rem;
        color: var(--color-textcolor);
        background: transparent;
        outline: none;
        transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
    }

    .preview-state-pill {
        border: 1px solid var(--color-darkborderc);
        border-radius: 999px;
        padding: .08rem .45rem;
        font-size: .68rem;
        font-weight: 650;
        line-height: 1.35;
    }

    .preview-state-pill--active {
        border-color: var(--color-info-border);
        color: var(--color-info);
        background: var(--color-info-bg);
    }

    .preview-state-pill--inactive {
        color: var(--color-textcolor2);
        background: var(--color-darkbutton);
        opacity: .72;
    }

    .field-control:focus {
        border-color: var(--color-borderc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-borderc) 45%, transparent);
    }

    .field-control:disabled { opacity: .55; }

    .condition-row {
        display: grid;
        grid-template-columns: 1.75rem minmax(9rem, 1fr) 7rem minmax(6rem, 9rem) 2rem;
        align-items: center;
        gap: .45rem;
        border: 1px solid var(--color-darkborderc);
        border-radius: .65rem;
        padding: .5rem;
        background: color-mix(in srgb, var(--color-darkbutton) 34%, transparent);
    }

    .condition-index {
        display: inline-flex;
        width: 1.55rem;
        height: 1.55rem;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        color: var(--color-binding-text);
        background: var(--color-binding);
        font-size: .7rem;
        font-weight: 700;
    }

    .prompt-body-field,
    .prompt-body-preview {
        scrollbar-gutter: stable;
    }

    .prompt-body-field {
        position: relative;
        z-index: 1;
        display: block;
        width: 100%;
        min-height: 16rem;
        resize: vertical;
        border: 1px solid var(--color-darkborderc);
        border-radius: .6rem;
        padding: .8rem;
        color: var(--color-textcolor);
        background: color-mix(in srgb, var(--color-bgcolor) 65%, transparent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: .8rem;
        line-height: 1.55;
        outline: none;
    }

    .prompt-body-editor { position: relative; border-radius: .6rem; }

    .prompt-body-preview {
        position: absolute;
        inset: 1px;
        z-index: 0;
        min-height: calc(100% - 2px);
        margin: 0;
        overflow: hidden;
        border-radius: .55rem;
        padding: .8rem;
        color: var(--color-textcolor);
        background: color-mix(in srgb, var(--color-bgcolor) 65%, transparent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: .8rem;
        line-height: 1.55;
        overflow-wrap: break-word;
        pointer-events: none;
        white-space: pre-wrap;
    }

    .prompt-body-preview span {
        font: inherit;
        transition: color 160ms ease, opacity 160ms ease;
    }
    .prompt-body-preview-text--active { color: var(--color-info); }
    .prompt-body-preview-text--inactive {
        color: color-mix(in srgb, var(--color-textcolor2) 42%, var(--color-bgcolor));
        opacity: .72;
    }

    .prompt-body-field--active {
        border-color: color-mix(in srgb, var(--color-info) 58%, var(--color-darkborderc));
        color: color-mix(in srgb, var(--color-info) 86%, var(--color-textcolor));
        background: color-mix(in srgb, var(--color-info-bg) 45%, var(--color-bgcolor));
    }

    .prompt-body-field--inactive:not(:focus) {
        color: color-mix(in srgb, var(--color-textcolor2) 42%, var(--color-bgcolor));
        background: color-mix(in srgb, var(--color-bgcolor) 82%, var(--color-darkbg));
    }

    .prompt-body-editor--active .prompt-body-preview {
        background: color-mix(in srgb, var(--color-info-bg) 45%, var(--color-bgcolor));
    }

    .prompt-body-editor--inactive .prompt-body-preview {
        background: color-mix(in srgb, var(--color-bgcolor) 82%, var(--color-darkbg));
    }

    .prompt-body-field--preview,
    .prompt-body-field--preview:focus {
        color: transparent;
        caret-color: var(--color-textcolor);
        background: transparent;
        -webkit-text-fill-color: transparent;
    }

    .prompt-body-field:focus {
        border-color: var(--color-borderc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-borderc) 45%, transparent);
    }

    .prompt-body-field:read-only { opacity: .72; }

    @media (max-width: 720px) {
        .condition-row { grid-template-columns: 1.75rem minmax(0, 1fr) 2rem; }
        .condition-row > :global(:nth-child(3)),
        .condition-row > :global(:nth-child(4)) { grid-column: 2 / 3; width: 100%; }
        .condition-row > :global(:last-child) { grid-column: 3; grid-row: 1; }
    }
</style>
