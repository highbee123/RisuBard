'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, checksumFile, fsyncDirectory } = require('./file-store.cjs');
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
    const injectionManifest = normalizeInjectionManifest(entry.injectionManifest);
    const sizeBytes = Buffer.byteLength(headers.text ?? '', 'utf8') + Buffer.byteLength(body.text ?? '', 'utf8') + Buffer.byteLength(response.text ?? '', 'utf8') + Buffer.byteLength(injectionManifest ? JSON.stringify(injectionManifest) : '', 'utf8');
    return {
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

// Retain at most one line, including UTF-8 characters split across read chunks.
function* jsonlLines(file) {
    if (!fs.existsSync(file)) return;
    const fd = fs.openSync(file, 'r');
    let parts = []; let length = 0; let offset = 0; let number = 0;
    try {
        for (;;) {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!bytes) break;
            let start = 0;
            for (let index = 0; index < bytes; index++) {
                if (buffer[index] !== 10) continue;
                const part = buffer.subarray(start, index);
                const line = parts.length ? Buffer.concat([...parts, part], length + part.length) : part;
                const end = offset + length + part.length + 1;
                yield { text: line.toString('utf8'), offset, end, number: ++number };
                offset = end; parts = []; length = 0; start = index + 1;
            }
            if (start < bytes) { parts.push(buffer.subarray(start, bytes)); length += bytes - start; }
        }
        if (length) yield { text: Buffer.concat(parts, length).toString('utf8'), offset, end: offset + length, number: ++number };
    } finally { fs.closeSync(fd); }
}

function* readJsonl(file) {
    for (const line of jsonlLines(file)) {
        if (!line.text.trim()) continue;
        try { yield JSON.parse(line.text); } catch { throw new Error(`Invalid JSONL at ${file}:${line.number}`); }
    }
}

function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

// Stream to a synced sibling, then publish atomically. Never truncate the original
// if parsing, writing or validation fails. Keep the same one-backup convention.
function rewriteJsonl(file, lines) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const backup = `${file}.${randomUUID()}.bak.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        const hash = createHash('sha256');
        try {
            for (const line of lines) {
                const bytes = Buffer.from(line + '\n', 'utf8');
                writeAll(fd, bytes); hash.update(bytes);
            }
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        const digest = hash.digest('hex');
        if (checksumFile(temp) !== digest) throw new Error('Request log rewrite checksum verification failed');
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
            const backupFd = fs.openSync(backup, 'r+');
            try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
            fs.renameSync(backup, `${file}.bak`);
        }
        fs.renameSync(temp, file);
        atomicWriteFile(path.dirname(file), path.basename(file) + '.sha256', `${digest}\n`);
        fsyncDirectory(path.dirname(file));
    } finally {
        for (const staged of [temp, backup]) if (fs.existsSync(staged)) fs.unlinkSync(staged);
    }
}

function appendJsonl(file, rows) {
    if (!rows.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a+', 0o600);
    try {
        const size = fs.fstatSync(fd).size;
        if (size) {
            const last = Buffer.alloc(1);
            fs.readSync(fd, last, 0, 1, size - 1);
            if (last[0] !== 10) writeAll(fd, Buffer.from('\n'));
        }
        for (const row of rows) writeAll(fd, Buffer.from(JSON.stringify(row) + '\n', 'utf8'));
        fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
}

const USAGE_FIELDS = ['id', 'timestamp', 'category', 'source', 'purpose', 'chatId', 'sessionChatId', 'generationId', 'model', 'provider', 'success', 'durationMs', 'inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'];
const usageRow = row => Object.fromEntries(USAGE_FIELDS.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const emptySummary = () => ({ requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, durationSum: 0, durationCount: 0 });
function addToSummary(summary, row) {
    summary.requests++; if (!row.success) summary.failed++;
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) summary[key] += toNonNegInt(row[key]);
    if (row.durationMs != null) { summary.durationSum += row.durationMs; summary.durationCount++; }
}
const finishSummary = ({ durationSum, durationCount, ...summary }) => ({ ...summary, avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : null });

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
    let state = fs.existsSync(stateFile) ? readVerifiedJson(root, 'state.json') : { schemaVersion: 1, nextId: 1 };
    let insertedSinceRotate = 0;
    const saveState = () => atomicWriteJson(root, 'state.json', state);

    if (state.usageSchemaVersion !== 1) {
        try {
            if (fs.existsSync(usageFile)) rewriteJsonl(usageFile, (function* () {
                for (const row of readJsonl(usageFile)) yield JSON.stringify(usageRow(row));
            })());
            state.usageSchemaVersion = 1;
            saveState();
        } catch (error) {
            delete state.usageSchemaVersion;
            console.warn('[request-logs] Usage log compaction failed', error);
        }
    }

    function rotateNow() {
        insertedSinceRotate = 0;
        if (!fs.existsSync(requestsFile)) return;
        const size = fs.statSync(requestsFile).size;
        if (size <= maxTotalBytes) return;
        let budgetStart = size; let count = 0;
        const recentOffsets = [];
        for (const line of jsonlLines(requestsFile)) {
            if (!line.text.trim()) continue;
            if (size - line.offset <= maxTotalBytes) budgetStart = Math.min(budgetStart, line.offset);
            if (minRows > 0) recentOffsets[count % minRows] = line.offset;
            count++;
        }
        const minimumStart = recentOffsets.length ? recentOffsets[count % recentOffsets.length] : size;
        const keepFrom = Math.min(budgetStart, minimumStart);
        if (keepFrom > 0) rewriteJsonl(requestsFile, (function* () {
            for (const line of jsonlLines(requestsFile)) if (line.offset >= keepFrom && line.text.trim()) yield line.text;
        })());
    }

    function addRequestLogBatch(entries) {
        if (!Array.isArray(entries) || !entries.length) return 0;
        const rows = entries.slice(-MAX_BATCH_SIZE).filter(entry => entry && typeof entry === 'object' && typeof entry.url === 'string').map(entry => ({ id: state.nextId++, ...normalizeEntry(entry) }));
        if (!rows.length) return 0;
        const usageRows = rows.filter(row => row.category === 'llm').map(usageRow);
        appendJsonl(requestsFile, rows);
        appendJsonl(usageFile, usageRows);
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
        const rows = [];
        for (const row of readJsonl(requestsFile)) {
            if (!matches(row, query) || (typeof query.beforeId === 'number' && row.id >= query.beforeId)) continue;
            if (rows.length === limit && row.id <= rows[rows.length - 1].id) continue;
            if (!query.withBodies) { delete row.requestHeaders; delete row.requestBody; delete row.responseBody; }
            rows.push(row); rows.sort((a, b) => b.id - a.id);
            if (rows.length > limit) rows.pop();
        }
        return rows;
    }

    function countRequestLogs(query = {}) { let count = 0; for (const row of readJsonl(requestsFile)) if (matches(row, query)) count++; return count; }
    function getRequestLog(id) { for (const row of readJsonl(requestsFile)) if (row.id === id) return row; return null; }
    function clearRequestLogs() { rewriteJsonl(requestsFile, []); insertedSinceRotate = 0; }

    function queryUsage(query = {}) {
        const total = emptySummary(); const daily = new Map(); const byModel = new Map(); const bySource = new Map();
        const addGroup = (groups, key, fields, row) => {
            if (!groups.has(key)) groups.set(key, { ...fields, ...emptySummary() });
            addToSummary(groups.get(key), row);
        };
        for (const row of readJsonl(usageFile)) {
            if (!matches(row, query)) continue;
            addToSummary(total, row);
            const day = dayKey(row.timestamp);
            addGroup(daily, day, { day }, row);
            addGroup(byModel, `${row.model ?? ''}\u0000${row.provider ?? ''}`, { model: row.model, provider: row.provider }, row);
            addGroup(bySource, row.source, { source: row.source }, row);
        }
        const tokenOrder = (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
        return { total: finishSummary(total), daily: [...daily.values()].map(finishSummary).sort((a, b) => a.day.localeCompare(b.day)), byModel: [...byModel.values()].map(finishSummary).sort(tokenOrder), bySource: [...bySource.values()].map(finishSummary).sort(tokenOrder) };
    }

    function usageDimensions() {
        const models = new Set(); const categories = new Set(); const sources = new Set();
        for (const row of readJsonl(usageFile)) {
            if (row.model != null) models.add(row.model);
            if (row.category != null) categories.add(row.category);
            if (row.source != null) sources.add(row.source);
        }
        return { models: [...models].sort(), categories: [...categories].sort(), sources: [...sources].sort() };
    }
    function clearUsage() { rewriteJsonl(usageFile, []); }
    function storageStats() {
        let requestCount = 0; let requestBytes = 0; let usageCount = 0;
        for (const row of readJsonl(requestsFile)) { requestCount++; requestBytes += row.sizeBytes || 0; }
        for (const row of readJsonl(usageFile)) usageCount++;
        return { requestCount, requestBytes, usageCount, maxTotalBytes };
    }

    function registerRoutes(app, { auth, activeSession } = {}) {
        const guard = auth ?? (async () => true); const sessionGuard = activeSession ?? (() => true);
        app.post('/api/request-logs', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, written: addRequestLogBatch(Array.isArray(req.body) ? req.body : [req.body]) }); } catch (error) { next(error); } });
        app.get('/api/request-logs', async (req, res, next) => { if (!await guard(req, res)) return; try { const filter = { categories: parseCsv(req.query.categories), sources: parseCsv(req.query.sources), chatId: req.query.chat_id, sessionChatId: req.query.session_chat_id, successOnly: req.query.success === '1', failedOnly: req.query.failed === '1', since: parseNum(req.query.since), until: parseNum(req.query.until) }; res.send({ success: true, content: queryRequestLogs({ ...filter, beforeId: parseNum(req.query.before_id), limit: parseNum(req.query.limit), withBodies: req.query.bodies === '1' }), total: countRequestLogs(filter) }); } catch (error) { next(error); } });
        app.get('/api/request-logs/usage', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, ...queryUsage({ categories: parseCsv(req.query.categories), sources: parseCsv(req.query.sources), models: parseCsv(req.query.models), since: parseNum(req.query.since), until: parseNum(req.query.until), successOnly: req.query.success === '1' }), dimensions: usageDimensions() }); } catch (error) { next(error); } });
        app.get('/api/request-logs/stats', async (req, res, next) => { if (!await guard(req, res)) return; try { res.send({ success: true, ...storageStats() }); } catch (error) { next(error); } });
        app.get('/api/request-logs/:id', async (req, res, next) => { if (!await guard(req, res)) return; try { const entry = getRequestLog(Number(req.params.id)); if (!entry) return res.status(404).send({ error: 'not found' }); res.send({ success: true, content: entry }); } catch (error) { next(error); } });
        app.delete('/api/request-logs', async (req, res, next) => { if (!await guard(req, res) || !sessionGuard(req, res)) return; try { clearRequestLogs(); if (req.query.usage === '1') clearUsage(); res.send({ success: true }); } catch (error) { next(error); } });
    }

    try { rotateNow(); } catch (error) { console.warn('[request-logs] Startup rotation failed', error); }
    return { addRequestLogBatch, queryRequestLogs, countRequestLogs, getRequestLog, clearRequestLogs, queryUsage, usageDimensions, clearUsage, storageStats, rotateNow, registerRoutes, close: () => {} };
}

module.exports = { createRequestLogs, CATEGORIES, SOURCES, ROUTES, MAX_BODY_BYTES, MAX_TOTAL_BYTES, MIN_ROWS, truncateBody, truncateTail, dayKey };
