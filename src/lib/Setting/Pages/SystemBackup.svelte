<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { DownloadIcon, UploadIcon, SettingsIcon, FolderOpenIcon, LoaderCircleIcon } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { language } from 'src/lang'
    import { LoadLocalBackup, SaveLocalBackup, SaveSettingsOnlyBackup } from 'src/ts/drive/backuplocal'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { V2ImportItem, V2ImportPreview } from 'src/ts/storage/nodeStorage'

    let v2ImportSourcePath = $state('')
    let v2ImportPreview = $state<V2ImportPreview | null>(null)
    let v2ImportSelection = $state(new Set<string>())
    const v2ImportIncludeDependencies = true
    let v2ImportBusy = $state<'preview' | 'import' | null>(null)
    let v2ImportPercent = $state<number | null>(null)

    const selectedV2Items = $derived(v2ImportPreview?.items.filter((item) => v2ImportSelection.has(itemKey(item))) ?? [])
    const linkedV2Items = $derived.by(() => {
        const linked = new Set<string>()
        for (const item of selectedV2Items) for (const dependency of item.dependencies) {
            const identity = itemKey(dependency)
            if (!v2ImportSelection.has(identity)) linked.add(identity)
        }
        return linked
    })

    function itemKey(item: Pick<V2ImportItem, 'kind' | 'id'>) {
        return `${item.kind}\0${item.id}`
    }

    function toggleV2Item(item: V2ImportItem) {
        const next = new Set(v2ImportSelection)
        const identity = itemKey(item)
        if (next.has(identity)) next.delete(identity)
        else next.add(identity)
        v2ImportSelection = next
    }

    async function previewV2ItemImport() {
        if (!v2ImportSourcePath.trim() || v2ImportBusy) return
        v2ImportBusy = 'preview'
        v2ImportPreview = null
        v2ImportSelection = new Set()
        try {
            v2ImportPreview = await forageStorage.previewV2ItemImport(v2ImportSourcePath.trim())
        } catch (error) {
            notifyError(error instanceof Error ? error.message : String(error))
        } finally {
            v2ImportBusy = null
        }
    }

    async function executeV2ItemImport() {
        if (!v2ImportPreview || selectedV2Items.length === 0 || v2ImportBusy) return
        if (!(await alertConfirm(language.v2ImportConfirm(selectedV2Items.length + linkedV2Items.size)))) return
        v2ImportBusy = 'import'
        v2ImportPercent = 0
        try {
            const result = await forageStorage.executeV2ItemImport(
                v2ImportPreview.sourceRoot,
                v2ImportPreview.revision,
                selectedV2Items.map(({ kind, id }) => ({ kind, id })),
                (percent) => { v2ImportPercent = percent },
            )
            const count = Object.values(result.imported).reduce((sum, value) => sum + value, 0)
            v2ImportPercent = null
            notifySuccess(language.v2ImportSuccess(count))
            window.location.reload()
        } catch (error) {
            v2ImportPercent = null
            v2ImportBusy = null
            notifyError(error instanceof Error ? error.message : String(error))
        }
    }

    async function downloadLocal() {
        if (!(await alertConfirm(language.backupConfirm))) return
        SaveLocalBackup()
    }

    function downloadSettingsOnly() {
        SaveSettingsOnlyBackup()
    }

    async function restoreFromLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }
</script>

<p class="text-textcolor2 text-sm mb-4">{language.backupTabDesc}</p>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <DownloadIcon size={16} />
        <span class="font-medium">{language.backupLocal}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupLocalDesc}</p>

    <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupLocalDownload}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalDownloadDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadLocal}>
                <DownloadIcon size={14} />
                {language.backupLocalDownload}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupSettingsOnly}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupSettingsOnlyDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadSettingsOnly}>
                <SettingsIcon size={14} />
                {language.backupSettingsOnly}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.loadBackupLocal}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalRestoreDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={restoreFromLocalFile}>
                <UploadIcon size={14} />
                {language.loadBackupLocal}
            </ShButton>
        </div>
    </div>
</div>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4" data-v2-item-import>
    <div class="flex items-center gap-2 text-textcolor mb-2">
        <FolderOpenIcon size={16} />
        <span class="font-medium">{language.v2ImportTitle}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.v2ImportDesc}</p>

    <label class="block text-xs font-medium text-textcolor2 mb-1" for="v2-import-source">
        {language.v2ImportSourcePath}
    </label>
    <div class="flex flex-col sm:flex-row gap-2">
        <input
            id="v2-import-source"
            class="min-w-0 flex-1 h-9 rounded-md border border-darkborderc bg-bgcolor px-3 text-sm text-textcolor outline-none focus:border-borderc"
            placeholder={language.v2ImportSourcePlaceholder}
            bind:value={v2ImportSourcePath}
            disabled={v2ImportBusy !== null}
            oninput={() => { v2ImportPreview = null; v2ImportSelection = new Set() }}
        />
        <ShButton variant="outline" size="sm" onclick={previewV2ItemImport} disabled={!v2ImportSourcePath.trim() || v2ImportBusy !== null}>
            {#if v2ImportBusy === 'preview'}<LoaderCircleIcon size={14} class="animate-spin" />{/if}
            {v2ImportBusy === 'preview' ? language.v2ImportChecking : language.v2ImportPreview}
        </ShButton>
    </div>

    {#if v2ImportPreview}
        <div class="mt-4 overflow-hidden rounded-md border border-darkborderc/60 bg-bgcolor/45">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-darkborderc/60 px-3 py-2">
                <div class="flex gap-2">
                    <button class="text-xs text-borderc hover:underline" type="button" onclick={() => { v2ImportSelection = new Set(v2ImportPreview?.items.map(itemKey) ?? []) }}>
                        {language.v2ImportSelectAll}
                    </button>
                    <button class="text-xs text-textcolor2 hover:underline" type="button" onclick={() => { v2ImportSelection = new Set() }}>
                        {language.v2ImportClearSelection}
                    </button>
                </div>
                <span class="text-xs text-textcolor2">{selectedV2Items.length} / {v2ImportPreview.items.length}</span>
            </div>

            {#if v2ImportPreview.items.length === 0}
                <p class="px-3 py-4 text-sm text-textcolor2">{language.v2ImportEmpty}</p>
            {:else}
                <div class="max-h-64 overflow-y-auto divide-y divide-darkborderc/40">
                    {#each v2ImportPreview.items as item (itemKey(item))}
                        <label class="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-selected/25">
                            <input
                                type="checkbox"
                                class="mt-0.5 size-4 shrink-0 accent-primary"
                                checked={v2ImportSelection.has(itemKey(item))}
                                onchange={() => toggleV2Item(item)}
                                disabled={v2ImportBusy !== null}
                            />
                            <span class="min-w-0 flex-1">
                                <span class="flex flex-wrap items-center gap-2">
                                    <span class="truncate text-sm text-textcolor">{item.name}</span>
                                    <span class="rounded bg-darkbg px-1.5 py-0.5 text-[10px] text-textcolor2">{language.v2ImportKinds[item.kind]}</span>
                                </span>
                                {#if item.dependencies.length > 0}
                                    <span class="mt-0.5 block truncate text-xs text-textcolor2">
                                        → {item.dependencies.map((dependency) => `${language.v2ImportKinds[dependency.kind]}: ${dependency.name}`).join(', ')}
                                    </span>
                                {/if}
                            </span>
                        </label>
                    {/each}
                </div>
            {/if}
        </div>

        <div class="mt-3 flex items-start gap-2 text-sm text-textcolor">
            <input type="checkbox" class="mt-0.5 size-4 accent-primary" checked={v2ImportIncludeDependencies} disabled />
            <span>
                <span class="block">{language.v2ImportIncludeDependencies}</span>
                <span class="block text-xs leading-relaxed text-textcolor2">{language.v2ImportDependencyHint}</span>
            </span>
        </div>

        {#if v2ImportBusy === 'import' && v2ImportPercent !== null}
            <div class="mt-4" aria-live="polite">
                <div class="mb-1 flex justify-between text-xs text-textcolor2">
                    <span>{language.v2ImportProgress(v2ImportPercent)}</span>
                    <span>{v2ImportPercent}%</span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-darkborderc/50">
                    <div class="h-full bg-primary transition-[width] duration-150" style:width={`${v2ImportPercent}%`}></div>
                </div>
            </div>
        {/if}

        <div class="mt-4 flex justify-end">
            <ShButton variant="primary" size="sm" onclick={executeV2ItemImport} disabled={selectedV2Items.length === 0 || v2ImportBusy !== null}>
                {#if v2ImportBusy === 'import'}<LoaderCircleIcon size={14} class="animate-spin" />{/if}
                {language.v2ImportAction}
            </ShButton>
        </div>
    {/if}
</div>
