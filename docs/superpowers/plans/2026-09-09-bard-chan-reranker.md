# Bard-chan Reranker Implementation Plan

**Goal:** Add an optional, token-bounded BardWiki candidate reranker whose public name is `바드쨩 (Bard-chan)`.

**Architecture:** The deterministic server inquiry remains the source of truth and exposes a small, bounded list of candidate cards. When the per-chat/global Bard-chan toggle is enabled and the candidate scores are ambiguous, the client sends only the current query plus those cards to the configured auxiliary model. The returned document IDs become semantic hints for one final deterministic inquiry. Required documents and source-message evidence remain controlled by the existing inquiry compiler, and any missing/failed auxiliary model falls back to the original result.

**Tech Stack:** TypeScript, Svelte 5, Vitest, existing `requestChatData` auxiliary-model binding.

---

### Task 1: Persist and expose the Bard-chan toggle

**Files:**
- Modify: `src/ts/risubard/risuBardSettings.test.ts`
- Modify: `src/ts/storage/risuBardSettingsPersistence.test.ts`
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Others/RisuBardCurrentChatSettings.svelte`
- Modify: `src/lang/ko.ts`, `src/lang/en.ts`, `src/lang/help.ko.ts`, `src/lang/help.en.ts`

1. Add failing tests for the default-off global value and per-chat override.
2. Run only the two settings tests and confirm the new assertions fail.
3. Add `risuBardBardChanEnabled`, normalize non-booleans to `false`, and add the global/current-chat checkbox labeled `바드쨩 (Bard-chan)`.
4. Re-run the two settings tests.

### Task 2: Provide bounded rerank candidates

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`

1. Add failing server/client contract tests for at most 12 cards containing only document ID, type, title, short excerpt, and score.
2. Expose cards from the already-ranked prepared candidates without adding another scan or full document body.
3. Validate and deserialize the cards in the browser client.
4. Re-run the targeted inquiry tests.

### Task 3: Run Bard-chan only for ambiguous candidates

**Files:**
- Create: `src/ts/risubard/bardChanReranker.test.ts`
- Create: `src/ts/risubard/bardChanReranker.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/requestPurpose.ts`

1. Add failing unit tests for ambiguity gating, tiny model requests, strict ID-only parsing, and failure fallback.
2. Implement one non-streaming auxiliary-model request with temperature 0, 64 output tokens, no tools, no retry loop in the helper, and no main-model fallback.
3. Integrate it between the initial and final inquiry. If disabled, unambiguous, unset, invalid, timed out, or failed, use the initial inquiry unchanged.
4. Record the request purpose as `바드쨩 (Bard-chan) 후보 재순위`.
5. Run the helper and narrative-context tests.

### Task 4: Document and verify

**Files:**
- Modify: `patchnote/0.9.26.md`

1. Add a concise user-facing patchnote entry without disturbing existing edits.
2. Run the focused client settings/reranker/inquiry tests and focused server inquiry tests.
3. Run `git diff --check` and inspect only the files changed for Bard-chan.
