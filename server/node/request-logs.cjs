'use strict';

const fs = require('fs');
const pageFoldLogs = require('./pagefold-logs.cjs');
const path = require('path');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson } = require('./file-store.cjs');
const { maskSensitive } = require('./logs.cjs');

const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MIN_ROWS = 50;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BATCH_SIZE = 50;
const ROTATE_EVERY_N_ROWS = 20;
const CATEGORIES = ['llm', 'tts', 'image', 'translate', 'embedding', 'other'];
const ROUTES = ['direct', 'proxy', 'job'];
const SOURCES = ['main', 'translate', 'memory', 'emotion', 'sub', 'wiki-admin', 'preview', 'test', 'tts', 'image', 'plugin', 'other'];
const PURPOSES = [
    'chat-response',
    'bardwiki-analysis',
    'bardwiki-canonical-update',
    'bardwiki-admin',
    'persona-builder',
    'bard-lore-analysis',
];
const INJECTION_KINDS = new Set(['systemPrompt', 'jailbreak', 'globalNote', 'authorNote', 'character', 'persona', 'lorebook', 'wiki', 'memory', 'exampleDialogue', 'chatHistory', 'instruction', 'tool', 'other']);

function truncateBody(value, maxBytes) {
    if (typeof value !== 'string') return { text: value, truncated: false };
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
    const half = Math.floor(maxBytes / 2);
    const buf = Buffer.from(value, 'utf8');
    const omitted = Math.round((buf.length - maxBytes) / 1024);
    return { text: `${buf.subarray(0, half).toString('utf8')}\n\n...[${omitted} KB omitted]...\n\n${buf.subarray(buf.length - half).toString('utf8')}`, truncated: true };
}

function truncateTail(value, maxBytes) {
    if (typeof value !== 'string') return { text: value, truncated: false };
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
    return { text: Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8') + '...[truncated]', truncated: true };
}

function toInt(value) { return Number.isFinite(value) ? Math.round(value) : null; }
function toNonNegInt(value) { const n = toInt(value); return n != null && n >= 0 ? n : 0; }
function str(value, max) { if (value == null) return null; const s = String(value); return max ? s.slice(0, max) : s; }

function normalizeInjectionManifest(value) {
    let raw = value;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
    const items = raw.items.slice(0, 256).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        return [{ kind: INJECTION_KINDS.has(item.kind) ? item.kind : 'other', ...(item.name != null ? { name: str(item.name, 256) } : {}), tokens: toNonNegInt(item.tokens) }];
    });
    return { totalTokens: toNonNegInt(raw.totalTokens), items, ...(raw.estimated ? { estimated: true } : {}) };
}

function dayKey(timestamp) {
    const d = new Date(timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeEntry(entry) {
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    const headers = entry.requestHeaders != null ? truncateTail(maskSensitive(String(entry.requestHeaders)), MAX_HEADER_BYTES) : { text: null, truncated: false };
    const body = entry.requestBody != null ? truncateBody(maskSensitive(String(entry.requestBody)), MAX_BODY_BYTES) : { text: null, truncated: false };
    const response = entry.responseBody != null ? truncateTail(maskSensitive(String(entry.responseBody)), MAX_BODY_BYTES) : { text: null, truncated: false };
    const pageFold = pageFoldLogs.normalize(entry.pageFold);
    const injectionManifest = normalizeInjectionManifest(entry.injectionManifest);
    const pageFoldBytes = pageFold ? Buffer.byteLength(JSON.stringify(pageFold), 'utf8') : 0;
    const sizeBytes = pageFoldBytes + Buffer.byteLength(headers.text ?? '', 'utf8') + Buffer.byteLength(body.text ?? '', 'utf8') + Buffer.byteLength(response.text ?? '', 'utf8') + Buffer.byteLength(injectionManifest ? JSON.stringify(injectionManifest) : '', 'utf8');
    return {
        ...(pageFold ? { pageFold } : {}),
        timestamp, category: CATEGORIES.includes(entry.category) ? entry.category : 'other', source: SOURCES.includes(entry.source) ? entry.source : 'other', purpose: PURPOSES.includes(entry.purpose) ? entry.purpose : null,
        chatId: str(entry.chatId, 128), sessionChatId: str(entry.sessionChatId, 128), generationId: str(entry.generationId, 128), model: str(entry.model, 128), provider: str(entry.provider, 64),
        url: str(maskSensitive(entry.url ?? ''), 2048) ?? '', method: str(entry.method, 16), status: toInt(entry.status), success: !!entry.success, aborted: !!entry.aborted,
        route: ROUTES.includes(entry.route) ? entry.route : null, streaming: !!entry.streaming, durationMs: toInt(entry.durationMs), firstTokenMs: toInt(entry.firstTokenMs),
        inputTokens: toInt(entry.inputTokens), outputTokens: toInt(entry.outputTokens), cachedTokens: toInt(entry.cachedTokens), reasoningTokens: toInt(entry.reasoningTokens),
        injectionManifest, requestHeaders: headers.text, requestBody: body.text, responseBody: response.text, responseType: str(entry.responseType, 32),
        errorMessage: entry.errorMessage != null ? maskSensitive(String(entry.errorMessage)).slice(0, 2000) : null,
        truncated: headers.truncated || body.truncated || response.truncated, sizeBytes, clientId: str(entry.clientId, 64),
    };
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${file}:${index + 1}`); }
    });
}

function appendJsonl(file, rows) {
    if (!rows.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, rows.map(row => JSON.stringify(row)).join('\n') + '\n', null, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
}

function summarize(rows) {
    const durationRows = rows.filter(row => row.durationMs != null);
    return {
        requests: rows.length, failed: rows.filter(row => !row.success).length,
        inputTokens: rows.reduce((n, row) => n + toNonNegInt(row.inputTokens), 0), outputTokens: rows.reduce((n, row) => n + toNonNegInt(row.outputTokens), 0),
        cachedTokens: rows.reduce((n, row) => n + toNonNegInt(row.cachedTokens), 0), reasoningTokens: rows.reduce((n, row) => n + toNonNegInt(row.reasoningTokens), 0),
        avgDurationMs: durationRows.length ? Math.round(durationRows.reduce((n, row) => n + row.durationMs, 0) / durationRows.length) : null,
    };
}

const parseCsv = value => typeof value === 'string' && value.length ? value.split(',').filter(Boolean) : undefined;
const parseNum = value => value ? Number(value) : undefined;

function createRequestLogs(opts = {}) {
    const saveDir = opts.saveDir || path.join(process.cwd(), 'save');
    const root = path.join(saveDir, 'request-logs');
    const requestsFile = path.join(root, 'requests.jsonl');
    const usageFile = path.join(root, 'usage.jsonl');
    const stateFile = path.join(root, 'state.json');
    const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
    const minRows = opts.minRows ?? MIN_ROWS;
    const rotateEvery = opts.rotateEveryNRows ?? ROTATE_EVERY_N_ROWS;
    fs.mkdirSync(root, { recursive: true });
    let requests = null;
    let usage = null;
    let state = fs.existsSync(stateFile) ? readVerifiedJson(root, 'state.json') : { schemaVersion: 1, nextId: 1 };
    let insertedSinceRotate = 0;
    const getRequests = () => requests ??= readJsonl(requestsFile);
    const getUsage = () => usage ??= readJsonl(usageFile);
    const saveState = () => atomicWriteJson(root, 'state.json', state);
    const rewrite = (relative, rows) => atomicWriteFile(root, relative, Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8'));

    function rotateNow() {
        insertedSinceRotate = 0;
        const rows = getRequests();
        let bytes = 0; let keepFrom = rows.length;
        for (let index = rows.length - 1; index >= 0; index--) {
            bytes += rows[index].sizeBytes || 0;
            const count = rows.length - index;
            if (bytes <= maxTotalBytes || count <= minRows) keepFrom = index; else break;
        }
        if (keepFrom > 0) { requests = rows.slice(keepFrom); rewrite('requests.jsonl', requests); }
    }

    function addRequestLogBatch(entries) {
        if (!Array.isArray(entries) || !entries.length) return 0;
        const seenPdfIds = new Set(getUsage().filter(r => r.pageFold?.requestId).map(r => r.pageFold.requestId));
        entries = entries.filter(e => { if (!e?.pageFold?.requestId) return true; if (seenPdfIds.has(e.pageFold.requestId)) return false; seenPdfIds.add(e.pageFold.requestId); return true; });
        const rows = entries.slice(-MAX_BATCH_SIZE).filter(entry => entry && typeof entry === 'object' && typeof entry.url === 'string').map(entry => ({ id: state.nextId++, ...normalizeEntry(entry) }));
        if (!rows.length) return 0;
        const requestCache = getRequests();
        const usageRows = rows.filter(row => row.category === 'llm').map(row => {
            if (!row.pageFold) return row;
            const copy = { ...row, pageFold: { ...row.pageFold } };
            delete copy.pageFold.pdfContent; delete copy.requestBody; delete copy.responseBody; delete copy.requestHeaders;
            return copy;
        });
        const usageCache = getUsage();
        appendJsonl(requestsFile, rows); requestCache.push(...rows);
        appendJsonl(usageFile, usageRows); usageCache.push(...usageRows);
        saveState(); insertedSinceRotate += rows.length;
        if (insertedSinceRotate >= rotateEvery) rotateNow();
        return rows.length;
    }

    function matches(row, query = {}) {
        if (query.categories?.length && !query.categories.includes(row.category)) return false;
        if (query.sources?.length && !query.sources.includes(row.source)) return false;
        if (query.models?.length && !query.models.includes(row.model)) return false;
        if (query.chatId && row.chatId !== String(query.chatId)) return false;
        if (query.sessionChatId && row.sessionChatId !== String(query.sessionChatId)) return false;
        if (query.successOnly && !row.success) return false;
        if (query.failedOnly && row.success) return false;
        if (typeof query.since === 'number' && row.timestamp < query.since) return false;
        if (typeof query.until === 'number' && row.timestamp > query.until) return false;
        return true;
    }

    function queryRequestLogs(query = {}) {
        const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
        return getRequests().filter(row => matches(row, query) && !(typeof query.beforeId === 'number' && row.id >= query.beforeId)).slice().sort((a, b) => b.id - a.id).slice(0, limit).map(row => {
            const result = { ...row };
            if (!query.withBodies) { delete result.requestHeaders; delete result.requestBody; delete result.responseBody; }
            return result;
        });
    }

    const countRequestLogs = (query = {}) => getRequests().filter(row => matches(row, query)).length;
    const getRequestLog = id => getRequests().find(row => row.id === id) || null;
    function clearRequestLogs() { requests = []; rewrite('requests.jsonl', []); insertedSinceRotate = 0; }

    function queryUsage(query = {}) {
        const rows = getUsage().filter(row => matches(row, query));
        const group = (keyFn, decorate) => {
            const groups = new Map();
            for (const row of rows) { const key = keyFn(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
            return [...groups.entries()].map(([key, values]) => ({ ...decorate(key, values[0]), ...summarize(values) }));
        };
        const daily = group(row => dayKey(row.timestamp), day => ({ day })).sort((a, b) => a.day.localeCompare(b.day));
        const byModel = group(row => `${row.model ?? ''}\u0000${row.provider ?? ''}`, (_key, row) => ({ model: row.model, provider: row.provider })).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
        const bySource = group(row => row.source, source => ({ source })).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
        return { total: summarize(rows), daily, byModel, bySource };
    }

    function usageDimensions() {
        const rows = getUsage(); const distinct = key => [...new Set(rows.map(row => row[key]).filter(value => value != null))].sort();
        return { models: distinct('model'), categories: distinct('category'), sources: distinct('source') };
    }
    function clearUsage() { usage = []; rewrite('usage.jsonl', []); }
    function storageStats() { const rows = getRequests(); return { requestCount: rows.length, requestBytes: rows.reduce((n, row) => n + (row.sizeBytes || 0), 0), usageCount: getUsage().length, maxTotalBytes }; }

    function registerRoutes(app, { auth, activeSession } = {}) {
        const guard = auth ?? (async () => true); const sessionGuard = activeSession ?? (() => true);
        pageFoldLogs.register(app, { guard, sessionGuard, getRequests, getUsage, replace: (nextRequests, nextUsage) => { requests = nextRequests; usage = nextUsage; rewrite('requests.jsonl', requests); rewrite('usage.jsonl', usage); } });
        app.post('/api/request-logs', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, written: addRequestLogBatch(Array.isArray(req.body) ? req.body : [req.body]) }); } catch (error) { next(error); } });
        app.get('/api/request-logs', async (req, res, next) => { if (!await guard(req, res)) return; try { const filter = { categories: parseCsv(req.query.categories), sources: parseCsv(req.query.sources), chatId: req.query.chat_id, sessionChatId: req.query.session_chat_id, successOnly: req.query.success === '1', failedOnly: req.query.failed === '1', since: parseNum(req.query.since), until: parseNum(req.query.until) }; res.send({ success: true, content: queryRequestLogs({ ...filter, beforeId: parseNum(req.query.before_id), limit: parseNum(req.query.limit), withBodies: req.query.bodies === '1' }), total: countRequestLogs(filter) }); } catch (error) { next(error); } });
        app.get('/api/request-logs/usage', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, ...queryUsage({ categories: parseCsv(req.query.categories), sources: parseCsv(req.query.sources), models: parseCsv(req.query.models), since: parseNum(req.query.since), until: parseNum(req.query.until), successOnly: req.query.success === '1' }), dimensions: usageDimensions() }); } catch (error) { next(error); } });
        app.get('/api/request-logs/stats', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, ...storageStats() }); } catch (error) { next(error); } });
        app.get('/api/request-logs/:id', async (req, res, next) => { if (!await guard(req, res)) return; try { const entry = getRequestLog(Number(req.params.id)); if (!entry) return res.status(404).send({ error: 'not found' }); res.send({ success: true, content: entry }); } catch (error) { next(error); } });
        app.delete('/api/request-logs', async (req, res, next) => { if (!await guard(req, res) || !sessionGuard(req, res)) return; try { clearRequestLogs(); if (req.query.usage === '1') clearUsage(); res.send({ success: true }); } catch (error) { next(error); } });
    }

    try { rotateNow(); } catch {}
    return { addRequestLogBatch, queryRequestLogs, countRequestLogs, getRequestLog, clearRequestLogs, queryUsage, usageDimensions, clearUsage, storageStats, rotateNow, registerRoutes, close: () => {} };
}

module.exports = { createRequestLogs, CATEGORIES, SOURCES, ROUTES, MAX_BODY_BYTES, MAX_TOTAL_BYTES, MIN_ROWS, truncateBody, truncateTail, dayKey };
