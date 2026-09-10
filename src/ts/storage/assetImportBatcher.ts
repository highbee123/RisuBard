import { v4 } from 'uuid'
import { forageStorage, saveAsset } from '../globalApi.svelte'
import { hasher } from '../parser/parser.svelte'

const DEFAULT_MAX_ITEMS = 200
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_HIGH_WATER_BYTES = 64 * 1024 * 1024

export interface AssetImportEntry {
    id: string
    data: Uint8Array
}

interface AssetImportBatcherOptions {
    maxItems?: number
    maxBytes?: number
    highWaterBytes?: number
    onStored: (id: string, storageKey: string) => void
    onPrepared?: (completed: number, total: number) => void
    onProgress?: (completed: number, total: number) => void
    shouldPersist?: () => boolean
}

export class AssetImportBatcher {
    private readonly maxItems: number
    private readonly maxBytes: number
    private readonly highWaterBytes: number
    private readonly onStored: AssetImportBatcherOptions['onStored']
    private readonly onPrepared?: AssetImportBatcherOptions['onPrepared']
    private readonly onProgress?: AssetImportBatcherOptions['onProgress']
    private readonly shouldPersist: () => boolean
    private pending: AssetImportEntry[] = []
    private pendingBytes = 0
    private outstandingBytes = 0
    private total = 0
    private completed = 0
    private prepared = 0
    private writeChain: Promise<void> = Promise.resolve()
    private errors: Error[] = []
    private capacityWaiters: Array<() => void> = []

    constructor(options: AssetImportBatcherOptions) {
        this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
        this.highWaterBytes = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES
        this.onStored = options.onStored
        this.onPrepared = options.onPrepared
        this.onProgress = options.onProgress
        this.shouldPersist = options.shouldPersist ?? (() => true)
    }

    enqueue(entry: AssetImportEntry): void {
        if (this.pending.length > 0 && this.pendingBytes + entry.data.byteLength > this.maxBytes) {
            this.schedulePending()
        }
        this.pending.push(entry)
        this.pendingBytes += entry.data.byteLength
        this.outstandingBytes += entry.data.byteLength
        this.total += 1
        if (this.pending.length >= this.maxItems || this.pendingBytes >= this.maxBytes) {
            this.schedulePending()
        }
    }

    async waitForCapacity(): Promise<void> {
        if (this.outstandingBytes <= this.highWaterBytes) return
        await new Promise<void>(resolve => this.capacityWaiters.push(resolve))
    }

    async done(): Promise<void> {
        this.schedulePending()
        await this.writeChain
        if (this.errors.length === 1) throw this.errors[0]
        if (this.errors.length > 1) {
            throw new AggregateError(this.errors, `Failed to save ${this.errors.length} asset batches`)
        }
    }

    private schedulePending(): void {
        if (this.pending.length === 0) return
        const batch = this.pending
        const batchBytes = this.pendingBytes
        this.pending = []
        this.pendingBytes = 0
        this.writeChain = this.writeChain.then(async () => {
            try {
                await this.persistBatch(batch)
            } catch (error) {
                this.errors.push(error instanceof Error ? error : new Error(String(error)))
            } finally {
                this.completed += batch.length
                this.outstandingBytes -= batchBytes
                this.onProgress?.(this.completed, this.total)
                if (this.outstandingBytes <= this.highWaterBytes) {
                    for (const resolve of this.capacityWaiters.splice(0)) resolve()
                }
            }
        })
    }

    private async persistBatch(batch: AssetImportEntry[]): Promise<void> {
        if (this.shouldPersist() && batch.length === 1 && batch[0].data.byteLength > this.maxBytes) {
            const storageKey = await saveAsset(batch[0].data)
            this.onStored(batch[0].id, storageKey)
            return
        }
        const prepared = await Promise.all(batch.map(async entry => {
            let id: string
            try {
                id = await hasher(entry.data)
            } catch {
                id = v4()
            }
            this.prepared += 1
            this.onPrepared?.(this.prepared, this.total)
            return { id: entry.id, key: `assets/${id}.png`, value: entry.data }
        }))
        if (this.shouldPersist()) {
            await forageStorage.setItems(prepared.map(({ key, value }) => ({ key, value })))
        }
        for (const entry of prepared) this.onStored(entry.id, entry.key)
    }
}
