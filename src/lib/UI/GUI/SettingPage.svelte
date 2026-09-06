<script lang="ts">
    import type { Snippet } from "svelte";
    import ManagerResizeHandles from './ManagerResizeHandles.svelte';

    let {
        title,
        description,
        showTitle = true,
        resizable = false,
        wide = false,
        unboundedHeight = false,
        children,
    }: {
        title: string;
        description?: string;
        showTitle?: boolean;
        resizable?: boolean;
        wide?: boolean;
        unboundedHeight?: boolean;
        children?: Snippet;
    } = $props();
    let pageElement: HTMLElement | null = $state(null);
</script>

<section
    bind:this={pageElement}
    data-settings-page
    class="settings-standard-page"
    class:settings-standard-page--resizable={resizable}
    class:settings-standard-page--wide={wide}
    class:settings-standard-page--unbounded-height={unboundedHeight}
>
    {#if showTitle}
        <header data-settings-page-header class="settings-standard-page__header">
            <h1>{title}</h1>
            {#if description}
                <p>{description}</p>
            {/if}
        </header>
    {/if}
    <div data-settings-page-body class="settings-standard-page__body">
        {@render children?.()}
    </div>
    {#if resizable}<ManagerResizeHandles target={pageElement} centered {unboundedHeight} />{/if}
</section>

<style>
    .settings-standard-page--resizable {
        position: relative;
        left: 50%;
        display: flex;
        flex-direction: column;
        align-self: center;
        transform: translateX(-50%);
        width: var(--manager-width, 100%);
        max-width: calc(100vw - 1rem);
        min-width: 0;
        height: var(--manager-height, min(76dvh, 52rem));
        min-height: min(24rem, calc(100dvh - 1rem));
        max-height: calc(100dvh - 1rem);
        padding-bottom: .75rem;
    }
    .settings-standard-page--resizable.settings-standard-page--wide {
        --manager-width: min(calc(100vw - 20rem), 88rem);
    }
    .settings-standard-page--resizable.settings-standard-page--unbounded-height { max-height: none; }
    .settings-standard-page--resizable > .settings-standard-page__header { flex-shrink: 0; }
    .settings-standard-page--resizable > .settings-standard-page__body { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: auto; }
    .settings-standard-page--resizable > .settings-standard-page__body > :global([data-settings-preset-header]),
    .settings-standard-page--resizable > .settings-standard-page__body > :global([data-settings-section-tabs]) { flex-shrink: 0; }
    @media (max-width: 640px) {
        .settings-standard-page--resizable { left: auto; width: 100%; height: max(38rem, calc(100dvh - 8rem)); max-height: none; transform: none; padding-bottom: 0; }
    }
</style>
