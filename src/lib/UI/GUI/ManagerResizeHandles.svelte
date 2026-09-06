<script lang="ts">
    import { language } from 'src/lang'
    import { resizeHandle } from 'src/ts/gui/resizeHandle'

    let { target, centered = false, unboundedHeight = false, onResizeEnd }: {
        target: HTMLElement | null
        centered?: boolean
        unboundedHeight?: boolean
        onResizeEnd?: (target: HTMLElement) => void
    } = $props()
    const edges = $derived(centered ? ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] : ['e', 's', 'se'])

    function startResize(edge: string) {
        const element = target
        if (!element) return
        const host = element.ownerDocument.defaultView!
        const { width, height } = element.getBoundingClientRect()
        const parent = element.parentElement
        const parentStyle = parent && host.getComputedStyle(parent)
        const parentWidth = parent ? parent.clientWidth - (parseFloat(parentStyle!.paddingLeft) || 0) - (parseFloat(parentStyle!.paddingRight) || 0) : host.innerWidth
        const settingsViewport = element.closest<HTMLElement>('.settings-content')
        const viewportWidth = settingsViewport?.clientWidth ?? host.innerWidth
        const maxWidth = Math.max(0, centered ? viewportWidth - 16 : Math.min(parentWidth, viewportWidth - 16))
        const maxHeight = Math.max(0, host.innerHeight - 16)
        const x = edge.includes('e') ? 1 : edge.includes('w') ? -1 : 0
        const y = edge.includes('s') ? 1 : edge.includes('n') ? -1 : 0
        const scale = centered ? 2 : 1
        return (dx: number, dy: number) => {
            if (x && dx) element.style.setProperty('--manager-width', `${Math.min(maxWidth, Math.max(Math.min(480, maxWidth), width + dx * x * scale))}px`)
            if (y && dy) {
                const nextHeight = Math.max(Math.min(320, maxHeight), height + dy * y * scale)
                element.style.setProperty('--manager-height', `${unboundedHeight ? nextHeight : Math.min(maxHeight, nextHeight)}px`)
            }
        }
    }

    function resetSize() {
        target?.style.removeProperty('--manager-width')
        target?.style.removeProperty('--manager-height')
    }

    function finishResize() {
        if (target) onResizeEnd?.(target)
    }
</script>

{#each edges as edge}
    <button type="button" class="manager-window-resize" data-manager-window-resize={edge}
        aria-label={`${language.collectionOrganizer.resizeWindow} · ${edge.toUpperCase()}`}
        title={language.collectionOrganizer.resizeHint}
        use:resizeHandle={{ start: () => startResize(edge), reset: resetSize, end: finishResize }}></button>
{/each}

<style>
    .manager-window-resize { position: absolute; z-index: 10; border: 0; padding: 0; background: transparent; touch-action: none; }
    .manager-window-resize:hover, .manager-window-resize:focus-visible, .manager-window-resize:global([data-resizing]) { background: color-mix(in srgb, var(--color-borderc) 45%, transparent); outline: none; }
    [data-manager-window-resize='n'], [data-manager-window-resize='s'] { left: 1rem; right: 1rem; height: .5rem; cursor: ns-resize; }
    [data-manager-window-resize='e'], [data-manager-window-resize='w'] { top: 1rem; bottom: 1rem; width: .5rem; cursor: ew-resize; }
    [data-manager-window-resize='n'] { top: 0; }
    [data-manager-window-resize='s'] { bottom: 0; }
    [data-manager-window-resize='e'] { right: 0; }
    [data-manager-window-resize='w'] { left: 0; }
    [data-manager-window-resize='ne'], [data-manager-window-resize='se'], [data-manager-window-resize='sw'], [data-manager-window-resize='nw'] { width: 1.1rem; height: 1.1rem; }
    [data-manager-window-resize='ne'] { top: 0; right: 0; cursor: nesw-resize; }
    [data-manager-window-resize='se'] { bottom: 0; right: 0; cursor: nwse-resize; border-right: 2px solid var(--color-borderc); border-bottom: 2px solid var(--color-borderc); border-bottom-right-radius: .3rem; }
    [data-manager-window-resize='sw'] { bottom: 0; left: 0; cursor: nesw-resize; }
    [data-manager-window-resize='nw'] { top: 0; left: 0; cursor: nwse-resize; }
    @media (max-width: 640px) { .manager-window-resize { display: none; } }
</style>
