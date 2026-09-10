# Native Document Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Current public checkout only; no worktree, commits, private changes or original-save writes.

**Goal:** Make named disk files the runtime authority: read requested documents, persist changed documents without whole-database assembly, and reserve legacy `.bin` conversion for explicit compatibility operations.

**Architecture:** A native document repository exposes catalog/settings/entity/chat envelopes with per-target content revisions. A durable transaction accepts explicit writes/deletes/order changes; it never interprets an unloaded entity as deleted. The client owns a separate readiness/revision/acknowledged-baseline cache, uses native endpoints, and retains its reactive DB shape only as a UI cache. Legacy imports/exports remain boundary adapters.

**Tech Stack:** Existing Node CJS, file-store journal, named-entity codec, Svelte/TypeScript, Vitest; no new dependencies.

## Acceptance contracts

```ts
type Target = { kind: 'settings'|'character'|'chat'|'module'|'persona'|'prompt'|'lorebook', id: string, parentId?: string }
type Envelope = { target: Target, value: unknown, revision: string }
type Write = { target: Target, expectedRevision: string|null, value: unknown|null }
// value:null is explicit deletion; expectedRevision:null is creation only.
// Character metadata never embeds chat bodies; catalog carries ordered chat IDs.
// A metadata-only chat write preserves messages without reading sibling chats.
// Catalog revision is required for membership/order changes, not ordinary edits.
```

## Task 1 — Document repository and targeted assets

Create `server/node/native-document-store.cjs` and `server/node/native-document-store.test.ts`; reuse `named-entity-codec.cjs`, `file-store.cjs` and logical asset mappings. Keep full import/export methods outside normal operations.

- [x] Write failing tests for native target reads, same-target CAS rejection, unrelated-target independence and explicit deletion.
- [x] Implement catalog, settings, document reads and durable bounded commits. Preserve stable IDs, names, sibling numbering, drafts, unknown files and secret splitting. Validate all targets before a prepared journal; skip unchanged encoded bytes.
- [x] Write failing filesystem-instrumented tests proving a Markdown-only edit does not read/write unrelated entities, chat bodies, asset index or image files.
- [x] Resolve only changed/new asset references. Preserve existing owner-local paths; foreign ownership receives independent scoped keys and files. Never infer global asset GC from partial targets. Parse lookup metadata without stat/hash of every image.
- [x] Verify external Markdown/JSON edits, malformed files, same-size edits, interrupted transaction replay and rename safety.

Example regression contract:
```js
const a = store.read({kind:'character', id:'a'});
fs.writeFileSync(unrelatedChatPath, 'invalid unrelated data');
store.commit({writes:[{target:a.target, expectedRevision:a.revision, value:{...a.value, desc:'edited'}}]});
expect(fs.readFileSync(unrelatedChatPath,'utf8')).toBe('invalid unrelated data');
expect(fs.readFileSync(descriptionPath,'utf8')).toBe('edited');
```
Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.server.ts server/node/native-document-store.test.ts` (first expected missing API failure, then pass).

## Task 2 — Native HTTP lifecycle and legacy boundary

Create `server/node/native-document-routes.cjs`, `test/compat/native-document-runtime.test.ts`; modify `server/node/server.cjs` and `server/node/db.cjs` narrowly.

- [x] Test authenticated catalog/read/commit, durable ACK, conflict responses and native startup without `database.bin` or unrelated chat reads.
- [x] Register native routes with existing auth/session/write serialization. Native requests never initialize the full chat store, run global projection revision or encode a whole DB.
- [x] Route ordinary chat access through requested file documents. Prevent stale compatibility cache reads after native edits; synthesize legacy state only on explicit old API/export/snapshot operations. Do not recreate persistent monolithic cache on native reads/writes.
- [x] Verify existing full-backup import/export and native→legacy→native round trips preserve contents and deletion state.

HTTP proof:
```js
await client.fetch('/api/native/catalog');
const a = await (await client.fetch('/api/native/document?kind=character&id=a')).json();
const saved = await client.fetch('/api/native/commit', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({writes:[{target:a.target,expectedRevision:a.revision,value:{...a.value,desc:'edit'}}]})});
expect(saved.status).toBe(200);
expect(kvManifest.entries['database/database.bin']).toBeUndefined();
```
Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.compat.ts test/compat/native-document-runtime.test.ts`.

## Task 3 — Client native persistence and explicit hydration

Create `src/ts/storage/nativeDocuments.ts` and its unit tests; modify `nodeStorage.ts`, `bootstrap.ts`, `globalApi.svelte.ts`, and targeted selection/hydration boundaries in `characters.ts`, `chatStorage.ts`, module/persona/preset editors as required by verified callers.

- [x] Test document readiness separate from DB values, per-target acknowledged baselines, in-flight edits, explicit deletes, no removal from partial catalogs and same-target conflict preservation.
- [x] Replace normal `RisuSaveEncoder`/whole-DB patch/full-write fallback with document commits. Keep legacy encoder only for actual legacy compatibility actions.
- [x] Bootstrap complete ID/summary catalogs and settings, then hydrate needed selected/active documents before normalization or use. Prevent default-setting migrations from modifying unloaded summaries. Preserve all IDs for organizers/module bindings.
- [x] Await character, active module, persona/preset and selected-chat readiness at selection/edit/execution boundaries. Unloaded data must never be serialized as empty content; legacy bulk actions must explicitly request the documents they need.
- [x] External edits reload requested documents; conflicting local edits are retained and surfaced rather than silently overwritten by a full-DB reload.

Client regression:
```ts
const pending = cache.save(target);
cache.edit(target, {desc:'newer'});
await pending;
expect(cache.isDirty(target)).toBe(true);
expect(cache.value(target).desc).toBe('newer');
expect(networkCalls.some(call => call.url.includes('database.bin'))).toBe(false);
```
Run affected storage/bootstrap/selection unit suites with `node node_modules/vitest/vitest.mjs run <affected test files>`.

## Verification record — 2026-09-08/09

- Complete server suite: 48 files / 610 tests passed. Complete compatibility suite: 96 tests passed, 5 skipped. Test host logger and child servers used explicit isolated `RISUBARD_DATA_ROOT` paths.
- Final affected frontend run: 14 suites / 132 tests passed. Command: `node node_modules/vitest/vitest.mjs run src/ts/storage/nativeDocuments.test.ts src/ts/storage/nativeRuntime.test.ts src/ts/storage/nativeDocumentTracking.svelte.test.ts src/ts/storage/nativePluginTarget.test.ts src/ts/storage/nodeStorage.native.test.ts src/ts/storage/nodeStorage.bulkWrite.test.ts src/ts/storage/chatStorage.test.ts src/ts/bootstrapPerformance.test.ts src/ts/bootstrapErrorHandling.test.ts src/ts/process/modules.test.ts src/lib/Setting/Pages/Module/ModuleSettings.test.ts src/lib/Setting/Pages/Module/ModuleChatMenu.test.ts src/lib/SideBars/CharacterVaultDialog.test.ts src/ts/characterVault.test.ts`.
- Final `npm run build` passed (40.28 seconds); final Edge smoke passed after all production edits, with no uncaught page errors or failed local HTTP responses. Existing CSS/bundling warnings remain.
- Isolated existing-data verification: `migration-test-20260908-v2-final/native-runtime-verification.json`. Settings, character, module, persona, prompt and chat changes survived reads and were restored. External edits produced conflicts; two server restarts did not recreate the active monolithic cache. All 78,126 image files retained their paths, sizes, mtimes and link counts; the logical asset index was unchanged.
- Edge production-build smoke harness: `migration-test-20260908-v2-final/native-browser-smoke.cjs`. Uses a new disposable fixture, not original userdata. Fresh password setup, lazy bootstrap, character/chat display, UI-to-Markdown save, reload persistence and external Markdown reload passed. The unopened sibling description retained its exact bytes and mtime. External network requests are deliberately blocked.
- Browser testing caught duplicate first-login initialization; a single-flight authentication fix has a failing-before/passing-after regression.
- Client specification and independent data-safety rereviews approved after fixing hydration-time edits, discarded-refresh baselines, clone rollback, empty-chat membership tracking and stable plugin targets across selection/reordering.
- Focused rereviews also approved HTTP-safe ID generation and preventing stale-summary resurrection after external deletion. Explicit local delete-and-recreate, including child chat IDs, remains supported.
- Typecheck is not green: `node node_modules/typescript/bin/tsc --noEmit --pretty false` stops in the unchanged `src/ts/plugins/apiV3/risuai.d.ts` declaration file, beginning at `(1731,56)` with TS1131 and subsequent TS1005/TS1128 parsing errors. Production builds pass; they do not substitute for a successful typecheck.

## Task 4 — Review, isolated-data verification and documentation

- [x] Review specification compliance, then data-safety/code quality; fix and rerun failing regressions before completion.
- [x] Run affected server/client suites, complete compat suite and production build. Record remaining compatibility failures explicitly; do not weaken missing-data guards.
- [x] In `migration-test-20260908-v2-final/converted` only, preserve a pre-test record, test changed character text/chat/settings/module edits and reversion, external file edits, conflicts, restart and cache absence. Measure targeted save latency and image file invariance; never instantiate storage against original userdata.
- [x] Update `docs/ko/file-native-storage.md` and latest `patchnote/0.9.26.md`. Do not overwrite canonical wiki decisions without review.
- [x] Report exactly which runtime paths are native, any remaining full-state consumers, verification results and unresolved limits. Do not claim complete lazy loading if eager consumers remain.
