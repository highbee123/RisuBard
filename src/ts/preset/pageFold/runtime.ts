import { language } from 'src/lang'
import type { AdapterChatMessage, AdapterChatOptions, AdapterChatResponse, AdapterPreparedRequest } from '../adapter/types'
import type { ModelPreset, ModelPresetPdfConfig } from '../types'
import type { PageFoldHost, PageFoldLogEntry, PageFoldMetadata, PageFoldRequestInit, PageFoldStatus } from './types'
import { generateTranscriptPdf, packagePrompt, estimateTextTokens, restoreResponseNewlines, createStreamingNewlineRestorer } from './vendor.mjs';


interface DiscoveredPrice { price: number; at: number; source: string }
interface PriceCatalog { data?: { id?: string; pricing?: { prompt?: string | number | null } }[] }
// Provider body fields touched by PageFold; all other adapter fields stay opaque.
interface PageFoldWireBody extends Record<string, unknown> {
  generationConfig?: Record<string, unknown> & { thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number }; responseMimeType?: string }
  contents?: Record<string, unknown>[]
  messages?: Record<string, unknown>[]
  plugins?: (Record<string, unknown> & { id?: string })[]
  stream_options?: Record<string, unknown>
  service_tier?: string
  reasoning_effort?: string
  reasoning?: { effort?: string }
}
interface UsageFields {
  promptTokenCount?: unknown; prompt_tokens?: unknown
  candidatesTokenCount?: unknown; completion_tokens?: unknown
  thoughtsTokenCount?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown }
  cost?: unknown
}
interface UsageFrame { service_tier?: string; usageMetadata?: UsageFields; usage?: UsageFields }
type Pdf = Awaited<ReturnType<typeof generateTranscriptPdf>>
type DisplayRequest = { __pageFold?: Pick<PageFoldMetadata, 'structuredOutput'> }
interface NewlineRestorer { push: (text: string) => string; flush: () => string }

let host: PageFoldHost = {};
const priceCache = new Map<string, DiscoveredPrice>();
export async function discoverPrice(prepared: AdapterPreparedRequest, preset: ModelPreset): Promise<DiscoveredPrice | null> {
  const url = new URL(prepared.url);
  const gateway = url.hostname === 'openrouter.ai' || ['vercel', 'llmgateway'].includes(preset.profileSnapshot?.providerBaseId);
  if (!gateway || !/\/chat\/completions\/?$/.test(url.pathname)) return null;
  const catalog = new URL(url.href); catalog.pathname = catalog.pathname.replace(/\/chat\/completions\/?$/, '/models'); catalog.search = '';
  const headers = url.hostname === 'openrouter.ai' ? {} : prepared.headers;
  const model = state(preset).modelId;
  const key = catalog.href + ':' + model;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < 3600000) return cached;
  try {
    const response = await (host.priceFetch ?? fetch)(catalog.href, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const data: PriceCatalog = await response.json();
    const entry = data.data?.find(m => m.id === model);
    const raw = entry?.pricing?.prompt;
    if (raw == null || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) return null;
    const value = { price: Number(raw) * 1e6, at: Date.now(), source: catalog.origin + '/models' };
    priceCache.set(key, value); return value;
  } catch { return null; }
}
export function configure(value: PageFoldHost): void { host = value; }
export function config(preset: ModelPreset): ModelPresetPdfConfig {
  const value: Partial<ModelPresetPdfConfig> = preset?.pageFold ?? {};
  return {
    enabled: value.enabled === true,
    packagingMode: value.packagingMode === 'balanced' ? 'balanced' : 'maximum',
    fontSize: Number.isFinite(value.fontSize) ? Math.round(Math.min(12, Math.max(.5, value.fontSize)) * 10) / 10 : 1,
    mergeConsecutiveRoles: value.mergeConsecutiveRoles === true,
    inputPrice: typeof value.inputPrice === 'number' && Number.isFinite(value.inputPrice) && value.inputPrice >= 0 ? value.inputPrice : null,
  };
}
export function state(preset: ModelPreset): { modelId: string; eligible: boolean; active: boolean } {
  let modelId = '';
  try { modelId = host.resolveModel ? host.resolveModel(preset) : resolveModel(preset); } catch {}
  const eligible = /gemini/i.test(modelId);
  return { modelId, eligible, active: eligible && config(preset).enabled };
}
export function resolveModel(preset: ModelPreset): string {
  const field = preset?.profileSnapshot?.schema?.find(f => f?.key === 'modelId');
  if (field) {
    const value = preset.userValues?.modelId;
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.length) throw Error(language.pageFold.modelIdRequired);
      return value;
    }
    if (typeof field.default === 'string' && field.default.length) return field.default;
  }
  return preset?.profileSnapshot?.modelId ?? '';
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException(language.pageFold.requestAborted, 'AbortError'); }
let cachedPdf: { key: string; pdf: Pdf } | undefined;
function status(detail: PageFoldStatus): void { try { host.status?.(detail); } catch {} }

// Preserve structured tool history and its signatures as an untouched suffix.
function splitMessages(messages: AdapterChatMessage[]): { prefix: AdapterChatMessage[]; tail: AdapterChatMessage[] } {
  const boundary = messages.findIndex(m => m.role === 'tool' || m.toolCalls?.length || m.providerEcho || m.reasoning?.some(r => r.signature));
  return { prefix: boundary < 0 ? messages : messages.slice(0, boundary), tail: boundary < 0 ? [] : messages.slice(boundary) };
}
export async function prepare<T extends AdapterPreparedRequest>(prepared: T, preset: ModelPreset, options: AdapterChatOptions, kind: NonNullable<PageFoldMetadata['kind']>): Promise<T> {
  if (!state(preset).active) return prepared;
  abort(options.abortSignal);
  const cfg = config(preset);
  const model = state(preset).modelId;
  const messages = options.messages ?? [];
  const { prefix, tail } = splitMessages(messages);
  if (!prefix.length) throw Error(language.pageFold.noPdfMessages);
  const text = prefix.map((m, i) => ({ role: m.role, content: String(m.content ?? '') + (m.images?.length ? '\n[' + m.images.length + ' image(s) from message ' + (i + 1) + ' attached separately]' : '') }));
  const packed = packagePrompt(text, cfg.packagingMode, { mergeConsecutiveRoles: cfg.mergeConsecutiveRoles });
  if (tail.length) {
    if (cfg.packagingMode === 'maximum') {
      packed.systemText = packed.systemText.replace(
        'The attached PDF contains the complete ordered prompt and conversation transcript.',
        'The attached PDF contains the earlier portion of the ordered prompt and conversation transcript.',
      );
    }
    packed.systemText += ' Subsequent messages and tool records follow separately after the PDF attachment. Read them as the continuation of the PDF context, and respond after considering the full sequence.';
  }
  status({ presetId: preset.id, generationId: options.generationId, phase: language.pageFold.generating });
  // Exact input comparison avoids collisions in the original 32-bit hash cache.
  const cacheKey = JSON.stringify([packed.pdfTranscript, cfg.fontSize]);
  const cacheHit = cachedPdf?.key === cacheKey;
  let pdf: Pdf;
  if (cacheHit) pdf = cachedPdf.pdf;
  else {
    pdf = await generateTranscriptPdf(packed.pdfTranscript || '(Empty conversation)', { fontSize: cfg.fontSize });
    if (pdf.bytes.length <= 8 * 1024 * 1024) cachedPdf = { key: cacheKey, pdf };
  }
  abort(options.abortSignal);
  const images = prefix.flatMap((m, i) => (m.images ?? []).map(img => ({ ...img, messageIndex: i + 1 })));
  const wire = prepared.body as PageFoldWireBody;
  if (kind === 'google') {
    // PageFold 0.2.4 fixes native Gemini PDF requests to LOW (no user option).
    wire.generationConfig = { ...wire.generationConfig, mediaResolution: 'MEDIA_RESOLUTION_LOW' };
    const original = wire.contents ?? [];
    // Build the suffix with the existing adapter so tool results/signatures retain their exact wire form.
    let suffix: Record<string, unknown>[] = [];
    if (tail.length) {
      const originalChatCount = prefix.filter(m => m.role !== 'system').length;
      suffix = original.slice(originalChatCount);
    }
    wire.systemInstruction = { parts: [{ text: [packed.systemText, ...tail.filter(m => m.role === 'system').map(m => m.content)].join('\n\n') }] };
    const parts: Record<string, unknown>[] = [{ inlineData: { mimeType: 'application/pdf', data: pdf.base64 } }];
    for (const img of images) parts.push({ text: 'Image from message ' + img.messageIndex }, { inlineData: { mimeType: img.mime ?? 'image/png', data: img.base64 } });
    wire.contents = [{ role: 'user', parts }, ...suffix];
    delete wire.cachedContent;
  } else {
    const original = wire.messages ?? [];
    const suffix = tail.length ? original.slice(prefix.length) : [];
    const content: Record<string, unknown>[] = [{ type: 'file', file: { filename: 'pagefold-context.pdf', file_data: 'data:application/pdf;base64,' + pdf.base64 } }];
    for (const img of images) content.push({ type: 'text', text: 'Image from message ' + img.messageIndex }, { type: 'image_url', image_url: { url: 'data:' + (img.mime ?? 'image/png') + ';base64,' + img.base64 } });
    wire.messages = [{ role: 'system', content: packed.systemText }, { role: 'user', content }, ...suffix];
    const endpoint = new URL(prepared.url);
    if (endpoint.hostname === 'openrouter.ai' || /openrouter/i.test(preset.profileSnapshot.providerBaseId)) {
      const plugins = Array.isArray(wire.plugins) ? wire.plugins : [];
      wire.plugins = [...plugins.filter(p => p.id !== 'file-parser'), { id: 'file-parser', pdf: { engine: 'native' } }];
    }
    if (wire.stream && host.db?.().requestLogStreamUsage !== false) wire.stream_options = { ...wire.stream_options, include_usage: true };
  }
  const comparable = !images.length && !tail.length && !options.tools?.length;
  const baselineTokens = comparable ? estimateTextTokens(packed.baselineText) : null;
  const baselineSource = 'pagefold-character-estimate-v1';
  abort(options.abortSignal);
  const headers = new Headers(prepared.headers);
  prepared.__pageFold = {
    version: 1, generationId: options.generationId, cacheHit, requestId: globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random().toString(36).slice(2),
    presetId: preset.id, presetName: preset.name, modelId: model, packagingMode: cfg.packagingMode, fontSize: cfg.fontSize,
    pages: pdf.pageCount, bytes: pdf.bytes.length, sourceCharacters: packed.baselineText.length,
    baselineTokens,
    baselineSource, comparable, inputPrice: cfg.inputPrice,
    priceSource: cfg.inputPrice == null ? null : 'manual', priceTimestamp: cfg.inputPrice == null ? null : Date.now(), currency: 'USD',
    requestedServiceTier: wire.service_tier ?? headers.get('x-vertex-ai-llm-request-type') ?? null,
    reasoningEffort: wire.reasoning_effort ?? wire.reasoning?.effort ?? wire.generationConfig?.thinkingConfig?.thinkingLevel ?? null,
    thinkingBudget: wire.generationConfig?.thinkingConfig?.thinkingBudget ?? null, pdfContent: packed.pdfTranscript,
    structuredOutput: Boolean(options.responseSchema || wire.response_format || wire.generationConfig?.responseMimeType === 'application/json'), kind,
  };
  if (cfg.inputPrice === null) void discoverPrice(prepared, preset).then(price => { if (price) Object.assign(prepared.__pageFold, { inputPrice: price.price, priceSource: price.source, priceTimestamp: price.at }); });
  status({ presetId: preset.id, generationId: options.generationId, phase: language.pageFold.preparing, pages: pdf.pageCount, bytes: pdf.bytes.length, baselineTokens });
  return prepared;
}

// Add metadata to RequestInit (not the provider body); the native log collector consumes it.
export function wrapFetch(preset: ModelPreset, options: Pick<AdapterChatOptions, 'abortSignal' | 'generationId'>, prepared: Pick<AdapterPreparedRequest, '__pageFold'>, original: typeof fetch): typeof fetch {
  if (!prepared.__pageFold) return original;
  return async (url, init) => {
    abort(options.abortSignal);
    status({ presetId: preset.id, generationId: options.generationId, phase: language.pageFold.waiting, pages: prepared.__pageFold.pages });
    const result = await original(url, { ...init, __pageFold: prepared.__pageFold } as PageFoldRequestInit);
    return result;
  };
}

export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)) return '[Attachment data omitted]';
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|service[-_]?account)$/i.test(key)) out[key] = '[Credentials redacted]';
    else if (key === 'data' && ((value as Record<string, unknown>).mimeType || (value as Record<string, unknown>).mime_type)) out[key] = '[Attachment data omitted]';
    else if (!key.startsWith('__pageFold')) out[key] = sanitize(item);
  }
  return out;
}
export function sanitizeBody<T extends string | undefined>(text: T): T { try { return JSON.stringify(sanitize(JSON.parse(text))) as T; } catch { return text; } }
export function finalizeLogs<T extends PageFoldLogEntry>(entries: T[], saveBodies: boolean): T[] {
  for (const entry of entries) {
    if (!entry.pageFold) continue;
    const pf = entry.pageFold;
    pf.responseTokens = null;
    let frames: UsageFrame[] = [], googleUsage = false, googleResponseTokens: number | null = null;
    try { frames = [JSON.parse(entry.responseBody)]; } catch {
      frames = String(entry.responseBody ?? '').split(/\r?\n/).filter(s => s.startsWith('data:')).flatMap(s => { try { return [JSON.parse(s.slice(5))]; } catch { return []; } });
    }
    for (const frame of frames) {
      pf.servedServiceTier = frame.service_tier ?? pf.servedServiceTier;
      const u = frame.usageMetadata ?? frame.usage;
      if (frame.usageMetadata) { googleUsage = true; googleResponseTokens = finite(u.candidatesTokenCount) ?? googleResponseTokens; }
      if (!u) continue;
      entry.inputTokens = finite(u.promptTokenCount ?? u.prompt_tokens) ?? entry.inputTokens;
      entry.outputTokens = (frame.usageMetadata ? finite(u.candidatesTokenCount) : finite(u.completion_tokens)) ?? entry.outputTokens;
      entry.reasoningTokens = finite(u.thoughtsTokenCount ?? u.completion_tokens_details?.reasoning_tokens) ?? entry.reasoningTokens;
      pf.actualCost = finite(u.cost) ?? pf.actualCost;
      pf.servedServiceTier = frame.service_tier ?? pf.servedServiceTier;
    }
    pf.responseTokens = googleUsage ? googleResponseTokens : pf.kind === 'google' ? finite(entry.outputTokens) : finite(entry.outputTokens) === null ? null : Math.max(0, entry.outputTokens - (entry.reasoningTokens ?? 0));
    pf.inputSource = finite(entry.inputTokens) === null ? 'unavailable' : 'provider';
    pf.savedTokens = entry.success && pf.comparable && finite(entry.inputTokens) !== null ? pf.baselineTokens - entry.inputTokens : null;
    pf.savedUsd = pf.savedTokens !== null && finite(pf.inputPrice) !== null ? pf.savedTokens * pf.inputPrice / 1e6 : null;
    if (saveBodies) {
      entry.requestBody = sanitizeBody(entry.requestBody);
      entry.responseBody = sanitizeBody(entry.responseBody);
    } else {
      delete entry.requestBody; delete entry.responseBody; delete entry.requestHeaders; delete pf.pdfContent;
    }
    status({ presetId: pf.presetId, generationId: pf.generationId, phase: entry.aborted ? language.pageFold.aborted : entry.success ? language.pageFold.completed : language.pageFold.failed, pages: pf.pages, bytes: pf.bytes, baselineTokens: pf.baselineTokens, savedTokens: pf.savedTokens, inputTokens: entry.inputTokens });
  }
  return entries;
}
export function finite(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await host.authHeaders!();
  const response = await fetch('/api/request-logs/pagefold' + path, { ...init, headers: { ...headers, 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) throw Error(response.status === 404 ? language.pageFold.statsRestart : language.pageFold.statsLoadFailed.replace('{0}', String(response.status)));
  return response.json();
}

// Operate on parsed display text only. Provider echoes and signature-bearing raw responses stay untouched.
export function responseRestorer(prepared: DisplayRequest): NewlineRestorer {
  if (!prepared.__pageFold || prepared.__pageFold.structuredOutput) return { push: text => text, flush: () => '' };
  return createStreamingNewlineRestorer();
}
export function restoreParsed<T extends Pick<AdapterChatResponse, 'text'>>(prepared: DisplayRequest, parsed: T): T {
  if (!prepared.__pageFold || prepared.__pageFold.structuredOutput) return parsed;
  return { ...parsed, text: restoreResponseNewlines(parsed.text) };
}
