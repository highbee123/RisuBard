import isEqual from 'lodash/isEqual'

/** The UI database is a cache. Readiness and disk revisions never live in it. */
export type NativeKind = 'settings' | 'character' | 'chat' | 'module' | 'persona' | 'prompt' | 'lorebook'
export interface NativeTarget { kind: NativeKind; id: string; parentId?: string }
export interface NativeEnvelope { target: NativeTarget; value: any; revision: string; metadataOnly?: boolean; diskValue?: any }
export interface NativeWrite { target: NativeTarget; value: any; expectedRevision: string | null; metadataOnly?: boolean }
export type NativeRequest = (path: string, body?: unknown) => Promise<any>
export const nativeKey = (target: NativeTarget, metadataOnly = false) => JSON.stringify([target.kind, target.parentId ?? '', target.id, metadataOnly])
export const nativeClone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))
export const nativeEqual = (left: unknown, right: unknown) => {
    const a = JSON.stringify(left), b = JSON.stringify(right)
    return a === b || (a !== undefined && b !== undefined && isEqual(JSON.parse(a), JSON.parse(b)))
}

/** Apply server canonicalization only where the current value still equals what we sent. */
export function mergeAcknowledgedValue(current: any, sent: any, acknowledged: any): any {
    if (nativeEqual(current, sent)) return nativeClone(acknowledged)
    if (!current || !sent || !acknowledged || typeof current !== 'object' || Array.isArray(current)
        || Array.isArray(sent) || Array.isArray(acknowledged)) return current
    const merged = { ...current }
    for (const key of new Set([...Object.keys(sent), ...Object.keys(acknowledged)])) {
        const next = mergeAcknowledgedValue(current[key], sent[key], acknowledged[key])
        if (next === undefined) delete merged[key]
        else merged[key] = next
    }
    return merged
}

// Arrays (especially message histories) are indivisible. Never guess how to
// combine two edits to the same field, or a deletion with an external edit.
function mergeConflict(base: any, local: any, disk: any, conflict: unknown, diskBase: any): any {
    if (nativeEqual(local, base)) return nativeClone(disk)
    if (nativeEqual(disk, diskBase) || nativeEqual(local, disk)) return nativeClone(local)
    if (![base, local, disk].every(value => value && typeof value === 'object' && !Array.isArray(value))) throw conflict
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(disk)])]
        .map(key => [key, mergeConflict(base[key], local[key], disk[key], conflict, diskBase?.[key])])
        .filter(([, value]) => value !== undefined))
}

export class NativeDocuments {
    private conflicts = new Map<string, { write: NativeWrite; error: any }>()
    readonly entries = new Map<string, NativeEnvelope>()
    readonly summaries = new Map<string, any>()
    catalog: { value: any; revision: string }
    constructor(readonly request: NativeRequest) {}
    isReady(target: NativeTarget, metadataOnly = false) { return this.entries.has(nativeKey(target, metadataOnly)) }
    baseline(target: NativeTarget, metadataOnly = false) { return this.entries.get(nativeKey(target, metadataOnly))?.value }
    rememberSummary(target: NativeTarget, value: any) { this.summaries.set(nativeKey(target), nativeClone(value)) }
    accept(envelope: NativeEnvelope) { this.entries.set(nativeKey(envelope.target, !!envelope.metadataOnly), nativeClone(envelope)) }
    acceptCatalog(envelope: { value: any; revision: string }, complete = true) {
        if (complete || !this.catalog) { this.catalog = nativeClone(envelope); return }
        // Partial inspection results are never membership authority or a new CAS baseline.
        for (const entry of envelope.value.characters ?? []) {
            if (!this.catalog.value.characters.some((known: any) => known.id === entry.id)) this.catalog.value.characters.push(nativeClone(entry))
        }
        for (const [field, ids] of Object.entries(envelope.value.collections ?? {})) {
            this.catalog.value.collections[field] = [...new Set([...(this.catalog.value.collections[field] ?? []), ...(ids as string[])])]
        }
    }
    async read(target: NativeTarget, metadataOnly = false): Promise<NativeEnvelope> {
        const query = new URLSearchParams({ ...target, ...(metadataOnly ? { metadataOnly: '1' } : {}) })
        return this.request(`/api/native/document?${query}`)
    }
    write(target: NativeTarget, value: any, options: { create?: boolean; metadataOnly?: boolean } = {}): NativeWrite | null {
        const entry = this.entries.get(nativeKey(target, !!options.metadataOnly))
        if (!entry && !options.create) return null
        if (entry && nativeEqual(entry.value, value)) return null
        return { target, expectedRevision: entry?.revision ?? null, value: nativeClone(value), ...(options.metadataOnly ? { metadataOnly: true } : {}) }
    }
    blocked(write: NativeWrite) {
        const blocked = this.conflicts.get(nativeKey(write.target, !!write.metadataOnly))
        return !!blocked && blocked.write.expectedRevision === write.expectedRevision && nativeEqual(blocked.write.value, write.value)
    }
    acknowledge(write: NativeWrite, envelope: NativeEnvelope) {
        if (write.value === null) {
            this.entries.delete(nativeKey(write.target)); this.entries.delete(nativeKey(write.target, true)); return
        }
        this.accept({ ...envelope, metadataOnly: !!write.metadataOnly })
    }
    async commit(writes: NativeWrite[], catalog?: { expectedRevision: string; value: any }) {
        for (const write of writes) {
            const blocked = this.conflicts.get(nativeKey(write.target, !!write.metadataOnly))
            if (blocked && this.blocked(write)) throw blocked.error
        }
        let result
        try {
            result = await this.request('/api/native/commit', { writes, ...(catalog ? { catalog } : {}) })
        } catch (error) {
            if ((error as any)?.status !== 409) throw error
            try {
                const target = (error as any).details?.target as NativeTarget | undefined
                const write = target && writes.find(item => nativeKey(item.target) === nativeKey(target))
                // Membership changes and deletions require explicit resolution.
                if (!write || catalog || write.value === null || write.expectedRevision === null) throw error
                const baseline = this.entries.get(nativeKey(write.target, !!write.metadataOnly))
                if (!baseline || baseline.revision !== write.expectedRevision) throw error
                const latest = await this.read(write.target, !!write.metadataOnly)
                const value = mergeConflict(baseline.value, write.value, latest.value, error, baseline.diskValue ?? baseline.value)
                const retry = writes.map(item => item === write ? { ...item, value, expectedRevision: latest.revision } : item)
                result = await this.request('/api/native/commit', { writes: retry })
            } catch (retryError) {
                if ((retryError as any)?.status === 409) {
                    const target = (retryError as any).details?.target
                    for (const write of writes.filter(item => !target || nativeKey(item.target) === nativeKey(target))) {
                        this.conflicts.set(nativeKey(write.target, !!write.metadataOnly), { write: nativeClone(write), error: retryError })
                    }
                }
                throw retryError
            }
        }
        for (const write of writes) {
            const envelope = result.documents.find((doc: NativeEnvelope) => nativeKey(doc.target) === nativeKey(write.target))
            if (!envelope) throw new Error(`Native commit omitted ${nativeKey(write.target)}`)
            this.acknowledge(write, envelope)
            this.conflicts.delete(nativeKey(write.target, !!write.metadataOnly))
        }
        if (result.catalog) this.acceptCatalog(result.catalog)
        return result
    }
}
