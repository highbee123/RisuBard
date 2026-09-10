# V2 Item Import Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace the legacy migration page with one backup surface and add a safe, atomic importer for selected entities from another RisuBard V2 data root.

**Architecture:** A server-side import service validates a read-only V2 source, previews selectable entities and dependencies, remaps colliding entity/chat/asset IDs, then sends one merged snapshot through the existing named-folder transaction writer. The System Backup page calls authenticated preview/import endpoints and reloads only after a successful commit.

**Tech Stack:** Node.js CommonJS server, Svelte 5, TypeScript, Vitest.

---

### Task 1: Lock the consolidated settings contract

**Files:**
- Modify: `src/lib/Setting/Pages/SystemBackup.test.ts`
- Modify: `src/lib/Setting/SettingsNavigation.test.ts`
- Modify: `src/lib/Setting/SettingsConsolidation.test.ts`
- Modify: `src/lib/Setting/Settings.svelte`
- Modify: `src/ts/setting/settingsNavigation.ts`
- Modify: `src/ts/setting/searchManifestData.ts`

**Step 1: Write the failing tests**

Assert that the migration page is absent from navigation/rendering/search, and that the System Backup page exposes the V2 item importer while retaining full/settings backup and restore.

**Step 2: Run tests to verify RED**

Run: `npx vitest run src/lib/Setting/Pages/SystemBackup.test.ts src/lib/Setting/SettingsNavigation.test.ts src/lib/Setting/SettingsConsolidation.test.ts`

**Step 3: Implement the minimum route/UI consolidation**

Remove the migration navigation/search/render branch. Keep route value `0` as a compatibility alias redirected to System → Backup so old callers do not land on a blank page.

**Step 4: Run tests to verify GREEN**

Run the Task 1 test command again.

### Task 2: Implement atomic V2 preview and merge

**Files:**
- Create: `server/node/v2-item-import.cjs`
- Create: `server/node/v2-item-import.test.ts`
- Modify: `server/node/file-store.cjs`
- Modify: `server/node/named-user-data-repository.cjs`

**Step 1: Write failing service tests**

Cover source validation, preview lists, dependency inclusion, readable duplicate names, ID/reference remapping, source immutability, asset collision isolation, and rollback when an asset is missing.

**Step 2: Run tests to verify RED**

Run: `npx vitest run --config vitest.config.server.ts server/node/v2-item-import.test.ts`

**Step 3: Implement preview and import**

Export the source V2 database without updating its checksum sidecars, select requested entities plus dependencies, remap target collisions, assign collision-safe logical asset keys, and call the target repository once with `mode: 'merge'`, strict assets, and a source-aware asset reader.

**Step 4: Run tests to verify GREEN**

Run the Task 2 test command again.

### Task 3: Expose authenticated server and storage-client APIs

**Files:**
- Modify: `server/node/server.cjs`
- Modify: `src/ts/storage/nodeStorage.ts`
- Modify: `src/ts/storage/autoStorage.ts`
- Create: `src/ts/storage/v2ItemImport.test.ts`

**Step 1: Write failing connection tests**

Assert preview and execute endpoints/methods, active-session protection, shared import lock, and error propagation.

**Step 2: Run tests to verify RED**

Run: `npx vitest run src/ts/storage/v2ItemImport.test.ts`

**Step 3: Implement endpoints and client methods**

Add JSON preview/import routes and typed client wrappers. Refresh server projections after commit and return imported/remapped summaries.

**Step 4: Run tests to verify GREEN**

Run the Task 3 test command and the server service test.

### Task 4: Add the V2 item importer to System Backup

**Files:**
- Modify: `src/lib/Setting/Pages/SystemBackup.svelte`
- Modify: `src/lib/Setting/Pages/SystemBackup.test.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

**Step 1: Extend the failing UI test**

Require a source-path field, preview action, per-item selection, dependency notice, destructive-safety copy, progress state, and import confirmation.

**Step 2: Implement the compact workflow**

Show a separate “V2 항목 가져오기” card below local backups. Disable import until preview succeeds and at least one item is selected; reload only after successful import.

**Step 3: Run targeted UI tests**

Run: `npx vitest run src/lib/Setting/Pages/SystemBackup.test.ts src/lib/Setting/SettingsNavigation.test.ts src/lib/Setting/SettingsConsolidation.test.ts`

### Task 5: Document and verify release behavior

**Files:**
- Modify: `docs/ko/file-native-storage.md`
- Modify: `patchnote/0.9.26.md`

**Step 1: Document the supported transfer path**

State that manual entity-folder copying is unsupported and that System → Backup → V2 item import is the atomic merge path. State that ordinary full backup import remains compatible with legacy local backups and RisuAI.

**Step 2: Run focused validation**

Run all tests from Tasks 1–3, then `npm run check` and `git diff --check`.

**Step 3: Browser verification**

Start a disposable-data-root server, open System → Backup, verify the migration page is absent, preview a fixture source, import selected entities, and confirm the destination data and duplicate-name rendering.
