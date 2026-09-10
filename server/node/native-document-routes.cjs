'use strict';

// Native requests are document operations, never binary-database adapters.
function registerNativeDocumentRoutes(app, { getStore, auth, activeSession, queue, ensureReady, onCommit, readSummaries }) {
    function route(write, action) {
        return async (req, res, next) => {
            if (!await auth(req, res)) return;
            if (write && !activeSession(req, res)) return;
            try {
                const result = await queue(async () => {
                    await ensureReady();
                    return action(getStore(), req);
                });
                res.setHeader('Cache-Control', 'no-store');
                res.json(result);
            } catch (error) {
                if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
                    return res.status(error.statusCode).json({ error: error.message, code: error.code,
                        target: error.target, currentRevision: error.currentRevision });
                }
                next(error);
            }
        };
    }
    const badInput = message => Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_NATIVE_REQUEST' });
    app.get('/api/native/catalog', route(false, store => store.catalog()));
    app.post('/api/native/summaries', route(false, (store, req) => {
        if (!Array.isArray(req.body?.targets) || req.body.targets.length > 100) throw badInput('At most 100 summary targets are allowed');
        return readSummaries(store.catalog().value, req.body.targets);
    }));
    app.get('/api/native/document', route(false, (store, req) => {
        const { kind, id, parentId, metadataOnly } = req.query;
        if (typeof kind !== 'string' || typeof id !== 'string' || (parentId !== undefined && typeof parentId !== 'string')) throw badInput('Document target required');
        return store.read({ kind, id, ...(parentId ? { parentId } : {}) }, { metadataOnly: metadataOnly === '1' });
    }));
    app.post('/api/native/documents', route(false, (store, req) => {
        if (!Array.isArray(req.body?.targets) || req.body.targets.length > 100) throw badInput('At most 100 document targets are allowed');
        return { documents: req.body.targets.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw badInput('Document target required');
            return store.read(item.target || item, { metadataOnly: item.metadataOnly === true });
        }) };
    }));
    app.post('/api/native/commit', route(true, async (store, req) => {
        if (!req.body || !Array.isArray(req.body.writes) || req.body.writes.length > 1000) throw badInput('A bounded document write list is required');
        const result = store.commit(req.body);
        await onCommit(result);
        return result;
    }));
}

module.exports = { registerNativeDocumentRoutes };
