import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Prompt V2 workspace contract', () => {
    test('is inserted immediately after the legacy Prompt tab without replacing it', () => {
        const settings = read('../PromptPresetSettings.svelte')

        expect(settings).toMatch(
            /\{ label: language\.prompt, value: 1 \},\s*\{ label: language\.promptV2\.tab, value: 2 \}/,
        )
        expect(settings).toContain('{ label: language.parameters, value: 3 }')
        expect(settings).toContain('{ label: language.advancedSettings, value: 4 }')
        expect(settings).toContain('<SettingRenderer items={promptPresetPromptItems} />')
        expect(settings).toContain('<PromptV2Workspace />')
        expect(settings).toContain('resizable={$PromptPresetSubmenuIndex === 2}')
        expect(settings).toContain('wide={$PromptPresetSubmenuIndex === 2}')
        expect(settings).toContain('unboundedHeight={$PromptPresetSubmenuIndex === 2}')
    })

    test('provides the three-pane desktop workbench and an isolated toggle preview', () => {
        const workspace = read('./PromptV2Workspace.svelte')
        const list = read('./PromptV2BlockList.svelte')
        const editor = read('./PromptV2BlockEditor.svelte')
        const toggleEditor = read('./PromptV2ToggleEditor.svelte')
        const preview = read('./PromptV2TogglePreview.svelte')

        expect(workspace).toContain('data-prompt-v2-workspace')
        expect(workspace).toContain('data-prompt-v2-block-list')
        expect(workspace).toContain('data-prompt-v2-editor')
        expect(workspace).toContain('data-prompt-v2-toggle-preview')
        expect(workspace).toContain('container: prompt-v2 / inline-size')
        expect(workspace).toContain('DBState.db.promptTemplate')
        expect(workspace).toContain('DBState.db.customPromptTemplateToggle')
        expect(workspace).toContain('savePromptV2PreviewState')
        expect(workspace).toContain('loadPromptV2PreviewState')
        expect(workspace).toContain('{previewValues}')
        expect(list).toContain('prompt-v2-pane-header')
        expect(editor).toContain('prompt-v2-pane-header')
        expect(editor).toContain('prompt-body-field--active')
        expect(editor).toContain('prompt-body-field--inactive')
        expect(editor).toContain('createPromptV2BodyPreviewSegments')
        expect(editor).toContain('prompt-body-preview-text--active')
        expect(editor).toContain('prompt-body-preview-text--inactive')
        expect(preview).toContain('prompt-v2-pane-header')
        expect(preview).toContain('<span>{language.promptV2.resetPreview}</span>')
        expect(preview).toContain('parsePromptV2ToggleTree')
        expect(preview).toContain('previewValues')
        expect(preview).not.toContain('bind:value={DBState.db.globalChatVariables')
        expect(editor).toContain('{#each visibleDefinitions as definition (definition)}')
        expect(toggleEditor).toContain('{#each visibleDefinitions as definition (definition)}')
        expect(editor).not.toContain('{#each visibleDefinitions as definition (definition.key)}')
        expect(toggleEditor).not.toContain('{#each visibleDefinitions as definition (definition.key)}')
    })
})
