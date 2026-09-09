import type { ModelPreset, ModelPresetPdfConfig } from '../types'
import type { Database } from '../../storage/database.svelte'
import type { RequestLogEntry, RequestLogUsage } from '../../requestLog'

// Shared by request preparation, live logs, persisted jobs and statistics.
// Later-stage fields are optional because metadata is enriched after the response.
export interface PageFoldMetadata {
    version: 1
    generationId?: string
    requestId?: string
    presetId?: string
    presetName?: string
    modelId?: string
    packagingMode?: ModelPresetPdfConfig['packagingMode']
    fontSize?: number
    pages?: number
    bytes?: number
    sourceCharacters?: number
    baselineTokens?: number | null
    baselineSource?: string
    comparable?: boolean
    inputPrice?: number | null
    priceSource?: string | null
    priceTimestamp?: number | null
    currency?: string
    requestedServiceTier?: string | null
    servedServiceTier?: string
    reasoningEffort?: string | null
    thinkingBudget?: number | null
    pdfContent?: string
    structuredOutput?: boolean
    kind?: 'google' | 'openai'
    cacheHit?: boolean
    responseTokens?: number | null
    inputSource?: string
    savedTokens?: number | null
    savedUsd?: number | null
    actualCost?: number | null
}

export interface PageFoldRequestInit extends RequestInit {
    __pageFold?: PageFoldMetadata
}

export interface PageFoldStatus {
    presetId?: string
    generationId?: string
    phase: string
    pages?: number
    bytes?: number
    baselineTokens?: number | null
    savedTokens?: number | null
    inputTokens?: number | null
}

export interface PageFoldHost {
    resolveModel?: (preset: ModelPreset) => string
    authHeaders?: () => Promise<Record<string, string>>
    db?: () => Pick<Database, 'requestLogStreamUsage'>
    priceFetch?: typeof fetch
    status?: (detail: PageFoldStatus) => void
}

export interface PageFoldLogEntry extends RequestLogUsage,
    Partial<Pick<RequestLogEntry, 'success' | 'aborted' | 'errorMessage' | 'requestBody' | 'responseBody' | 'requestHeaders'>> {
    pageFold?: PageFoldMetadata
}
