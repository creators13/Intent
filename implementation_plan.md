# Implementation Plan

[Overview]
Improve the YouTube Intent Guard startup flow so users can always start a Learn/Relax session from the blocked YouTube overlay, while eliminating DOM-timing runtime errors and preserving the existing popup/dashboard behavior.

The current extension correctly blocks YouTube when there is no active session, but the content script runs at `document_start` and immediately appends an overlay to `document.body`. On some YouTube loads, `document.body` is not ready yet, which throws `TypeError: Cannot read properties of null (reading 'appendChild')` in `content/youtube-watcher.js`. This runtime error can disrupt the script lifecycle and lead to inconsistent UX.

Additionally, the current blocked-state overlay only instructs the user to use the popup, which creates a dead-end if the user does not notice the toolbar icon, has not pinned the extension, or expects an immediate on-page recovery path. The user requested a direct in-page workflow to start Learn/Relax sessions from the overlay itself.

The implementation will add a resilient DOM-ready overlay mount path, introduce an in-page session setup modal in the blocked state, and route form submissions through existing background `START_SESSION` handling to avoid duplicating session logic. It will keep the popup and dashboard as secondary control surfaces and maintain compatibility with current storage/session models.

[Types]
Add explicit session-intake payload structures used by the content script’s new in-page modal actions and background messaging.

Introduce these JSDoc-style structural contracts in `content/youtube-watcher.js` (or shared helper if extracted):

- `LearnAnswers`
  - `topic: string` (required, non-empty after trim)
  - `goal: string` (required, non-empty after trim)
  - `productiveReflection: string` (optional, may be empty string)

- `RelaxAnswers`
  - `currentFeel: string` (optional)
  - `desiredFeel: string` (required for UX validation)
  - `alternativesNow: string` (optional)
  - `tomorrowNeed: string` (optional)
  - `durationMinutes: number` (required; integer; clamp to [1, 240])
  - `durationWhy: string` (optional)

- `StartSessionPayload`
  - `mode: "learn" | "relax"`
  - `learnAnswers?: LearnAnswers`
  - `relaxAnswers?: RelaxAnswers`

- `OverlayState`
  - `isMounted: boolean`
  - `isBodyReady: boolean`
  - `activeOverlayId: string | null`

Validation rules:
- Reject Learn start if `topic` or `goal` is blank.
- Reject Relax start if `desiredFeel` blank or duration invalid.
- Surface validation errors inline in modal; do not close modal on failed validation.

[Files]
Modify the blocked-state recovery UX and hardening where startup/runtime issues occur.

Existing files to modify:
- `youtube-intent-guard/content/youtube-watcher.js`
  - Add safe DOM mount utility (wait for body / fallback to documentElement).
  - Refactor `renderOverlay` to never throw if body unavailable.
  - Add blocked-state overlay CTA buttons (Start Learn, Start Relax, Open Popup Guidance).
  - Add in-page modal renderer for Learn/Relax intake.
  - Add modal form submit handlers that call `send("START_SESSION", payload)`.
  - On successful session start: remove blocked overlay/modal, then reevaluate current video.
  - Add robust error handling around `send` calls and startup path.

- `youtube-intent-guard/ui/popup.html`
  - Optional: add copy note that in-page setup is available when blocked (consistency UX).

- `youtube-intent-guard/README.md`
  - Update usage/testing steps to include in-page session setup from blocked overlay.
  - Add troubleshooting note for extension icon/popup visibility and blocked-state fallback.

- `youtube-intent-guard/manifest.json`
  - No functional change expected; verify content script `run_at` behavior remains intentional.

No files to delete or move.

Potential optional new file (if modularized for maintainability):
- `youtube-intent-guard/content/session-intake-ui.js` (extract modal rendering/validation helpers from watcher). If not created, keep everything in `youtube-watcher.js` for minimal scope.

[Functions]
Add and modify content-script functions to support safe mounting and in-page session start.

New functions (target: `youtube-intent-guard/content/youtube-watcher.js`):
- `async waitForBody(timeoutMs = 3000): Promise<HTMLElement | null>`
  - Waits for `document.body` existence using mutation observer or polling.
- `mountOverlayNode(node: HTMLElement): void`
  - Appends to body if available, else safe fallback target.
- `renderSessionSetupModal(mode: "learn" | "relax"): void`
  - Renders modal with mode-specific form.
- `readLearnFormValues(): LearnAnswers`
- `readRelaxFormValues(): RelaxAnswers`
- `validateLearnAnswers(answers): { ok: boolean; errors: string[] }`
- `validateRelaxAnswers(answers): { ok: boolean; errors: string[] }`
- `async startSessionFromModal(mode): Promise<void>`
  - Builds payload, validates, sends `START_SESSION`, handles success/failure.
- `wireBlockedOverlayActions(): void`
  - Binds click handlers for blocked overlay CTA controls.

Modified functions:
- `renderOverlay(html, id = "intent-guard-overlay")`
  - Change from direct `document.body.appendChild` to safe mount path.
- `evaluateCurrentVideo(reason = "navigation")`
  - Blocked branch should render actionable UI and bind handlers.
  - After successful start from modal, continue normal flow.
- `attachSpaListeners()`
  - Ensure listeners coexist with modal lifecycle and do not duplicate bindings.

Removed/replaced function behavior:
- No named function removals; only replace implicit “instruction-only blocked overlay” behavior with “actionable blocked overlay + modal flow”.

[Classes]
No class-based architecture changes are required; implementation remains functional with module-level helpers.

There are currently no classes in this code path. The plan keeps this style to reduce refactor risk and maintain consistency with existing extension scripts.

[Dependencies]
No new external dependencies are required.

Implementation uses existing Web APIs (`MutationObserver`, DOM events) and existing Chrome extension messaging/storage APIs. Node/npm remain dev-time tooling for syntax checks only.

[Testing]
Validate both runtime stability and end-user blocked-flow recovery.

Manual test requirements:
- Load extension in `chrome://extensions` with Developer mode.
- Open `https://www.youtube.com` with no active session:
  - Expect no `appendChild` null error.
  - Expect blocked overlay with actionable Start Learn/Start Relax options.
- Start Learn from in-page modal:
  - Ensure payload accepted, overlay closes, relevance checks proceed.
- Start Relax from in-page modal:
  - Ensure session starts, overlay clears, timer behavior remains functional.
- Ensure popup-based session start still works unchanged.
- Verify dashboard opens and calibration remains intact.

Static/syntax checks:
- `node --check` for all edited JS files.
- Manifest JSON parse validation via Python.
- String/presence consistency checks for new modal and CTA hooks.

Regression checks:
- SPA navigation listeners still trigger relevance reevaluation.
- No duplicate overlays/modal nodes after repeated route changes.
- No uncaught promise errors from messaging failures.

[Implementation Order]
Implement reliability fixes first, then UX additions, then validation and docs.

1. Harden overlay mount path (`waitForBody`, safe append) to eliminate runtime crash.
2. Upgrade blocked-state overlay to include actionable CTA controls.
3. Implement in-page Learn/Relax modal rendering and input validation.
4. Wire modal submit to `START_SESSION` background message and success/error handling.
5. Re-run evaluation flow after successful session creation.
6. Add guardrails to avoid duplicate listeners/overlays on SPA navigation.
7. Update README usage + troubleshooting guidance.
8. Run syntax, manifest, and regression checks; fix any issues.
