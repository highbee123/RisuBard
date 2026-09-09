'use strict';
const { maskSensitive } = require('./logs.cjs');
const MAX_TEXT = 2 * 1024 * 1024;
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function clean(value) {
  if (typeof value === 'string') return maskSensitive(value).slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.slice(0, 1000).map(clean);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (/^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|service[-_]?account)$/i.test(key)) out[key] = '[Credentials redacted]';
    else out[key] = clean(v);
  }
  return out;
}
function normalize(pf) {
  if (!pf || pf.version !== 1 || typeof pf.presetId !== 'string') return null;
  const out = { version: 1 };
  for (const key of ['generationId','requestId','presetId','presetName','modelId','packagingMode','baselineSource','inputSource','priceSource','servedServiceTier','requestedServiceTier','reasoningEffort','currency','kind']) if (typeof pf[key] === 'string') out[key] = pf[key].slice(0, 256);
  for (const key of ['fontSize','pages','bytes','sourceCharacters','baselineTokens','inputPrice','savedTokens','savedUsd','actualCost','responseTokens','priceTimestamp','thinkingBudget']) out[key] = num(pf[key]);
  out.cacheHit = pf.cacheHit === true;
  out.comparable = pf.comparable === true;
  out.structuredOutput = pf.structuredOutput === true;
  if (typeof pf.pdfContent === 'string') out.pdfContent = maskSensitive(pf.pdfContent).slice(0, MAX_TEXT);
  return out;
}
function summary(rows) {
  const total = { requests: rows.length, successes: 0, pages: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, baselineTokens: 0, savedTokens: 0, savedUsd: 0, comparableRequests: 0, pricedRequests: 0, inputKnown: 0, outputKnown: 0, reasoningKnown: 0, cacheHits: 0 };
  for (const row of rows) {
    const pf = row.pageFold;
    total.successes += row.success ? 1 : 0;
    total.pages += pf.pages ?? 0;
    total.cacheHits += pf.cacheHit ? 1 : 0;
    total.inputKnown += num(row.inputTokens) !== null ? 1 : 0;
    total.outputKnown += num(row.outputTokens) !== null ? 1 : 0;
    total.reasoningKnown += num(row.reasoningTokens) !== null ? 1 : 0;
    total.inputTokens += row.inputTokens ?? 0;
    total.outputTokens += row.outputTokens ?? 0;
    total.reasoningTokens += row.reasoningTokens ?? 0;
    if (row.success && pf.savedTokens != null && pf.comparable) {
      total.comparableRequests++; total.baselineTokens += pf.baselineTokens ?? 0; total.savedTokens += pf.savedTokens;
      if (pf.savedUsd != null) { total.pricedRequests++; total.savedUsd += pf.savedUsd; }
    }
  }
  total.userRequests = new Set(rows.map(r => r.generationId || r.pageFold.generationId || r.pageFold.requestId || r.id)).size;
  total.failedInputTokens = rows.filter(r => !r.success).reduce((n,r) => n + (r.inputTokens ?? 0),0);
  return total;
}
function register(app, { guard, sessionGuard, getRequests, getUsage, replace }) {
  const matches = (r, q) => r.pageFold && (!q.preset || r.pageFold.presetId === q.preset) && (!q.model || r.model === q.model) && (!Number(q.since) || r.timestamp >= Number(q.since));
  app.get('/api/request-logs/pagefold', async (req, res, next) => {
    if (!await guard(req, res)) return;
    try {
      const all = getUsage().filter(r => r.pageFold);
      const usage = all.filter(r => matches(r, req.query));
      if (req.query.export === '1') return res.json({ format: 'risubard-pagefold-logs', version: 1, exportedAt: new Date().toISOString(), logs: clean(getRequests().filter(r => r.pageFold)) });
      const groups = new Map();
      for (const r of usage) { const key = JSON.stringify([r.model, r.provider]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
      const rows = usage.filter(r => !Number(req.query.before) || r.id < Number(req.query.before)).sort((a,b) => b.id-a.id).slice(0, 50).map(r => { const out = { ...r, pageFold: { ...r.pageFold } }; delete out.pageFold.pdfContent; delete out.requestBody; delete out.responseBody; delete out.requestHeaders; return out; });
      const { dayKey } = require('./request-logs.cjs');
      const days = new Map(); for (const row of usage) { const key = dayKey(row.timestamp); if (!days.has(key)) days.set(key, []); days.get(key).push(row); }
      const filters = { presets: [...new Map(all.map(r => [r.pageFold.presetId, { id: r.pageFold.presetId, name: r.pageFold.presetName || r.pageFold.presetId }])).values()], models: [...new Set(all.map(r => r.model).filter(Boolean))] };
      res.json({ success: true, filters, daily: [...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,rs])=>({day,...summary(rs)})), total: summary(usage), byModel: [...groups.values()].map(rs => ({ model: rs[0].model, provider: rs[0].provider, ...summary(rs) })), rows, nextBefore: rows.length === 50 ? rows.at(-1).id : null });
    } catch(e) { next(e); }
  });
  app.get('/api/request-logs/pagefold/:id', async (req, res, next) => {
    if (!await guard(req, res)) return;
    try { const row = getRequests().find(r => r.id === Number(req.params.id) && r.pageFold) ?? getUsage().find(r => r.id === Number(req.params.id) && r.pageFold); if (!row) return res.status(404).json({ error: 'not found' }); res.json({ success: true, content: clean(row) }); } catch(e) { next(e); }
  });
  app.delete('/api/request-logs/pagefold', async (req, res, next) => {
    if (!await guard(req, res) || !sessionGuard(req, res)) return;
    try { replace(getRequests().filter(r => !r.pageFold), getUsage().filter(r => !r.pageFold)); res.json({ success: true }); } catch(e) { next(e); }
  });
}
module.exports = { normalize, summary, register, clean };
