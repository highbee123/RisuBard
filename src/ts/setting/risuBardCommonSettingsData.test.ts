import { describe, expect, it } from 'vitest'
import { risuBardCommonSettingsItems } from './risuBardCommonSettingsData'

describe('RisuBard common Arca settings', () => {
    it('exposes an independent Bard-chan model selector', () => {
        const item = risuBardCommonSettingsItems.find((candidate) =>
            candidate.id === 'risubard.chat.bardChanModel')

        expect(item).toMatchObject({
            type: 'select',
            bindKey: 'risuBardBardChanModelMode',
        })
        expect(item?.options?.selectOptions?.map((option) => option.value))
            .toEqual(['memory', 'model'])
    })

    it('lets number inputs keep intermediate draft values while typing', () => {
        const numericSettingIds = [
            'risubard.common.arcaChatImageWidth',
            'risubard.common.arcaChatFontSize',
            'risubard.common.arcaChatParagraphSpacing',
        ]

        for (const id of numericSettingIds) {
            const item = risuBardCommonSettingsItems.find((candidate) => candidate.id === id)
            expect(item?.type).toBe('number')
            expect(item?.setValue).toBeUndefined()
        }
    })

    it('protects built-in Archplotter presets while keeping user presets editable', () => {
        const checkpoint = risuBardCommonSettingsItems.find((candidate) =>
            candidate.id === 'risubard.arcPlotter.checkpointSize')
        const builtInContext = {
            db: { risuBardArcPlotterPresetId: 'novella' },
        } as any
        checkpoint?.onChange?.(4, builtInContext)
        expect(builtInContext.db.risuBardArcPlotterPresetId).toBe('custom')

        const userContext = {
            db: { risuBardArcPlotterPresetId: 'user:test' },
        } as any
        checkpoint?.onChange?.(5, userContext)
        expect(userContext.db.risuBardArcPlotterPresetId).toBe('user:test')
    })
})
