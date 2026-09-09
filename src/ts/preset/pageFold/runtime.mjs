import { generateTranscriptPdf, packagePrompt, estimateTextTokens, restoreResponseNewlines, createStreamingNewlineRestorer } from './vendor.mjs';

let host = {};
const priceCache = new Map();
export async function discoverPrice(prepared, preset) {
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
    const data = await response.json();
    const entry = data.data?.find(m => m.id === model);
    const raw = entry?.pricing?.prompt;
    if (raw == null || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) return null;
    const value = { price: Number(raw) * 1e6, at: Date.now(), source: catalog.origin + '/models' };
    priceCache.set(key, value); return value;
  } catch { return null; }
}
export function configure(value) { host = value; }
export function config(preset) {
  const value = preset?.pageFold ?? {};
  return {
    enabled: value.enabled === true,
    packagingMode: value.packagingMode === 'balanced' ? 'balanced' : 'maximum',
    fontSize: Number.isFinite(value.fontSize) ? Math.round(Math.min(12, Math.max(.5, value.fontSize)) * 10) / 10 : 1,
    mergeConsecutiveRoles: value.mergeConsecutiveRoles === true,
    inputPrice: typeof value.inputPrice === 'number' && Number.isFinite(value.inputPrice) && value.inputPrice >= 0 ? value.inputPrice : null,
  };
}
export function state(preset) {
  let modelId = '';
  try { modelId = host.resolveModel ? host.resolveModel(preset) : resolveModel(preset); } catch {}
  const eligible = /gemini/i.test(modelId);
  return { modelId, eligible, active: eligible && config(preset).enabled };
}
export function resolveModel(preset) {
  const field = preset?.profileSnapshot?.schema?.find(f => f?.key === 'modelId');
  if (field) {
    const value = preset.userValues?.modelId;
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.length) throw Error('Model ID를 입력하세요.');
      return value;
    }
    if (typeof field.default === 'string' && field.default.length) return field.default;
  }
  return preset?.profileSnapshot?.modelId ?? '';
}
function abort(signal) { if (signal?.aborted) throw new DOMException('요청이 중단되었습니다.', 'AbortError'); }
let cachedPdf;
const events = new EventTarget();
export function subscribe(callback) { events.addEventListener('status', callback); return () => events.removeEventListener('status', callback); }
function status(detail) { events.dispatchEvent(new CustomEvent('status', { detail })); try { host.status?.(detail); } catch {} }

// Preserve structured tool history and its signatures as an untouched suffix.
function splitMessages(messages) {
  const boundary = messages.findIndex(m => m.role === 'tool' || m.toolCalls?.length || m.providerEcho || m.reasoning?.some(r => r.signature));
  return { prefix: boundary < 0 ? messages : messages.slice(0, boundary), tail: boundary < 0 ? [] : messages.slice(boundary) };
}
export async function prepare(prepared, preset, options, kind) {
  if (!state(preset).active) return prepared;
  abort(options.abortSignal);
  const cfg = config(preset);
  const model = state(preset).modelId;
  const messages = options.messages ?? [];
  const { prefix, tail } = splitMessages(messages);
  if (!prefix.length) throw Error('PDF로 묶을 일반 대화가 없습니다. 이 도구 요청은 PDF 사용을 끄고 실행하세요.');
  const text = prefix.map((m, i) => ({ role: m.role, content: String(m.content ?? '') + (m.images?.length ? '\n[메시지 ' + (i + 1) + '의 이미지 ' + m.images.length + '개는 별도 첨부됨]' : '') }));
  const packed = packagePrompt(text, cfg.packagingMode, { mergeConsecutiveRoles: cfg.mergeConsecutiveRoles });
  status({ presetId: preset.id, generationId: options.generationId, phase: 'PDF 생성 중' });
  // Exact input comparison avoids collisions in the original 32-bit hash cache.
  const cacheKey = JSON.stringify([packed.pdfTranscript, cfg.fontSize]);
  const cacheHit = cachedPdf?.key === cacheKey;
  let pdf;
  if (cacheHit) pdf = cachedPdf.pdf;
  else {
    pdf = await generateTranscriptPdf(packed.pdfTranscript || '(빈 대화)', { fontSize: cfg.fontSize });
    if (pdf.bytes.length <= 8 * 1024 * 1024) cachedPdf = { key: cacheKey, pdf };
  }
  abort(options.abortSignal);
  const images = prefix.flatMap((m, i) => (m.images ?? []).map(img => ({ ...img, messageIndex: i + 1 })));
  const wire = prepared.body;
  if (kind === 'google') {
    // PageFold 0.2.4 fixes native Gemini PDF requests to LOW (no user option).
    wire.generationConfig = { ...wire.generationConfig, mediaResolution: 'MEDIA_RESOLUTION_LOW' };
    const original = wire.contents ?? [];
    // Build the suffix with the existing adapter so tool results/signatures retain their exact wire form.
    let suffix = [];
    if (tail.length) {
      const originalChatCount = prefix.filter(m => m.role !== 'system').length;
      suffix = original.slice(originalChatCount);
    }
    wire.systemInstruction = { parts: [{ text: [packed.systemText, ...tail.filter(m => m.role === 'system').map(m => m.content)].join('\n\n') }] };
    const parts = [{ inlineData: { mimeType: 'application/pdf', data: pdf.base64 } }];
    for (const img of images) parts.push({ text: '메시지 ' + img.messageIndex + '의 이미지' }, { inlineData: { mimeType: img.mime ?? 'image/png', data: img.base64 } });
    wire.contents = [{ role: 'user', parts }, ...suffix];
    delete wire.cachedContent;
  } else {
    const original = wire.messages ?? [];
    const suffix = tail.length ? original.slice(prefix.length) : [];
    const content = [{ type: 'file', file: { filename: 'pagefold-context.pdf', file_data: 'data:application/pdf;base64,' + pdf.base64 } }];
    for (const img of images) content.push({ type: 'text', text: '메시지 ' + img.messageIndex + '의 이미지' }, { type: 'image_url', image_url: { url: 'data:' + (img.mime ?? 'image/png') + ';base64,' + img.base64 } });
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
  status({ presetId: preset.id, generationId: options.generationId, phase: 'PDF 전송 준비', pages: pdf.pageCount, bytes: pdf.bytes.length, baselineTokens });
  return prepared;
}

// Add metadata to RequestInit (not the provider body); the native log collector consumes it.
export function wrapFetch(preset, options, prepared, original) {
  if (!prepared.__pageFold) return original;
  return async (url, init) => {
    abort(options.abortSignal);
    status({ presetId: preset.id, generationId: options.generationId, phase: '응답 기다리는 중', pages: prepared.__pageFold.pages });
    const result = await original(url, { ...init, __pageFold: prepared.__pageFold });
    return result;
  };
}

export function sanitize(value) {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)) return '[첨부 데이터 생략]';
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|service[-_]?account)$/i.test(key)) out[key] = '[인증정보 제거]';
    else if (key === 'data' && (value.mimeType || value.mime_type)) out[key] = '[첨부 데이터 생략]';
    else if (!key.startsWith('__pageFold')) out[key] = sanitize(item);
  }
  return out;
}
export function sanitizeBody(text) { try { return JSON.stringify(sanitize(JSON.parse(text))); } catch { return text; } }
export function finalizeLogs(entries, saveBodies) {
  for (const entry of entries) {
    if (!entry.pageFold) continue;
    const pf = entry.pageFold;
    pf.responseTokens = null;
    let frames = [], googleUsage = false, googleResponseTokens = null;
    try { frames = [JSON.parse(entry.responseBody)]; } catch {
      frames = String(entry.responseBody ?? '').split(/\r?\n/).filter(s => s.startsWith('data:')).flatMap(s => { try { return [JSON.parse(s.slice(5))]; } catch { return []; } });
    }
    for (const frame of frames) {
      pf.servedServiceTier = frame.service_tier ?? pf.servedServiceTier;
      const u = frame.usageMetadata ?? frame.usage;
      if (frame.usageMetadata) { googleUsage = true; googleResponseTokens = finite(u.candidatesTokenCount) ?? googleResponseTokens; }
      if (!u) continue;
      entry.inputTokens = finite(u.promptTokenCount ?? u.prompt_tokens) ?? entry.inputTokens;
      entry.outputTokens = frame.usageMetadata ? (finite(u.candidatesTokenCount) !== null || finite(u.thoughtsTokenCount) !== null ? (finite(u.candidatesTokenCount) ?? 0) + (finite(u.thoughtsTokenCount) ?? 0) : entry.outputTokens) : finite(u.completion_tokens) ?? entry.outputTokens;
      entry.reasoningTokens = finite(u.thoughtsTokenCount ?? u.completion_tokens_details?.reasoning_tokens) ?? entry.reasoningTokens;
      pf.actualCost = finite(u.cost) ?? pf.actualCost;
      pf.servedServiceTier = frame.service_tier ?? pf.servedServiceTier;
    }
    pf.responseTokens = googleUsage ? googleResponseTokens : pf.kind === 'google' && pf.recovered ? finite(pf.recoveredResponseTokens) : finite(entry.outputTokens) === null ? null : Math.max(0, entry.outputTokens - (entry.reasoningTokens ?? 0));
    pf.inputSource = finite(entry.inputTokens) === null ? 'unavailable' : 'provider';
    pf.savedTokens = entry.success && pf.comparable && finite(entry.inputTokens) !== null ? pf.baselineTokens - entry.inputTokens : null;
    pf.savedUsd = pf.savedTokens !== null && finite(pf.inputPrice) !== null ? pf.savedTokens * pf.inputPrice / 1e6 : null;
    if (saveBodies) {
      entry.requestBody = sanitizeBody(entry.requestBody);
      entry.responseBody = sanitizeBody(entry.responseBody);
    } else {
      delete entry.requestBody; delete entry.responseBody; delete entry.requestHeaders; delete pf.pdfContent;
    }
    status({ presetId: pf.presetId, generationId: pf.generationId, phase: entry.aborted ? '중단' : entry.success ? '완료' : '실패', pages: pf.pages, bytes: pf.bytes, baselineTokens: pf.baselineTokens, savedTokens: pf.savedTokens, inputTokens: entry.inputTokens });
  }
  return entries;
}
export function finite(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }

export async function api(path, init = {}) {
  const headers = await host.authHeaders();
  const response = await fetch('/api/request-logs/pagefold' + path, { ...init, headers: { ...headers, 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) throw Error(response.status === 404 ? '서버를 다시 시작하면 PDF 통계가 활성화됩니다.' : 'PDF 통계를 불러오지 못했습니다. (' + response.status + ')');
  return response.json();
}

// Operate on parsed display text only. Provider echoes and signature-bearing raw responses stay untouched.
export function responseRestorer(prepared) {
  if (!prepared.__pageFold || prepared.__pageFold.structuredOutput) return { push: text => text, flush: () => '' };
  return createStreamingNewlineRestorer();
}
export function restoreParsed(prepared, parsed) {
  if (!prepared.__pageFold || prepared.__pageFold.structuredOutput) return parsed;
  return { ...parsed, text: restoreResponseNewlines(parsed.text) };
}
