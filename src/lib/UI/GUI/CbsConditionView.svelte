<script lang="ts">
    import { language } from 'src/lang'
    import { parseCbsConditionView, summarizeCbsCondition, type CbsConditionExpression } from 'src/ts/gui/cbsConditionView'
    import type { CbsVariableContext } from 'src/ts/gui/cbsVariableEditor'
    import { tooltip } from 'src/ts/gui/tooltip'
    import { resizeHandle } from 'src/ts/gui/resizeHandle'
    import CbsVariableList from './CbsVariableList.svelte'

    let { value, onInput, onblur, onkeydown, variableContext, variableLabels, showVariableSidebar = true, onSelectionChange }: {
        value: string
        onInput: (value: string) => void
        onblur?: () => void
        onkeydown?: (event: KeyboardEvent) => void
        variableContext?: CbsVariableContext
        variableLabels?: Record<string, string>
        showVariableSidebar?: boolean
        onSelectionChange?: (selection: { start: number; end: number }) => void
    } = $props()

    let documentValue = $state('')
    let view = $state(parseCbsConditionView(''))
    const id = $props.id()
    let containerWidth = $state(0)
    let variablesPreference = $state<boolean | undefined>(undefined)
    const variablesOpen = $derived(showVariableSidebar && (variablesPreference ?? containerWidth >= 360))
    let layoutElement: HTMLElement | undefined = $state()
    let rootElement: HTMLElement | undefined = $state()
    const labels = $derived(language.cbsEditor)

    $effect.pre(() => {
        if (value !== documentValue) {
            documentValue = value
            view = parseCbsConditionView(value)
        }
    })

    function edit(index: number, replacement: string) {
        const part = view.parts[index]
        const delta = replacement.length - (part.to - part.from)
        documentValue = documentValue.slice(0, part.from) + replacement + documentValue.slice(part.to)
        // Keep the active textarea (and its IME/undo state) while a macro is incomplete.
        view.parts = view.parts.map((item, i) => i < index ? item : {
            ...item, from: item.from + (i > index ? delta : 0), to: item.to + delta,
        })
        onInput(documentValue)
    }

    function finishEdit() {
        view = parseCbsConditionView(documentValue)
        onblur?.()
    }

    function reportSelection(index: number, event: Event) {
        const part = view.parts[index]
        const field = event.currentTarget as HTMLTextAreaElement
        onSelectionChange?.({ start: part.from + field.selectionStart, end: part.from + field.selectionEnd })
    }

    export function focusSelection(start: number, end: number) {
        const fields = rootElement?.querySelectorAll<HTMLTextAreaElement>('[data-cbs-body-index]')
        if (!fields) return
        for (const field of fields) {
            const part = view.parts[Number(field.dataset.cbsBodyIndex)]
            if (!part || part.kind !== 'text' || start < part.from || end > part.to) continue
            field.focus()
            field.setSelectionRange(start - part.from, end - part.from)
            return
        }
    }

    function expressionHasRaw(node: CbsConditionExpression): boolean {
        if (node.kind === 'raw') return true
        if (node.kind === 'logical') return node.children.some(expressionHasRaw)
        if (node.kind === 'comparison') return expressionHasRaw(node.left) || expressionHasRaw(node.right)
        return false
    }

    function startVariableResize() {
        const layout = layoutElement
        const sidebar = layout?.querySelector<HTMLElement>('[data-cbs-variable-sidebar]')
        if (!layout || !sidebar) return
        const width = layout.getBoundingClientRect().width
        const start = sidebar.getBoundingClientRect().width
        return (dx: number) => layout.style.setProperty('--cbs-variable-width', `${Math.max(112, Math.min(width - 128, start - dx))}px`)
    }
</script>

{#snippet renderExpression(node: CbsConditionExpression, nested = false)}
    {#if node.kind === 'logical'}
        <span class="logical-group" class:nested data-cbs-logic={node.operator}>
            {#each node.children as child, index}
                {#if index > 0 || node.operator === 'NOT'}
                    {' '}<span class="logical-operator" data-cbs-operator={node.operator}>{node.operator}</span>{' '}
                {/if}
                {@render renderExpression(child, true)}
            {/each}
        </span>
    {:else if node.kind === 'comparison'}
        <span class="condition-clause" data-cbs-clause>
            {@render renderExpression(node.left, true)}{' '}<span class="comparison-operator">{node.operator}</span>{' '}{@render renderExpression(node.right, true)}
        </span>
    {:else if node.kind === 'variable'}
        <span class="expression-leaf variable-leaf" data-cbs-token={node.kind} title={node.name}>[{node.text}]</span>
    {:else}
        <span class="expression-leaf" data-cbs-token={node.kind}>{node.text}</span>
    {/if}
{/snippet}

<div class="cbs-condition-view" data-cbs-condition-view bind:this={rootElement} bind:clientWidth={containerWidth}>
    <div class="view-tools">
        {#if !view.valid}<button type="button" class="tip-icon" aria-label={labels.fallback} use:tooltip={labels.fallback}>!</button>{/if}
        <button type="button" class="tip-icon" aria-label={labels.description} use:tooltip={labels.description}>?</button>
        {#if showVariableSidebar}<button type="button" class="variable-toggle" data-cbs-variable-toggle
            aria-controls={`${id}-variables`} aria-expanded={variablesOpen}
            aria-label={variablesOpen ? labels.hideVariables : labels.showVariables}
            use:tooltip={variablesOpen ? labels.hideVariables : labels.showVariables}
            onclick={() => { variablesPreference = !variablesOpen }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
                <path d="M10 2v12" />
            </svg>
            {labels.variables}
        </button>{/if}
    </div>
    <div class="view-layout" class:variables-open={variablesOpen} bind:this={layoutElement}>
    <div class="cbs-document" data-cbs-document>
    {#each view.parts as part, index}
        {@const source = documentValue.slice(part.from, part.to)}
        <div class="part" style:--depth={Math.min(part.depth, 6)}>
            {#if part.kind === 'text'}
                {#if source.trim() || part.depth > 0 || part.from === part.to}
                    <textarea
                        data-cbs-body
                        aria-label={`${labels.body} ${index + 1}`}
                        value={source}
                        rows={Math.max(1, Math.min(24, source.split('\n').length))}
                        spellcheck="false"
                        oninput={(event) => edit(index, event.currentTarget.value)}
                        onselect={(event) => reportSelection(index, event)}
                        onfocus={(event) => reportSelection(index, event)}
                        onblur={finishEdit}
                        {onkeydown}
                        data-cbs-body-index={index}
                    ></textarea>
                {:else}
                    <div class="text-gap" aria-hidden="true"></div>
                {/if}
            {:else if part.kind === 'condition'}
                {@const summary = summarizeCbsCondition(source, { variableLabels })}
                {@const warnings = [
                    ...summary.warnings.map(warning => labels.extraArguments.replace('{name}', warning.name).replace('{actual}', String(warning.actual)).replace('{expected}', String(warning.expected))),
                    ...(expressionHasRaw(summary.expression) ? [labels.unsupportedExpression] : []),
                ].join('\n')}
                <div class="condition-row">
                <details class="condition">
                    <summary aria-label={`${labels.condition} ${summary.text}`} use:tooltip={labels.showSource + '\n' + labels.editSource}>
                        <span class="condition-label">{labels.condition}</span>
                        <code class="condition-expression" data-cbs-summary>{@render renderExpression(summary.expression)}</code>
                    </summary>
                    <pre class="condition-source">{source}</pre>
                </details>
                {#if warnings}<button type="button" class="tip-icon" data-cbs-warning aria-label={warnings} use:tooltip={warnings}>!</button>{/if}
                </div>
            {:else if part.kind === 'otherwise'}
                <div class="branch-label">{labels.otherwise}</div>
            {:else}
                <div class="condition-end" role="separator" aria-label={labels.end}></div>
            {/if}
        </div>
    {/each}
    </div>
    {#if showVariableSidebar}<button type="button" class="variable-splitter" data-cbs-variable-splitter hidden={!variablesOpen}
        aria-label={labels.resizeVariables} use:tooltip={language.lorebookWorkspace.resizeHint}
        use:resizeHandle={{ start: startVariableResize, reset: () => layoutElement?.style.removeProperty('--cbs-variable-width') }}></button>
    <aside class="variable-sidebar" data-cbs-variable-sidebar id={`${id}-variables`}
        aria-label={labels.variables} hidden={!variablesOpen}>
        <CbsVariableList source={documentValue} context={variableContext} />
    </aside>{/if}
    </div>
</div>

<style>
    .cbs-condition-view { display: flex; flex-direction: column; container: cbs-editor / inline-size; height: 100%; min-height: 0; min-width: 0; overflow: hidden; color: var(--color-textcolor); background: var(--color-darkbg); font-size: .86rem; font-weight: 400; letter-spacing: normal; }
    .view-tools { display: flex; flex-shrink: 0; align-items: center; justify-content: flex-end; gap: .4rem; padding: .25rem .5rem; border-bottom: 1px solid var(--color-darkborderc); }
    .variable-toggle { display: flex; align-items: center; gap: .3rem; padding: .15rem .4rem; border: 1px solid var(--color-darkborderc); border-radius: .2rem; color: var(--color-textcolor2); background: transparent; font: inherit; font-size: .73rem; cursor: pointer; }
    .variable-toggle[aria-expanded='true'] { color: var(--color-textcolor); background: var(--color-selected); }
    .view-layout { --cbs-effective-variable-width: clamp(7rem, var(--cbs-variable-width, 17rem), calc(100% - 8rem)); position: relative; display: flex; flex: 1; min-height: 0; }
    .cbs-document { flex: 1; min-width: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem .6rem; }
    .variable-sidebar { flex: 0 0 var(--cbs-effective-variable-width); min-width: 0; overflow: hidden; border-left: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); container: cbs-variables / inline-size; }
    .variable-splitter { position: absolute; top: 0; bottom: 0; right: calc(var(--cbs-effective-variable-width) - .25rem); z-index: 2; width: .5rem; padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; }
    .variable-splitter::after { position: absolute; top: calc(50% - 1rem); height: 2rem; left: 3px; border-left: 2px solid var(--color-borderc); content: ''; }
    .variable-splitter:hover, .variable-splitter:focus-visible, .variable-splitter:global([data-resizing]) { background: color-mix(in srgb, var(--color-borderc) 45%, transparent); outline: none; }
    .part { min-width: 0; margin-left: calc(var(--depth) * .6rem); }
    .condition-row { display: flex; align-items: flex-start; gap: .25rem; margin-top: .2rem; }
    .condition { min-width: 0; flex: 1; border-left: 2px solid var(--color-borderc); background: color-mix(in srgb, var(--color-selected) 22%, var(--color-darkbg)); }
    summary { display: flex; align-items: flex-start; gap: .35rem; padding: .25rem .4rem; cursor: pointer; overflow-wrap: anywhere; line-height: 1.5; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▸'; flex-shrink: 0; padding-top: .15rem; color: var(--color-textcolor2); }
    .condition[open] > summary::before { content: '▾'; }
    summary:focus-visible { outline: 2px solid var(--color-borderc); outline-offset: 2px; }
    .condition-label { flex-shrink: 0; padding-top: .25rem; color: var(--color-textcolor2); font-size: .65rem; font-weight: 600; }
    code, .condition-source { font-family: ui-monospace, monospace; font-size: .75rem; }
    .condition-expression { display: flex; flex: 1; min-width: 0; align-items: center; }
    .logical-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .3rem; min-width: 0; max-width: 100%; }
    .logical-group.nested { padding: .2rem .3rem; border: 1px solid color-mix(in srgb, var(--color-borderc) 65%, var(--color-darkborderc)); border-radius: .4rem; background: color-mix(in srgb, var(--color-selected) 18%, var(--color-darkbg)); }
    .condition-clause, .expression-leaf { min-width: 0; max-width: 100%; padding: .15rem .4rem; border: 1px solid color-mix(in srgb, var(--color-primary) 30%, var(--color-darkborderc)); border-radius: .3rem; background: color-mix(in srgb, var(--color-primary) 10%, var(--color-darkbg)); overflow-wrap: anywhere; }
    .condition-clause { display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: .3rem; }
    .condition-clause > .expression-leaf { padding: 0; border: 0; border-radius: 0; background: transparent; }
    [data-cbs-token='variable'] { color: var(--color-textcolor); font-weight: 600; }
    .variable-leaf { border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-darkborderc)); background: color-mix(in srgb, var(--color-primary) 16%, var(--color-darkbg)); }
    [data-cbs-token='literal'] { color: color-mix(in srgb, var(--color-textcolor) 85%, var(--color-primary)); }
    [data-cbs-token='raw'], .comparison-operator { color: var(--color-textcolor2); }
    .logical-operator { flex-shrink: 0; padding: .1rem .35rem; border: 1px solid color-mix(in srgb, var(--color-primary) 40%, var(--color-darkborderc)); border-radius: .25rem; background: color-mix(in srgb, var(--color-primary) 18%, var(--color-darkbg)); color: color-mix(in srgb, var(--color-primary) 45%, var(--color-textcolor)); font-family: inherit; font-size: .65rem; font-weight: 750; letter-spacing: .035em; }
    .condition-source { margin: 0; padding: .4rem .5rem; border-top: 1px solid var(--color-darkborderc); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    textarea { display: block; width: 100%; min-height: 1.75rem; field-sizing: content; padding: .2rem .5rem; border: 1px solid transparent; border-left-color: var(--color-darkborderc); border-radius: .15rem; background: transparent; color: var(--color-textcolor); font-family: inherit; font-size: .87rem; font-weight: 400; line-height: 1.65; resize: none; }
    textarea:hover { border-color: var(--color-darkborderc); }
    textarea:focus { border-color: var(--color-borderc); outline: 1px solid var(--color-borderc); background: var(--color-bgcolor); }
    .text-gap { height: .12rem; }
    .branch-label { padding: .2rem .5rem; border-left: 2px solid var(--color-borderc); color: var(--color-textcolor2); font-size: .7rem; }
    .condition-end { margin: .1rem 0 .25rem; border-top: 1px solid var(--color-darkborderc); }
    .tip-icon { display: grid; width: 1.35rem; height: 1.35rem; flex-shrink: 0; place-content: center; padding: 0; border: 1px solid var(--color-darkborderc); border-radius: 50%; background: transparent; color: var(--color-textcolor2); font-size: .7rem; cursor: help; }
    .tip-icon:focus-visible, .variable-toggle:focus-visible { outline: 1px solid var(--color-borderc); outline-offset: 1px; }
    @container cbs-editor (max-width: 359px) {
        .variables-open .cbs-document { display: none; }
        .variable-sidebar { flex: 1; border-left: 0; }
        .variable-splitter { display: none; }
    }
</style>
