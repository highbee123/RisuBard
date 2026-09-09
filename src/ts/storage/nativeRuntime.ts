import { NativeDocuments, mergeAcknowledgedValue, nativeClone, nativeEqual, nativeKey, type NativeEnvelope, type NativeKind, type NativeRequest, type NativeTarget, type NativeWrite } from './nativeDocuments'
import { v4 as uuidv4 } from 'uuid'

const collections = { modules: 'module', personas: 'persona', botPresets: 'prompt', loreBook: 'lorebook' } as const
const settingsTarget: NativeTarget = { kind: 'settings', id: 'global' }
const chatMetadataFields = ['id', 'name', 'lastDate', 'folderId', 'modules']
const strip = (value: any, fields: string[]) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !fields.includes(key)))
const characterValue = (value: any) => strip(value, ['chats'])
const chatValue = (value: any) => strip(value, ['_placeholder', '_stub'])
const metadata = (value: any) => Object.fromEntries(chatMetadataFields.filter(key => key in value).map(key => [key, value[key]]))
const settingsValue = (db: any) => strip(db, ['characters', ...Object.keys(collections)])
const placeholder = (value: any) => ({ message: [], note: '', localLore: [], fmIndex: -1, ...value, _placeholder: true })

// Publish already-merged values without detaching editors of the same object.
// Array membership follows the merged result; only stable IDs retain identity.
function reconcileSavedValue(current: any, next: any): any {
    if (nativeEqual(current, next)) return current
    if (Array.isArray(current) && Array.isArray(next)) {
        const hasUniqueIds = (items: any[]) => items.every(item => typeof item?.id === 'string' && item.id.length > 0)
            && new Set(items.map(item => item.id)).size === items.length
        if (hasUniqueIds(current) && hasUniqueIds(next)) {
            const byId = new Map(current.map(item => [item.id, item]))
            const values = next.map(item => reconcileSavedValue(byId.get(item.id), item))
            for (let index = 0; index < values.length; index++) current[index] = values[index]
            current.length = values.length
            return current
        }
    } else if (current && next && typeof current === 'object' && typeof next === 'object'
        && !Array.isArray(current) && !Array.isArray(next)) {
        for (const key of Object.keys(current)) if (!(key in next)) delete current[key]
        for (const [key, value] of Object.entries(next)) current[key] = reconcileSavedValue(current[key], value)
        return current
    }
    return nativeClone(next)
}

export interface NativeSaveScope { root?: boolean; plugins?: boolean; pluginCustomStorage?: boolean; modules?: boolean; botPreset?: boolean; character?: string[]; chat?: [string, string][] }

export class NativeRuntime {
    readonly cache: NativeDocuments
    private pending = new Map<string, Promise<any>>()
    private saving: Promise<boolean> | null = null
    private view: any
    private knownTargets = new Set<string>()
    constructor(request: NativeRequest, readonly database: () => any, readonly normalizeChat: (value: any) => any = value => value,
        readonly savingChanged: (state: boolean) => void = () => {}) {
        this.cache = new NativeDocuments(request)
    }
    private async batches(targets: NativeTarget[], summaries = false) {
        const values: any[] = []
        for (let offset = 0; offset < targets.length; offset += 100) {
            const result = await this.cache.request(`/api/native/${summaries ? 'summaries' : 'documents'}`, { targets: targets.slice(offset, offset + 100) })
            values.push(...result[summaries ? 'summaries' : 'documents'])
        }
        return values
    }
    private characterStub(entry: any) {
        return { chaId: entry.id, name: entry.name ?? '', type: 'character', chatPage: 0,
            ...(this.cache.summaries.get(nativeKey({ kind: 'character', id: entry.id })) ?? {}),
            chats: (entry.chats ?? []).map((chat: any) => placeholder({ id: chat.id, name: chat.name ?? '', lastDate: chat.lastDate })) }
    }
    async bootstrap() {
        const [catalog, settings] = await Promise.all([this.cache.request('/api/native/catalog'), this.cache.read(settingsTarget)])
        this.cache.acceptCatalog(catalog); this.cache.accept(settings)
        const index = catalog.value
        const summaries = await this.batches([
            ...index.characters.map((entry: any) => ({ kind: 'character', id: entry.id })),
            ...(index.collections.modules ?? []).map((id: string) => ({ kind: 'module', id })),
        ], true)
        for (const summary of summaries) this.cache.rememberSummary(summary.target, summary.value)
        const db: any = { ...nativeClone(settings.value), characters: index.characters.map((entry: any) => this.characterStub(entry)) }
        db.modules = (index.collections.modules ?? []).map((id: string) => ({ id, name: index.names?.modules?.[id] ?? '', ...this.cache.summaries.get(nativeKey({ kind: 'module', id })) }))
        for (const char of db.characters) this.cache.rememberSummary({ kind: 'character', id: char.chaId }, characterValue(char))
        for (const module of db.modules) this.cache.rememberSummary({ kind: 'module', id: module.id }, module)
        // Existing synchronous persona/preset/lorebook editors consume these small collections.
        for (const [field, kind] of Object.entries(collections)) {
            if (field === 'modules') continue
            const documents = await this.batches((index.collections[field] ?? []).map((id: string) => ({ kind, id })))
            for (const document of documents) this.cache.accept(document)
            const byId = new Map(documents.map(document => [document.target.id, document.value]))
            db[field] = (index.collections[field] ?? []).map((id: string) => {
                if (!byId.has(id)) throw new Error(`Native bootstrap omitted ${kind}/${id}`)
                return nativeClone(byId.get(id))
            })
        }
        this.view = this.membership(db)
        for (const target of this.targets(this.view)) this.knownTargets.add(nativeKey(target))
        return db
    }
    private known(target: NativeTarget) {
        // A newer catalog can remove an externally deleted entry. That never
        // grants an old UI summary permission to create a replacement document.
        if (this.knownTargets.has(nativeKey(target))) return true
        const index = this.cache.catalog?.value
        if (!index) return false
        if (target.kind === 'settings') return true
        if (target.kind === 'character') return index.characters.some((entry: any) => entry.id === target.id)
        if (target.kind === 'chat') return index.characters.find((entry: any) => entry.id === target.parentId)?.chats?.some((entry: any) => entry.id === target.id) ?? false
        const field = Object.keys(collections).find(key => collections[key] === target.kind)
        return index.collections[field]?.includes(target.id) ?? false
    }
    characterReady(id: string) { return !this.known({ kind: 'character', id }) || this.cache.isReady({ kind: 'character', id }) }
    moduleReady(id: string) { return !this.known({ kind: 'module', id }) || this.cache.isReady({ kind: 'module', id }) }
    private locate(target: NativeTarget): any {
        const db = this.database()
        if (target.kind === 'settings') return db
        if (target.kind === 'character') return db.characters.find((entry: any) => entry.chaId === target.id)
        if (target.kind === 'chat') return db.characters.find((entry: any) => entry.chaId === target.parentId)?.chats.find((entry: any) => entry.id === target.id)
        const field = Object.keys(collections).find(key => collections[key] === target.kind)
        return db[field]?.find((entry: any) => entry.id === target.id)
    }
    private value(target: NativeTarget, value = this.locate(target)) {
        if (!value) return undefined
        return target.kind === 'settings' ? settingsValue(value) : target.kind === 'character' ? characterValue(value) : target.kind === 'chat' ? chatValue(value) : value
    }
    documentDirty(target: NativeTarget): boolean {
        if (!this.known(target)) return true
        const current = this.locate(target)
        if (!current) return true
        if (target.kind === 'character') {
            const previous = this.view.characters.find((char: any) => char.id === target.id)
            if (!nativeEqual(previous?.chats, (current.chats ?? []).map((chat: any) => chat.id))) return true
        }
        if (target.kind === 'chat' && current._placeholder) {
            const before = this.cache.summaries.get(nativeKey(target)) ?? this.cache.catalog.value.characters
                .find((char: any) => char.id === target.parentId)?.chats.find((chat: any) => chat.id === target.id)
            return !nativeEqual(metadata(before ?? {}), metadata(current))
        }
        const before = this.cache.isReady(target) ? this.cache.baseline(target) : this.cache.summaries.get(nativeKey(target))
        return before !== undefined && !nativeEqual(before, this.value(target))
    }
    acknowledgeNormalization() {
        for (const envelope of this.cache.entries.values()) {
            if (envelope.metadataOnly) continue
            const value = this.value(envelope.target)
            if (value !== undefined) this.cache.accept({ ...envelope, diskValue: envelope.diskValue ?? envelope.value, value })
        }
    }
    acknowledgeCharacterNormalization(id: string, before: any) {
        const target: NativeTarget = { kind: 'character', id }
        const entry = this.cache.entries.get(nativeKey(target))
        if (entry) this.cache.accept({ ...entry, diskValue: entry.diskValue ?? entry.value, value: mergeAcknowledgedValue(entry.value, characterValue(before), this.value(target)) })
    }
    async ensureCharacter(id: string, refresh = false) {
        const target: NativeTarget = { kind: 'character', id }
        const acceptedSummaries: { target: NativeTarget; value: any; clearRevision: boolean }[] = []
        return this.ensure(target, refresh, async envelope => {
            const entry = this.cache.catalog.value.characters.find((entry: any) => entry.id === id)
            const summaries = await this.batches((entry?.chats ?? []).map((chat: any) => ({ kind: 'chat', id: chat.id, parentId: id })), true)
            const old = this.locate(target)
            const chats = (old?.chats ?? []).map((chat: any) => {
                if (!chat._placeholder) return chat
                const summary = summaries.find((value: any) => value.target.id === chat.id)
                if (!summary) return chat
                const before = this.cache.summaries.get(nativeKey(summary.target)) ?? entry.chats.find((value: any) => value.id === chat.id)
                const diskMetadata = metadata({ id: chat.id, ...summary.value })
                const localMetadata = metadata(chat)
                const merged = mergeAcknowledgedValue(localMetadata, metadata(before), diskMetadata)
                const value = placeholder({ ...chat, ...merged })
                for (const field of chatMetadataFields) if (!(field in merged)) delete value[field]
                acceptedSummaries.push({ target: summary.target, value: diskMetadata, clearRevision: nativeEqual(localMetadata, metadata(before)) })
                return value
            })
            const value = { ...envelope.value, chats, chatPage: envelope.value.chatPage ?? 0 }
            value.type ??= 'character'; value.globalLore ??= []; value.customscript ??= []
            value.firstMessage ??= ''; value.emotionImages ??= []; value.viewScreen ??= 'none'
            if (value.type === 'character') {
                value.bias ??= []; value.desc ??= ''; value.tags ??= []; value.systemPrompt ??= ''
                value.scenario ??= ''; value.creator ??= ''; value.characterVersion ??= ''; value.utilityBot ??= false
            }
            return value
        }, () => {
            for (const summary of acceptedSummaries) {
                if (summary.clearRevision) this.cache.entries.delete(nativeKey(summary.target, true))
                this.cache.rememberSummary(summary.target, summary.value)
            }
        })
    }
    async ensureModule(id: string, refresh = false) { return this.ensure({ kind: 'module', id }, refresh) }
    private async ensure(target: NativeTarget, refresh = false, prepare: (envelope: NativeEnvelope) => Promise<any> = async envelope => envelope.value, applied?: () => void) {
        const current = this.locate(target)
        if (!this.known(target)) return current
        if (this.cache.isReady(target) && (!refresh || this.cache.write(target, this.value(target)))) return current
        const key = nativeKey(target)
        if (this.pending.has(key)) return this.pending.get(key)
        const promise = (async () => {
            const before = nativeClone(this.cache.isReady(target) ? this.value(target) : (this.cache.summaries.get(key) ?? this.value(target)))
            const envelope = await this.cache.read(target)
            const diskValue = nativeClone(envelope.value)
            const normalized = await prepare(envelope)
            const value = this.cache.isReady(target) ? normalized : mergeAcknowledgedValue(this.locate(target), { ...before, ...(target.kind === 'character' ? { chats: this.locate(target)?.chats } : {}) }, normalized)
            // Refresh never consumes an edit made while the read was in flight.
            if (this.cache.isReady(target) && !nativeEqual(before, this.value(target))) return this.locate(target)
            const db = this.database()
            if (target.kind === 'character') {
                const index = db.characters.findIndex((entry: any) => entry.chaId === target.id)
                if (index < 0) return undefined
                db.characters[index] = value
            } else {
                const field = Object.keys(collections).find(key => collections[key] === target.kind)
                const index = db[field].findIndex((entry: any) => entry.id === target.id)
                if (index < 0) return undefined
                db[field][index] = value
            }
            applied?.()
            this.cache.accept({ ...envelope, diskValue, value: this.value(target, normalized) })
            return this.locate(target)
        })().finally(() => this.pending.delete(key))
        this.pending.set(key, promise)
        return promise
    }
    async readChat(parentId: string, id: string) {
        const envelope = await this.cache.read({ kind: 'chat', id, parentId })
        const diskValue = nativeClone(envelope.value)
        const value = this.normalizeChat(envelope.value)
        value.isStreaming = false; delete value.activeStreamingDisplayOptimizationMode
        this.cache.accept({ ...envelope, diskValue, value: chatValue(value) })
        return value
    }
    async refreshChat(parentId: string, id: string) {
        const target: NativeTarget = { kind: 'chat', parentId, id }
        const current = this.locate(target)
        if (!current || current._placeholder || !this.known(target) || !this.cache.isReady(target) || this.cache.write(target, chatValue(current))) return current
        const key = nativeKey(target)
        if (this.pending.has(key)) return this.pending.get(key)
        const promise = (async () => {
            const before = nativeClone(chatValue(current))
            const envelope = await this.cache.read(target)
            const diskValue = nativeClone(envelope.value)
            const latest = this.locate(target)
            if (!latest || !nativeEqual(before, chatValue(latest))) return latest
            const value = this.normalizeChat(envelope.value)
            value.isStreaming = false; delete value.activeStreamingDisplayOptimizationMode
            const char = this.locate({ kind: 'character', id: parentId })
            const index = char.chats.findIndex((chat: any) => chat.id === id)
            if (index < 0) return undefined
            char.chats[index] = value
            this.cache.accept({ ...envelope, diskValue, value: chatValue(value) })
            return char.chats[index]
        })().finally(() => this.pending.delete(key))
        this.pending.set(key, promise)
        return promise
    }
    mergeHydratedChat(parentId: string, summary: any, full: any) {
        const before = this.cache.summaries.get(nativeKey({ kind: 'chat', parentId, id: summary.id }))
            ?? this.cache.catalog.value.characters.find((char: any) => char.id === parentId)?.chats.find((chat: any) => chat.id === summary.id)
        if (!before) return full
        for (const field of chatMetadataFields) {
            if (nativeEqual(before[field], summary[field])) continue
            if (summary[field] === undefined) delete full[field]
            else full[field] = nativeClone(summary[field])
        }
        return full
    }
    private membership(db: any) {
        return { characters: (db.characters ?? []).map((char: any) => ({ id: char.chaId, chats: (char.chats ?? []).map((chat: any) => chat.id) })),
            collections: Object.fromEntries(Object.keys(collections).map(field => [field, (db[field] ?? []).map((entry: any) => entry.id)])) }
    }
    private targets(view: any): NativeTarget[] {
        return [...view.characters.flatMap((char: any) => [{ kind: 'character', id: char.id }, ...char.chats.map((id: string) => ({ kind: 'chat', id, parentId: char.id }))]),
            ...Object.entries(collections).flatMap(([field, kind]) => view.collections[field].map((id: string) => ({ kind, id })))]
    }
    persist(scope?: NativeSaveScope): Promise<boolean> {
        if (this.saving) return this.saving.then(() => this.persist(scope))
        this.saving = this.persistNow(scope).finally(() => { this.saving = null })
        return this.saving
    }
    private async persistNow(scope?: NativeSaveScope) {
        const db = this.database()
        for (const char of db.characters ?? []) {
            char.chaId ||= uuidv4()
            for (const chat of char.chats ?? []) chat.id ||= uuidv4()
        }
        for (const field of Object.keys(collections)) for (const value of db[field] ?? []) value.id ||= uuidv4()
        const view = this.membership(db)
        const targets = [settingsTarget, ...this.targets(view)]
        const writes: NativeWrite[] = []
        for (const target of targets) {
            if (scope && this.known(target)) {
                const included = target.kind === 'settings' ? scope.root || scope.plugins || scope.pluginCustomStorage
                    : target.kind === 'character' ? scope.character?.includes(target.id)
                    : target.kind === 'chat' ? scope.chat?.some(([parentId, id]) => parentId === target.parentId && id === target.id)
                        || (this.locate(target)?._placeholder && scope.character?.includes(target.parentId))
                    : target.kind === 'module' ? scope.modules
                    : target.kind === 'prompt' ? scope.botPreset : scope.root
                if (!included) continue
            }
            if ((target.kind === 'character' || target.kind === 'module') && this.known(target) && !this.cache.isReady(target)) {
                const before = this.cache.summaries.get(nativeKey(target))
                const current = nativeClone(this.value(target))
                if (before && !nativeEqual(before, current)) {
                    if (target.kind === 'character') await this.ensureCharacter(target.id)
                    else await this.ensureModule(target.id)
                }
            }
            const current = this.locate(target)
            if (target.kind === 'chat' && current?._placeholder) {
                const before = this.cache.summaries.get(nativeKey(target)) ?? this.cache.catalog.value.characters.find((char: any) => char.id === target.parentId)?.chats.find((chat: any) => chat.id === target.id)
                if (before && !nativeEqual(metadata(before), metadata(current))) {
                    if (!this.cache.isReady(target, true)) this.cache.accept(await this.cache.read(target, true))
                    const value = nativeClone(this.cache.baseline(target, true))
                    for (const field of chatMetadataFields) {
                        if (nativeEqual(before[field], current[field])) continue
                        if (current[field] === undefined) delete value[field]
                        else value[field] = nativeClone(current[field])
                    }
                    const write = this.cache.write(target, value, { metadataOnly: true })
                    if (write) writes.push(write)
                }
                continue
            }
            const write = this.cache.write(target, this.value(target), { create: !this.known(target) })
            if (write) writes.push(write)
        }
        const currentKeys = new Set(this.targets(view).map(target => nativeKey(target)))
        const deleted = this.targets(this.view).filter(target => !currentKeys.has(nativeKey(target)))
        for (const target of deleted) {
            // Parent deletion owns its children. Never independently delete sibling chats.
            if (target.kind === 'chat' && deleted.some(parent => parent.kind === 'character' && parent.id === target.parentId)) continue
            if (!this.cache.isReady(target)) this.cache.accept(await this.cache.read(target))
            const write = this.cache.write(target, null)
            if (write) writes.push(write)
        }
        const changedMembership = !nativeEqual(view, this.view)
        if (scope && !changedMembership) {
            // Keep conflicted local data for resolution without preventing
            // unrelated documents from being saved automatically.
            for (let index = writes.length - 1; index >= 0; index--) if (this.cache.blocked(writes[index])) writes.splice(index, 1)
        }
        if (!writes.length && !changedMembership) return false
        let catalog: { expectedRevision: string; value: any } | undefined
        if (changedMembership) {
            const value = nativeClone(this.cache.catalog.value)
            const oldCharIds = new Set(this.view.characters.map((char: any) => char.id))
            value.characters = [...view.characters.map((char: any) => {
                const existing = value.characters.find((entry: any) => entry.id === char.id)
                const oldChats = new Set(this.view.characters.find((entry: any) => entry.id === char.id)?.chats ?? [])
                return { ...existing, id: char.id, name: this.locate({ kind: 'character', id: char.id })?.name ?? '', chats: [
                    ...char.chats.map((id: string) => ({ ...(existing?.chats ?? []).find((entry: any) => entry.id === id), id, name: this.locate({ kind: 'chat', id, parentId: char.id })?.name ?? '' })),
                    ...(existing?.chats ?? []).filter((entry: any) => !oldChats.has(entry.id) && !char.chats.includes(entry.id)),
                ] }
            }), ...value.characters.filter((entry: any) => !oldCharIds.has(entry.id) && !view.characters.some((char: any) => char.id === entry.id))]
            for (const field of Object.keys(collections)) value.collections[field] = [...view.collections[field], ...(value.collections[field] ?? []).filter((id: string) => !this.view.collections[field].includes(id) && !view.collections[field].includes(id))]
            catalog = { expectedRevision: this.cache.catalog.revision, value }
        }
        this.savingChanged(true)
        let result
        try {
            result = await this.cache.commit(writes, catalog)
        } finally {
            this.savingChanged(false)
        }
        for (const write of writes) {
            if (write.value === null) {
                this.knownTargets.delete(nativeKey(write.target))
                if (write.target.kind === 'character') for (const child of this.targets(this.view)) {
                    if (child.kind !== 'chat' || child.parentId !== write.target.id) continue
                    this.knownTargets.delete(nativeKey(child))
                    this.cache.entries.delete(nativeKey(child))
                    this.cache.entries.delete(nativeKey(child, true))
                    this.cache.summaries.delete(nativeKey(child))
                }
                continue
            }
            this.knownTargets.add(nativeKey(write.target))
            const envelope = result.documents.find((entry: NativeEnvelope) => nativeKey(entry.target) === nativeKey(write.target))
            const current = this.locate(write.target)
            if (!current) continue
            const merged = mergeAcknowledgedValue(write.metadataOnly ? metadata(current) : this.value(write.target), write.value, envelope.value)
            const keys = write.metadataOnly ? chatMetadataFields : Object.keys(write.value)
            for (const key of keys) if (!(key in merged)) delete current[key]
            for (const [key, value] of Object.entries(merged)) current[key] = reconcileSavedValue(current[key], value)
            if (write.metadataOnly) this.cache.rememberSummary(write.target, metadata(envelope.value))
        }
        this.view = view
        return true
    }
    async hydrateCharacter(id: string, includeChats = true) {
        await this.ensureCharacter(id)
        const current = this.locate({ kind: 'character', id })
        if (includeChats && current) for (const chatId of current.chats.map((chat: any) => chat.id)) {
            if (!this.locate({ kind: 'chat', id: chatId, parentId: id })?._placeholder) continue
            const full = await this.readChat(id, chatId)
            const character = this.locate({ kind: 'character', id })
            const index = character?.chats.findIndex((chat: any) => chat.id === chatId) ?? -1
            if (index >= 0 && character.chats[index]._placeholder) character.chats[index] = this.mergeHydratedChat(id, character.chats[index], full)
        }
        return this.locate({ kind: 'character', id })
    }
    async hydrateAll(includeChats = true) {
        for (const char of [...this.database().characters]) await this.hydrateCharacter(char.chaId, includeChats)
        for (const module of [...this.database().modules]) await this.ensureModule(module.id)
    }
}

export let nativeRuntime: NativeRuntime | undefined
export function startNativeRuntime(request: NativeRequest, database: () => any, normalizeChat: (value: any) => any,
    savingChanged: (state: boolean) => void = () => {}) {
    nativeRuntime = new NativeRuntime(request, database, normalizeChat, savingChanged)
    return nativeRuntime
}
export const isNativeRuntime = () => !!nativeRuntime
export const isCharacterReady = (id: string) => nativeRuntime?.characterReady(id) ?? true
export const ensureCharacterReady = async (id: string, refresh = false) => nativeRuntime?.ensureCharacter(id, refresh)
export const ensureModuleReady = async (id: string, refresh = false) => nativeRuntime?.ensureModule(id, refresh)

export async function withHydratedCharacter<T>(id: string, characters: () => any[], hydrate: (id: string) => Promise<unknown>, apply: (character: any, index: number) => T): Promise<T | undefined> {
    if (!id) return undefined
    await hydrate(id)
    const index = characters().findIndex(character => character.chaId === id)
    if (index < 0) return undefined
    return apply(characters()[index], index)
}

/** Plugin setters accept partial objects; omitted fields never erase loaded bodies. */
export function mergeNativeCharacterInput(current: any, incoming: any) {
    if (!nativeRuntime || !current) return incoming
    return { ...current, ...incoming, chats: incoming.chats === undefined ? current.chats : incoming.chats.map((chat: any) => {
        const previous = current.chats?.find((entry: any) => entry.id === chat.id)
        if (chat._placeholder || chat._stub) return previous ? { ...previous, ...metadata(chat) } : chat
        return { ...previous, ...chat }
    }) }
}
export function mergeNativeDatabaseInput(incoming: any) {
    if (!nativeRuntime) return incoming
    const db = nativeRuntime.database()
    const value = { ...incoming }
    if (Array.isArray(value.characters)) value.characters = value.characters.map((char: any) => mergeNativeCharacterInput(db.characters.find((entry: any) => entry.chaId === char.chaId), char))
    for (const field of Object.keys(collections)) if (Array.isArray(value[field])) value[field] = value[field].map((entry: any) => ({ ...db[field]?.find((old: any) => old.id === entry.id), ...entry }))
    return value
}

let activeModulesPending: Promise<void> | undefined
export async function hydrateActiveModuleScopes(resolveIds: () => string[], isReady: (id: string) => boolean, hydrate: (id: string) => Promise<unknown>) {
    while (true) {
        const missing = resolveIds().filter(id => !isReady(id))
        if (!missing.length) return
        for (const id of missing) await hydrate(id)
    }
}
export async function ensureActiveModulesReady() {
    if (!nativeRuntime) return
    if (activeModulesPending) return activeModulesPending
    activeModulesPending = (async () => {
        // Resolve all active scopes with the existing runtime selector.
        const { getModules } = await import('../process/modules')
        await hydrateActiveModuleScopes(() => getModules().map(module => module.id), id => nativeRuntime.moduleReady(id), id => nativeRuntime.ensureModule(id))
    })().finally(() => { activeModulesPending = undefined })
    return activeModulesPending
}
