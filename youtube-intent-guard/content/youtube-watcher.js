(async function () {
  const send = (type, payload = {}) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

  let activeShortsKey = null;
  let latestEvaluationRunId = 0;
  let latestCoordinatorId = 0;
  let scheduledEvalTimer = null;
  let latestDebugSeq = 0;
  let lastEvaluatedSnapshot = null;
  let evaluationResolutionEpoch = 0;
  const watcherBootId = `boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const intentCache = new Map();
  let lastBgeIntentSessionId = null;
  let lastBgeIntentSessionSignature = null;
  let listenersBound = false;
  let mediaWasAutoMuted = false;
  let expiredRelaxFullscreenSession = null;
  let expiredRelaxFullscreenHandlerBound = false;
  const autoPausedMedia = new WeakSet();
  let appliedDecisionLock = null;
  const DEFAULT_RELOAD_FALLBACK_AFTER_MS = 3000;
  const DEFAULT_META_GATE_TIMEOUT_MS = 5000;
  const RELAX_TEXT_MIN_NON_WHITESPACE = 10;
  const recentShortsUrls = [];
  const MAX_SHORTS_HISTORY = 20;

  function markDecisionApplied(videoId, verdict, { sessionId = null, sessionSignature = null } = {}) {
    if (!videoId) return;
    appliedDecisionLock = {
      videoId,
      verdict,
      sessionId,
      sessionSignature,
      appliedAt: Date.now()
    };
    evaluationResolutionEpoch += 1;
  }

  function reloadFallbackKeyForVideo(videoId) {
    return `ig-reload-fallback:${videoId || "unknown"}`;
  }

  function canUseReloadFallbackForVideo(videoId) {
    try {
      const key = reloadFallbackKeyForVideo(videoId);
      return !sessionStorage.getItem(key);
    } catch {
      return true;
    }
  }

  function markReloadFallbackUsed(videoId) {
    try {
      sessionStorage.setItem(reloadFallbackKeyForVideo(videoId), String(Date.now()));
    } catch {
      // no-op
    }
  }

  function trackShortsUrl(url = location.href) {
    if (!isShortsPage(url)) return;
    if (recentShortsUrls[recentShortsUrls.length - 1] === url) return;
    recentShortsUrls.push(url);
    if (recentShortsUrls.length > MAX_SHORTS_HISTORY) recentShortsUrls.shift();
  }


  function isGenericYouTubeDescription(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return true;
    return (
      t === "enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on youtube." ||
      t.startsWith("enjoy the videos and music you love, upload original content")
    );
  }

  async function waitForBody(timeoutMs = 3000) {
    if (document.body) return document.body;
    const start = Date.now();
    while (!document.body && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return document.body || null;
  }

  function getVideoIdFromUrl(url = location.href) {
    const shortsMatch = url.match(/youtube\.com\/shorts\/([^?&/]+)/);
    if (shortsMatch) return shortsMatch[1];
    const match = url.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
  }

  function isWatchPage(url = location.href) {
    return /youtube\.com\/watch\?/.test(url);
  }

  function isShortsPage(url = location.href) {
    return /youtube\.com\/shorts\//.test(url);
  }

  function isYoutubeHome(url = location.href) {
    try {
      const u = new URL(url);
      if (!/youtube\.com$/.test(u.hostname)) return false;
      if (u.pathname !== "/") return false;
      return !u.search;
    } catch {
      return false;
    }
  }

  function buildYoutubeSearchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query || "")}`;
  }

  function buildWatchUrlFromVideoId(videoId) {
    if (!videoId) return "https://www.youtube.com/";
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  function nonWhitespaceLength(text = "") {
    return String(text || "").replace(/\s/g, "").length;
  }

  function showModalError(message, fieldId = null) {
    const err = document.getElementById("igm-error");
    if (err) err.textContent = message;
    document.querySelectorAll(".igm-input-error").forEach((el) => el.classList.remove("igm-input-error"));
    const field = fieldId ? document.getElementById(fieldId) : null;
    if (field) {
      field.classList.add("igm-input-error");
      field.focus();
    }
  }

  function validateRelaxModalAnswers(answers = {}) {
    const fields = [
      ["currentFeel", "igm-relax-current", "how you currently feel"],
      ["desiredFeel", "igm-relax-want", "how you want to feel"],
      ["alternativesNow", "igm-relax-other", "what else could help you now"],
      ["tomorrowNeed", "igm-relax-tomorrow", "what you are going to do after this relax session and why it is important to follow through"],
      ["durationWhy", "igm-relax-why", "why this is an appropriate session length for you"]
    ];

    for (const [key, fieldId, label] of fields) {
      if (nonWhitespaceLength(answers[key]) < RELAX_TEXT_MIN_NON_WHITESPACE) {
        return {
          ok: false,
          message: `Please elaborate more on ${label}.`,
          fieldId
        };
      }
    }

    return { ok: true };
  }

  function escapeHtml(value = "") {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isRelaxSessionExpired(session) {
    return session?.mode === "relax" && Number(session.endTime || 0) > 0 && Date.now() >= Number(session.endTime);
  }

  function getRelaxDurationMinutes(session) {
    const answerDuration = Number(session?.relaxAnswers?.durationMinutes);
    if (Number.isFinite(answerDuration) && answerDuration > 0) return Math.round(answerDuration);

    const start = Number(session?.startTime || 0);
    const end = Number(session?.endTime || 0);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(1, Math.round((end - start) / 60_000));
    }

    return 0;
  }

  async function renderExpiredRelaxSessionBlocker(session, options = {}) {
    pauseAndMuteMedia();

    const duration = getRelaxDurationMinutes(session);
    const durationText = duration > 0 ? `${duration} minute${duration === 1 ? "" : "s"}` : "your planned time";
    const commitment = escapeHtml(session?.relaxAnswers?.tomorrowNeed || "your post-session commitment");
    const alternatives = escapeHtml(session?.relaxAnswers?.alternativesNow || "the strategies you wrote down");

    await renderOverlay(`
      <div class="ig-card">
        <h2 class="ig-title">Your relax session of ${durationText} is done now!</h2>
        <p class="ig-copy">Remember your commitment to <strong>${commitment}</strong>.</p>
        <p class="ig-copy">If you still don't feel great, you can try some of these strategies instead of YouTube: <strong>${alternatives}</strong>.</p>
        <div class="ig-actions">
          <button id="ig-end-expired-relax" class="ig-btn ig-btn-primary">End session</button>
        </div>
        <p id="ig-expired-relax-error" class="ig-helper-note" hidden></p>
      </div>
    `, "intent-guard-expired-relax", options);

    document.getElementById("ig-end-expired-relax")?.addEventListener("click", async () => {
      const btn = document.getElementById("ig-end-expired-relax");
      const error = document.getElementById("ig-expired-relax-error");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Ending session…";
      }
      if (error) {
        error.hidden = true;
        error.textContent = "";
      }

      try {
        const res = await send("END_SESSION_FROM_BLOCKER", {
          completionCheck: { note: "Ended expired Relax session from timeout blocker." }
        });

        if (!res?.ok) throw new Error(res?.error || "Could not end session.");
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "End session";
        }
        if (error) {
          error.hidden = false;
          error.textContent = `Could not end the session. Please try again or use the Thread popup. ${String(err?.message || err || "")}`;
        }
      }
    });
  }

  function applyLearnSearchRedirect(session, { force = false } = {}) {
    const goal = session?.learnAnswers?.goal?.trim() || "";
    if (!goal) return false;
    if (!force && !isYoutubeHome()) return false;
    const nextUrl = buildYoutubeSearchUrl(goal);
    if (location.href !== nextUrl) {
      location.replace(nextUrl);
      return true;
    }
    return false;
  }

  function removeOverlay(id = "intent-guard-overlay") {
    document.getElementById(id)?.remove();
  }

  function clearAllGuardOverlays() {
    unbindExpiredRelaxFullscreenTransition();
    removeOverlay("intent-guard-overlay");
    removeOverlay("intent-guard-loading");
    removeOverlay("intent-guard-borderline");
    removeOverlay("intent-guard-session-modal");
    removeOverlay("intent-guard-expired-relax");
  }

  function clearTransientEvaluationOverlays() {
    removeOverlay("intent-guard-loading");
  }

  function pauseAndMuteMedia() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      if (!v.paused) {
        try {
          v.pause();
          autoPausedMedia.add(v);
        } catch {}
      }
      if (!v.muted) {
        v.muted = true;
        mediaWasAutoMuted = true;
      }
    }
  }

  function unmuteAndResumeMedia() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      if (mediaWasAutoMuted) v.muted = false;
      // Only resume media we explicitly paused to avoid autoplaying stale
      // Shorts/background video elements after relevance checks.
      if (v.paused && autoPausedMedia.has(v)) {
        const p = v.play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    }
    mediaWasAutoMuted = false;
  }

  function unbindExpiredRelaxFullscreenTransition() {
    if (!expiredRelaxFullscreenHandlerBound) return;
    document.removeEventListener("fullscreenchange", handleExpiredRelaxFullscreenChange);
    expiredRelaxFullscreenHandlerBound = false;
    expiredRelaxFullscreenSession = null;
  }

  function bindExpiredRelaxFullscreenTransition(session) {
    expiredRelaxFullscreenSession = session;
    if (expiredRelaxFullscreenHandlerBound) return;
    expiredRelaxFullscreenHandlerBound = true;
    document.addEventListener("fullscreenchange", handleExpiredRelaxFullscreenChange);
  }

  async function handleExpiredRelaxFullscreenChange() {
    if (document.fullscreenElement) return;
    const session = expiredRelaxFullscreenSession;
    if (!session || !isRelaxSessionExpired(session)) {
      unbindExpiredRelaxFullscreenTransition();
      return;
    }
    if (!document.getElementById("intent-guard-expired-relax")) {
      unbindExpiredRelaxFullscreenTransition();
      return;
    }

    unbindExpiredRelaxFullscreenTransition();
    await renderExpiredRelaxSessionBlocker(session);
  }

  async function renderExpiredRelaxSessionBlockerFullscreenSafe(session) {
    pauseAndMuteMedia();

    const fullscreenEl = document.fullscreenElement;
    if (fullscreenEl && typeof document.exitFullscreen === "function") {
      try {
        await document.exitFullscreen();
      } catch {
        // Best effort only. If fullscreen remains active, mount the blocker
        // inside the fullscreen element below so it is still visible.
      }
    }

    if (document.fullscreenElement) {
      await renderExpiredRelaxSessionBlocker(session, { target: document.fullscreenElement });
      bindExpiredRelaxFullscreenTransition(session);
      return;
    }

    await renderExpiredRelaxSessionBlocker(session);
  }

  async function showExpiredRelaxSessionNow(session) {
    if (!isRelaxSessionExpired(session)) {
      return { ok: false, error: "Relax session is not expired." };
    }

    latestEvaluationRunId += 1;
    nextCoordinatorId();
    if (scheduledEvalTimer) {
      clearTimeout(scheduledEvalTimer);
      scheduledEvalTimer = null;
    }

    await renderExpiredRelaxSessionBlockerFullscreenSafe(session);
    return { ok: true };
  }

  function handleGoBackNavigation() {
    latestEvaluationRunId += 1;
    nextCoordinatorId();
    if (scheduledEvalTimer) {
      clearTimeout(scheduledEvalTimer);
      scheduledEvalTimer = null;
    }
    clearAllGuardOverlays();
    unmuteAndResumeMedia();
    activeShortsKey = null;

    if (isShortsPage()) {
      trackShortsUrl(location.href);
      while (recentShortsUrls.length && recentShortsUrls[recentShortsUrls.length - 1] === location.href) {
        recentShortsUrls.pop();
      }
      const previousShortUrl = recentShortsUrls[recentShortsUrls.length - 1];
      if (previousShortUrl) {
        location.assign(previousShortUrl);
        return;
      }
    }

    history.back();
  }

  async function approveCurrentVideo(videoId) {
    if (!videoId) return;
    try {
      await send("APPROVE_VIDEO", { videoId });
    } catch {
      // no-op
    }
  }

  async function emitEvalDebug(payload = {}) {
    const seq = ++latestDebugSeq;
    try {
      await send("EVAL_DEBUG_UPDATE", {
        seq,
        watcherBootId,
        ...payload,
        pageUrl: location.href,
        pageVideoId: getVideoIdFromUrl(),
        emittedAtMs: Date.now()
      });
    } catch {
      // no-op
    }
  }

  function nextCoordinatorId() {
    latestCoordinatorId += 1;
    return latestCoordinatorId;
  }

  function isActiveCoordinator(coordinatorId) {
    return coordinatorId === latestCoordinatorId;
  }

  function scheduleNavigationEvaluation(reason = "navigation", delayMs = 140) {
    const coordinatorId = nextCoordinatorId();
    if (scheduledEvalTimer) clearTimeout(scheduledEvalTimer);
    scheduledEvalTimer = setTimeout(() => {
      evaluateCurrentVideo(reason, { coordinatorId });
    }, delayMs);
    emitEvalDebug({ type: "coord-start", reason, coordinatorId, phase: "scheduled" });
  }

  function baseOverlayStyles() {
    return `
      <style>
        .ig-shell {
          width: min(94vw, 980px);
          max-height: 92vh;
          overflow: auto;
          margin: 0 auto;
          padding: 0;
          border: 0;
          background: transparent;
          box-shadow: none;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }
        .ig-card {
          border-radius: 28px;
          border: 1px solid #e5e7eb;
          background: #ffffff;
          color: #111827;
          padding: 32px;
          overflow: hidden;
          box-shadow: 0 18px 48px rgba(2, 6, 23, 0.22);
        }
        .ig-brand-logo {
          display: block;
          width: min(330px, 72vw);
          height: auto;
          margin: 0 auto 18px;
        }
        .ig-title {
          margin: 0 0 14px;
          text-align: center;
          font-size: 34px;
          line-height: 1.2;
          letter-spacing: -0.02em;
          font-weight: 700;
          color: #0f172a;
        }
        .ig-copy {
          margin: 0 auto 22px;
          max-width: 760px;
          text-align: center;
          color: #334155;
          font-size: 19px;
          line-height: 1.55;
        }
        .ig-copy strong {
          color: #0f172a;
        }
        .ig-actions {
          max-width: 760px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: 1fr;
          gap: 14px;
        }
        .ig-helper-note {
          max-width: 760px;
          margin: 18px auto 0;
          padding: 14px 16px;
          border-radius: 18px;
          border: 1px solid #e5e7eb;
          background: #f8fafc;
          color: #64748b;
          text-align: center;
          font-size: 15px;
          line-height: 1.45;
        }
        .ig-helper-note strong {
          color: #334155;
          font-weight: 650;
        }
        .ig-btn {
          width: 100%;
          box-sizing: border-box;
          border-radius: 18px;
          border: 1px solid #d1d5db;
          background: #ffffff;
          color: #111827;
          padding: 15px 18px;
          font-size: 19px;
          font-weight: 650;
          line-height: 1.3;
          cursor: pointer;
          transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
        }
        .ig-btn:hover {
          background: #f3f4f6;
        }
        .ig-btn-primary {
          border-color: transparent;
          background: #111827;
          color: #ffffff;
        }
        .ig-btn-primary:hover {
          background: #0f172a;
          transform: translateY(-1px);
          box-shadow: 0 10px 20px rgba(2, 6, 23, 0.2);
        }
      </style>
    `;
  }

  async function renderOverlay(html, id = "intent-guard-overlay", options = {}) {
    clearAllGuardOverlays();
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,1)";
    overlay.style.color = "#fff";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.innerHTML = `${baseOverlayStyles()}<div class="ig-shell">${html}</div>`;
    const target = options.target || (await waitForBody()) || document.documentElement;
    target.appendChild(overlay);
  }

  function closeSessionModal() {
    removeOverlay("intent-guard-session-modal");
  }

  async function renderSessionTypeBlocker() {
    const logoUrl = chrome.runtime.getURL("assets/Thread_logo_only.png");
    await renderOverlay(`
      <div class="ig-card">
        <img class="ig-brand-logo" src="${logoUrl}" alt="Thread" />
        <h2 class="ig-title">Start your YouTube session!</h2>
        <p class="ig-copy">Define your intent first so your watching stays purposeful and enjoyable.</p>
        <div class="ig-actions">
          <button id="ig-start-learn" class="ig-btn ig-btn-primary">Learn</button>
          <button id="ig-start-relax" class="ig-btn">Relax</button>
        </div>
        <p class="ig-helper-note">
          Want to view or end your session later?<br/>
          Click the menu bar's puzzle piece icon, then click <strong>Thread</strong>.
        </p>
      </div>
    `);
    document.getElementById("ig-start-learn")?.addEventListener("click", () => renderSessionModal("learn"));
    document.getElementById("ig-start-relax")?.addEventListener("click", () => renderSessionModal("relax"));
  }

  async function startLearnFromModal() {
    const topic = document.getElementById("igm-learn-topic")?.value?.trim() || "";
    const goal = document.getElementById("igm-learn-goal")?.value?.trim() || "";
    const purposeReflection = document.getElementById("igm-learn-purpose")?.value?.trim() || "";
    const timingReflection = document.getElementById("igm-learn-timing")?.value?.trim() || "";
    const err = document.getElementById("igm-error");
    if (!topic) {
      showModalError("Please enter the topic(s) you want to learn.", "igm-learn-topic");
      return;
    }
    if (!goal) {
      showModalError("Please enter your goal for this session.", "igm-learn-goal");
      return;
    }

    const res = await send("START_SESSION", {
      mode: "learn",
      learnAnswers: { topic, goal, purposeReflection, timingReflection }
    });

    if (!res?.ok) {
      if (err) err.textContent = res?.error || "Could not start Learn session.";
      return;
    }

    closeSessionModal();
    removeOverlay();
    unmuteAndResumeMedia();
    if (applyLearnSearchRedirect(res?.session, { force: true })) return;
    scheduleNavigationEvaluation("forced", 60);
  }

  async function startRelaxFromModal() {
    const desiredFeel = document.getElementById("igm-relax-want")?.value?.trim() || "";
    const durationRaw = Number(document.getElementById("igm-relax-duration")?.value || 30);
    const durationMinutes = Math.max(1, Math.min(240, Number.isFinite(durationRaw) ? Math.round(durationRaw) : 30));
    const currentFeel = document.getElementById("igm-relax-current")?.value?.trim() || "";
    const alternativesNow = document.getElementById("igm-relax-other")?.value?.trim() || "";
    const tomorrowNeed = document.getElementById("igm-relax-tomorrow")?.value?.trim() || "";
    const durationWhy = document.getElementById("igm-relax-why")?.value?.trim() || "";
    const err = document.getElementById("igm-error");

    const validation = validateRelaxModalAnswers({ currentFeel, desiredFeel, alternativesNow, tomorrowNeed, durationWhy });
    if (!validation.ok) {
      showModalError(validation.message, validation.fieldId);
      return;
    }

    const res = await send("START_SESSION", {
      mode: "relax",
      relaxAnswers: { currentFeel, desiredFeel, alternativesNow, tomorrowNeed, durationMinutes, durationWhy }
    });

    if (!res?.ok) {
      if (err) err.textContent = res?.error || "Could not start Relax session.";
      return;
    }

    closeSessionModal();
    removeOverlay();
    unmuteAndResumeMedia();
    scheduleNavigationEvaluation("forced", 60);
  }

  function autoGrowModalTextarea(el) {
    if (!(el instanceof HTMLTextAreaElement)) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function bindModalAutoGrowTextareas(root = document) {
    root.querySelectorAll("textarea").forEach((el) => {
      autoGrowModalTextarea(el);
      el.addEventListener("input", () => autoGrowModalTextarea(el));
    });
  }

  async function renderSessionModal(mode) {
    const sharedStyles = `
      <style>
        .igm-card {
          width: min(90vw, 840px);
          max-height: 88vh;
          overflow: auto;
          margin-inline: auto;
          border-radius: 36px;
          border: 1px solid #e5e7eb;
          background: #ffffff;
          color: #111827;
          box-sizing: border-box;
          padding: 38px;
          box-shadow: 0 18px 48px rgba(2, 6, 23, 0.22);
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }
        .igm-title {
          margin: 0 0 24px;
          text-align: center;
          font-size: 30px;
          line-height: 1.2;
          letter-spacing: -0.02em;
          font-weight: 700;
          color: #0f172a;
        }
        .igm-field {
          max-width: 700px;
          margin: 0 auto 20px;
        }
        .igm-label {
          display: block;
          font-size: 16px;
          font-weight: 600;
          line-height: 1.35;
          color: #334155;
          margin-bottom: 10px;
          font-family: inherit;
        }
        .igm-input,
        .igm-textarea,
        .igm-btn {
          width: 100%;
          max-width: 700px;
          margin-inline: auto;
          display: block;
          box-sizing: border-box;
          border-radius: 18px;
          border: 1px solid #d1d5db;
          background: #f9fafb;
          color: #111827;
          padding: 16px 18px;
          font-size: 18px;
          line-height: 1.35;
          font-family: inherit;
        }
        .igm-field {
          overflow: visible;
          border-radius: 0;
        }
        .igm-input::placeholder,
        .igm-textarea::placeholder {
          color: #9ca3af;
        }
        .igm-textarea {
          min-height: 116px;
          overflow: hidden;
          resize: none;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .igm-input:focus,
        .igm-textarea:focus,
        .igm-btn:focus {
          outline: none;
          border-color: #a5b4fc;
          box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
        }
        .igm-input-error {
          border-color: #ef4444;
          box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.12);
        }
        .igm-btn {
          margin-top: 18px;
          font-weight: 650;
          cursor: pointer;
          transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
        }
        .igm-btn-primary {
          border-color: transparent;
          background: #111827;
          color: #ffffff;
        }
        .igm-btn-primary:hover {
          background: #0f172a;
          transform: translateY(-1px);
          box-shadow: 0 10px 20px rgba(2, 6, 23, 0.2);
        }
        .igm-btn-secondary {
          background: #ffffff;
          color: #111827;
        }
        .igm-btn-secondary:hover {
          background: #f3f4f6;
        }
        .igm-error {
          color: #b91c1c;
          margin: 12px auto 0;
          max-width: 700px;
          font-size: 15px;
          font-weight: 600;
        }
        @media (max-width: 980px) {
          .igm-card {
            width: min(94vw, 840px);
            padding: 28px;
          }
        }
        @media (max-width: 640px) {
          .igm-card {
            width: min(96vw, 840px);
            padding: 20px;
            border-radius: 24px;
          }
          .igm-title {
            font-size: 26px;
          }
        }
      </style>
    `;

    const learnFields = `
      <h2 class="igm-title">Start Learn Session</h2>
      <div class="igm-field">
        <label class="igm-label" for="igm-learn-topic">What topic(s) do I want to learn about in this session?</label>
        <textarea class="igm-input igm-textarea" id="igm-learn-topic" placeholder="e.g. VScode setup, python, AI coding tools"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-learn-goal">What is my goal to reach by the end of this session?</label>
        <textarea class="igm-input igm-textarea" id="igm-learn-goal" placeholder="e.g. Build one practical example"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-learn-purpose">What is my purpose for this learning?</label>
        <textarea class="igm-textarea" id="igm-learn-purpose" placeholder="Short reflection"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-learn-timing">Is now an appropriate time for this learning?</label>
        <textarea class="igm-textarea" id="igm-learn-timing" placeholder="Short reflection"></textarea>
      </div>
      <button class="igm-btn igm-btn-primary" id="igm-start-learn">Start Learn</button>
    `;
    const relaxFields = `
      <h2 class="igm-title">Start Relax Session</h2>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-current">How do I currently feel?</label>
        <textarea class="igm-input igm-textarea" id="igm-relax-current" placeholder="e.g. Tired, anxious"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-want">How do I want to feel?</label>
        <textarea class="igm-input igm-textarea" id="igm-relax-want" placeholder="e.g. Calm and recharged"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-other">What else could help me feel better now besides YouTube?</label>
        <textarea class="igm-input igm-textarea" id="igm-relax-other" placeholder="e.g. Stretching or a short walk"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-tomorrow">What am I going to do after this relax session? Why is it important that I follow through?</label>
        <textarea class="igm-input igm-textarea" id="igm-relax-tomorrow" placeholder="e.g. Sleep by 11pm"></textarea>
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-duration">How long should my session be (minutes)?</label>
        <input class="igm-input" id="igm-relax-duration" type="number" min="1" max="240" value="30" />
      </div>
      <div class="igm-field">
        <label class="igm-label" for="igm-relax-why">Why is this an appropriate session length for me?</label>
        <textarea class="igm-textarea" id="igm-relax-why" placeholder="Short reflection"></textarea>
      </div>
      <button class="igm-btn igm-btn-primary" id="igm-start-relax">Start Relax</button>
    `;

    await renderOverlay(`
      ${sharedStyles}
      <div class="igm-card">
        ${mode === "learn" ? learnFields : relaxFields}
        <p id="igm-error" class="igm-error"></p>
        <button class="igm-btn igm-btn-secondary" id="igm-cancel">Cancel</button>
      </div>
    `, "intent-guard-session-modal");

    bindModalAutoGrowTextareas(document.getElementById("intent-guard-session-modal") || document);

    document.getElementById("igm-cancel")?.addEventListener("click", async () => {
      closeSessionModal();
      await renderSessionTypeBlocker();
    });
    if (mode === "learn") {
      document.getElementById("igm-start-learn")?.addEventListener("click", startLearnFromModal);
    } else {
      document.getElementById("igm-start-relax")?.addEventListener("click", startRelaxFromModal);
    }
  }

  function textFromSelector(selector) {
    return document.querySelector(selector)?.textContent?.trim() || "";
  }

  function metaContent(name) {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
  }

  function normalizedDocumentTitle() {
    const raw = (document.title || "").trim();
    return raw.replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }

  function getMetaFromWindowObject() {
    const ytd = globalThis.ytInitialPlayerResponse || {};
    const videoId = ytd?.videoDetails?.videoId || "";
    const objectTitle = ytd?.videoDetails?.title || "";
    const metaTitle = metaContent("title");
    const docTitle = normalizedDocumentTitle();
    const watchDomTitle = (textFromSelector("h1.ytd-watch-metadata yt-formatted-string") || textFromSelector("h1.title") || "").trim();
    const title = objectTitle || metaTitle || docTitle || watchDomTitle || "";
    const titleSource = objectTitle
      ? "ytInitialPlayerResponse"
      : metaTitle
        ? "meta[name=title]"
        : docTitle
          ? "document.title"
          : "watch-dom";
    const objectDescription =
      ytd?.microformat?.playerMicroformatRenderer?.description?.simpleText ||
      ytd?.videoDetails?.shortDescription ||
      "";
    const metaDescription = metaContent("description");
    const watchDomDescription = (
      textFromSelector("#description-inline-expander") ||
      textFromSelector("#description yt-formatted-string") ||
      ""
    ).trim();
    const description = objectDescription || metaDescription || watchDomDescription || "";
    const descriptionSource = objectDescription
      ? "ytInitialPlayerResponse"
      : metaDescription
        ? "meta[name=description]"
        : "watch-dom";
    return { videoId, title, description, titleSource, descriptionSource };
  }

  async function getVideoMetaStaged(targetVideoId, debugCtx = null, shouldAbort = null) {
    let title = "";
    let description = "";
    let sourceVideoId = "";

    for (let i = 0; i < 24; i++) {
      if (shouldAbort?.()) {
        return { title: "", description: "", isReady: false, abortedByWinner: true, sourceVideoId: "", descriptionConfidence: "unknown" };
      }
      const fromObj = getMetaFromWindowObject();
      sourceVideoId = fromObj.videoId || "";
      const domTitle = (textFromSelector("h1.ytd-watch-metadata yt-formatted-string") || textFromSelector("h1.title") || "").trim();
      title = (fromObj.title || domTitle || "").trim();
      const domDescription = (textFromSelector("#description-inline-expander") || textFromSelector("#description yt-formatted-string") || "").trim();
      description = (fromObj.description || domDescription || "").trim();
      const titleSource = fromObj.titleSource || (fromObj.title ? "ytInitialPlayerResponse" : "dom");
      const descriptionSource = fromObj.descriptionSource || (fromObj.description ? "ytInitialPlayerResponse" : "watch-dom");
      const descriptionConfidence = fromObj.description ? "runtime-high" : "dom-medium";
      const genericDescription = isGenericYouTubeDescription(description);

      if (debugCtx?.runId && i % 3 === 0) {
        await emitEvalDebug({
          type: "meta-source-candidates",
          runId: debugCtx.runId,
          reason: debugCtx.reason,
          targetVideoId,
          targetUrl: debugCtx.targetUrl,
          sourceVideoId,
          checks: { attempt: i + 1, genericDescription },
          candidates: {
            objectDescription: (fromObj.description || "").slice(0, 180),
            metaDescription: metaContent("description").slice(0, 180),
            domDescription: domDescription.slice(0, 180),
            boundDescription: "",
            fetchedBoundDescription: ""
          },
          current: {
            url: debugCtx.targetUrl,
            videoId: targetVideoId,
            title,
            description: description.slice(0, 220),
            titleSource,
            descriptionSource,
            descriptionConfidence,
            genericDescription
          }
        });
      }

      const titleReady = title.length >= 8;
      const descriptionReady = description.length === 0 || !genericDescription;
      const objectIdMatches = !sourceVideoId || !targetVideoId || sourceVideoId === targetVideoId;
      if (titleReady && descriptionReady) {
        const firstSnapshot = `${title}\n${description}`;
        await new Promise((r) => setTimeout(r, 250));

        const fromObj2 = getMetaFromWindowObject();
        const sourceVideoId2 = fromObj2.videoId || "";
        const domTitle2 = (textFromSelector("h1.ytd-watch-metadata yt-formatted-string") || textFromSelector("h1.title") || "").trim();
        const title2 = (fromObj2.title || domTitle2 || "").trim();
        const domDescription2 = (textFromSelector("#description-inline-expander") || textFromSelector("#description yt-formatted-string") || "").trim();
        const description2 = (fromObj2.description || domDescription2 || "").trim();
        const titleSource2 = fromObj2.titleSource || (fromObj2.title ? "ytInitialPlayerResponse" : "dom");
        const descriptionSource2 = fromObj2.descriptionSource || (fromObj2.description ? "ytInitialPlayerResponse" : "watch-dom");
        const descriptionConfidence2 = fromObj2.description ? "runtime-high" : "dom-medium";

        const secondSnapshot = `${title2}\n${description2}`;
        const secondIdMatches = !sourceVideoId2 || !targetVideoId || sourceVideoId2 === targetVideoId;

        if (
          firstSnapshot === secondSnapshot &&
          title2.length >= 8 &&
          (description2.length === 0 || !isGenericYouTubeDescription(description2)) &&
          objectIdMatches &&
          secondIdMatches
        ) {
          if (debugCtx?.runId) {
            await emitEvalDebug({
              type: "meta-sample-ready",
              runId: debugCtx.runId,
              reason: debugCtx.reason,
              targetVideoId,
              targetUrl: debugCtx.targetUrl,
              sourceVideoId: sourceVideoId2 || sourceVideoId || "",
              current: {
                url: debugCtx.targetUrl,
                videoId: targetVideoId,
                title: title2,
                description: description2,
                titleSource: titleSource2,
                descriptionSource: descriptionSource2,
                descriptionConfidence: descriptionConfidence2
              }
            });
          }
          return {
            title: title2,
            description: description2,
            isReady: true,
            sourceVideoId: sourceVideoId2 || sourceVideoId || "",
            titleSource: titleSource2,
            descriptionSource: descriptionSource2,
            descriptionConfidence: descriptionConfidence2
          };
        }
      }

      if (debugCtx?.runId && i % 6 === 0) {
        await emitEvalDebug({
          type: "meta-sample-progress",
          runId: debugCtx.runId,
          reason: debugCtx.reason,
          targetVideoId,
          targetUrl: debugCtx.targetUrl,
          sourceVideoId,
          current: {
            url: debugCtx.targetUrl,
            videoId: targetVideoId,
            title,
            description,
            titleSource,
            descriptionSource,
            descriptionConfidence
          },
          checks: {
            titleReady,
            descriptionReady,
            objectIdMatches,
            genericDescription,
            notReadyReason: !descriptionReady && genericDescription ? "generic-description" : "",
            attempt: i + 1
          }
        });
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    return { title: title || "", description: description || "", isReady: false, sourceVideoId, descriptionConfidence: "unknown" };
  }

  function normalizeMetaText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getSourceStrength(meta = {}) {
    const titleSource = String(meta.titleSource || "");
    const descriptionSource = String(meta.descriptionSource || "");
    const weakTitle = titleSource === "meta[name=title]";
    const weakDescription = descriptionSource === "meta[name=description]";
    return weakTitle && weakDescription ? "weak-meta-only" : "strong";
  }

  async function getPersistedLastSnapshot() {
    try {
      const res = await send("GET_LAST_EVALUATED_SNAPSHOT");
      return res?.snapshot || null;
    } catch {
      return null;
    }
  }

  async function setPersistedLastSnapshot(snapshot) {
    try {
      await send("SET_LAST_EVALUATED_SNAPSHOT", { snapshot: snapshot || null });
    } catch {
      // no-op
    }
  }

  function simpleHash(text = "") {
    let h = 2166136261;
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  }

  function clearLoadingOverlay() {
    removeOverlay("intent-guard-loading");
  }

  async function waitForNavigationStability(targetVideoId, previousSnapshot, timeoutMs = 7000, debugCtx = null, shouldAbort = null) {
    const start = Date.now();
    let lastObserved = null;
    let lastChecks = null;
    let descGraceStartedAt = null;

    while (Date.now() - start < timeoutMs) {
      if (shouldAbort?.()) {
        return { isReady: false, abortedByWinner: true, lastObserved, lastChecks };
      }
      const currentVideoId = getVideoIdFromUrl();
      if (!currentVideoId || currentVideoId !== targetVideoId) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }

      // Fast path for reload/same-video navigations: do not wait for
      // change-based semantics when videoId is unchanged.
      if (previousSnapshot?.videoId && targetVideoId === previousSnapshot.videoId) {
        const quick = getMetaFromWindowObject();
        const quickTitle = normalizeMetaText(quick?.title || "");
        const quickDescription = normalizeMetaText(quick?.description || "");
        const quickDescriptionGeneric = isGenericYouTubeDescription(quickDescription);
        const quickReady = quickTitle.length >= 8 && (quickDescription.length === 0 || !quickDescriptionGeneric);

        if (quickReady) {
          if (debugCtx?.runId) {
            await emitEvalDebug({
              type: "stability-pass-same-video",
              runId: debugCtx.runId,
              reason: debugCtx.reason,
              targetVideoId,
              targetUrl: debugCtx.targetUrl,
              current: {
                url: debugCtx.targetUrl,
                videoId: targetVideoId,
                title: quickTitle,
                description: quickDescription,
                titleSource: quick?.titleSource || "",
                descriptionSource: quick?.descriptionSource || ""
              },
              previous: {
                url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
                videoId: previousSnapshot.videoId,
                title: normalizeMetaText(previousSnapshot.title),
                description: normalizeMetaText(previousSnapshot.description)
              },
              checks: {
                urlChanged: false,
                titleChanged: quickTitle !== normalizeMetaText(previousSnapshot.title),
                descriptionChanged: quickDescription !== normalizeMetaText(previousSnapshot.description),
                fastPath: true
              }
            });
          }
          return {
            isReady: true,
            videoId: targetVideoId,
            title: quickTitle,
            description: quickDescription,
            sourceVideoId: quick?.videoId || "",
            titleSource: quick?.titleSource || "",
            descriptionSource: quick?.descriptionSource || "",
            descriptionConfidence: quick?.description ? "runtime-high" : "dom-medium",
            sourceStrength: getSourceStrength(quick || {}),
            baselineWriteReason: "same-video-refresh"
          };
        }
      }

      const meta = await getVideoMetaStaged(targetVideoId, debugCtx, shouldAbort);
      if (meta?.abortedByWinner) {
        return { isReady: false, abortedByWinner: true, lastObserved, lastChecks };
      }
      lastObserved = meta
        ? {
            sourceVideoId: meta.sourceVideoId || "",
            title: normalizeMetaText(meta.title),
            description: normalizeMetaText(meta.description),
            titleSource: meta.titleSource || "",
            descriptionSource: meta.descriptionSource || "",
            descriptionConfidence: meta.descriptionConfidence || "unknown",
            isReady: !!meta.isReady
          }
        : null;
      if (!meta?.isReady) {
        if (debugCtx?.runId) {
          await emitEvalDebug({
            type: "meta-not-ready",
            runId: debugCtx.runId,
            reason: debugCtx.reason,
            targetVideoId,
            targetUrl: debugCtx.targetUrl,
            previous: previousSnapshot || null
          });
        }
        await new Promise((r) => setTimeout(r, 140));
        continue;
      }

      const title = normalizeMetaText(meta.title);
      const description = normalizeMetaText(meta.description);
      if (!title) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }

      // For the very first successful evaluation in a session/tab lifecycle,
      // there is no prior snapshot to compare against.
      if (!previousSnapshot?.videoId) {
        const sourceStrength = getSourceStrength(meta);
        if (debugCtx?.runId) {
          await emitEvalDebug({
            type: "stability-pass-no-previous",
            runId: debugCtx.runId,
            reason: debugCtx.reason,
            targetVideoId,
            targetUrl: debugCtx.targetUrl,
            sourceStrength,
            baselineWriteReason: "no-previous-strong-source",
            current: { url: debugCtx.targetUrl, videoId: targetVideoId, title, description },
            previous: null
          });
        }
        return { ...meta, title, description, videoId: targetVideoId, sourceStrength, baselineWriteReason: "no-previous-strong-source" };
      }

      const urlChanged = targetVideoId !== previousSnapshot.videoId;
      const titleChanged = title !== normalizeMetaText(previousSnapshot.title);
      const descriptionChanged = description !== normalizeMetaText(previousSnapshot.description);
      lastChecks = { urlChanged, titleChanged, descriptionChanged };

      if (!urlChanged) {
        if (debugCtx?.runId) {
          await emitEvalDebug({
            type: "stability-pass-same-video",
            runId: debugCtx.runId,
            reason: debugCtx.reason,
            targetVideoId,
            targetUrl: debugCtx.targetUrl,
            current: {
              url: debugCtx.targetUrl,
              videoId: targetVideoId,
              title,
              description,
              titleSource: meta.titleSource || "",
              descriptionSource: meta.descriptionSource || ""
            },
            previous: {
              url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
              videoId: previousSnapshot.videoId,
              title: normalizeMetaText(previousSnapshot.title),
              description: normalizeMetaText(previousSnapshot.description)
            },
            checks: { urlChanged, titleChanged, descriptionChanged }
          });
        }
        return { ...meta, title, description, videoId: targetVideoId, sourceStrength: getSourceStrength(meta), baselineWriteReason: "same-video-refresh" };
      }

      // New simplified gate:
      // - For same video: pass.
      // - For new video: URL+title are primary. Wait up to 250ms for description
      //   to change/populate, then proceed if description is not generic default.
      if (urlChanged && titleChanged) {
        const descriptionIsGeneric = isGenericYouTubeDescription(description);
        if (descriptionChanged && !descriptionIsGeneric) {
          descGraceStartedAt = null;
          if (debugCtx?.runId) {
            await emitEvalDebug({
              type: "stability-pass",
              runId: debugCtx.runId,
              reason: debugCtx.reason,
              targetVideoId,
              targetUrl: debugCtx.targetUrl,
              current: {
                url: debugCtx.targetUrl,
                videoId: targetVideoId,
                title,
                description,
                titleSource: meta.titleSource || "",
                descriptionSource: meta.descriptionSource || ""
              },
              previous: {
                url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
                videoId: previousSnapshot.videoId,
                title: normalizeMetaText(previousSnapshot.title),
                description: normalizeMetaText(previousSnapshot.description)
              },
              checks: { urlChanged, titleChanged, descriptionChanged, descriptionGraceUsed: false }
            });
          }
          return { ...meta, title, description, videoId: targetVideoId, sourceStrength: getSourceStrength(meta), baselineWriteReason: "strict-pass" };
        }

        if (!descGraceStartedAt) descGraceStartedAt = Date.now();
        const graceElapsed = Date.now() - descGraceStartedAt;
        if (graceElapsed >= 250 && !descriptionIsGeneric) {
          if (debugCtx?.runId) {
            await emitEvalDebug({
              type: "stability-pass-desc-grace",
              runId: debugCtx.runId,
              reason: debugCtx.reason,
              targetVideoId,
              targetUrl: debugCtx.targetUrl,
              current: {
                url: debugCtx.targetUrl,
                videoId: targetVideoId,
                title,
                description,
                titleSource: meta.titleSource || "",
                descriptionSource: meta.descriptionSource || ""
              },
              previous: {
                url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
                videoId: previousSnapshot.videoId,
                title: normalizeMetaText(previousSnapshot.title),
                description: normalizeMetaText(previousSnapshot.description)
              },
              checks: { urlChanged, titleChanged, descriptionChanged, descriptionGraceUsed: true, graceElapsedMs: graceElapsed }
            });
          }
          return { ...meta, title, description, videoId: targetVideoId, sourceStrength: getSourceStrength(meta), baselineWriteReason: "desc-grace-expired" };
        }
      } else {
        descGraceStartedAt = null;
      }

      if (urlChanged && titleChanged && descriptionChanged) {
        if (debugCtx?.runId) {
          await emitEvalDebug({
            type: "stability-pass",
            runId: debugCtx.runId,
            reason: debugCtx.reason,
            targetVideoId,
            targetUrl: debugCtx.targetUrl,
            current: {
              url: debugCtx.targetUrl,
              videoId: targetVideoId,
              title,
              description,
              titleSource: meta.titleSource || "",
              descriptionSource: meta.descriptionSource || ""
            },
            previous: {
              url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
              videoId: previousSnapshot.videoId,
              title: normalizeMetaText(previousSnapshot.title),
              description: normalizeMetaText(previousSnapshot.description)
            },
            checks: { urlChanged, titleChanged, descriptionChanged }
          });
        }
        return { ...meta, title, description, videoId: targetVideoId, sourceStrength: getSourceStrength(meta), baselineWriteReason: "strict-pass" };
      }

      if (debugCtx?.runId) {
        await emitEvalDebug({
          type: "stability-fail",
          runId: debugCtx.runId,
          reason: debugCtx.reason,
          targetVideoId,
          targetUrl: debugCtx.targetUrl,
          current: {
            url: debugCtx.targetUrl,
            videoId: targetVideoId,
            title,
            description,
            titleSource: meta.titleSource || "",
            descriptionSource: meta.descriptionSource || ""
          },
          previous: {
            url: `https://www.youtube.com/watch?v=${previousSnapshot.videoId}`,
            videoId: previousSnapshot.videoId,
            title: normalizeMetaText(previousSnapshot.title),
            description: normalizeMetaText(previousSnapshot.description)
          },
          checks: { urlChanged, titleChanged, descriptionChanged }
        });
      }

      await new Promise((r) => setTimeout(r, 160));
    }

    return { isReady: false, lastObserved, lastChecks };
  }

  function getIntentText(session) {
    if (!session?.id) return IntentGuardRelevance.buildIntentText(session);
    if (intentCache.has(session.id)) return intentCache.get(session.id);
    const text = IntentGuardRelevance.buildIntentText(session);
    intentCache.set(session.id, text);
    return text;
  }

  function getBgeIntentSessionSignature(session) {
    if (!session) return null;
    if (session.mode !== "learn") return `non-learn:${session.id || ""}`;
    return JSON.stringify({
      id: session.id || "",
      topic: session.learnAnswers?.topic || "",
      goal: session.learnAnswers?.goal || "",
      purposeReflection: session.learnAnswers?.purposeReflection || "",
      timingReflection: session.learnAnswers?.timingReflection || ""
    });
  }

  async function logCalibration(payload) {
    await send("LOG_CALIBRATION_EVENT", payload);
  }

  async function evaluateCurrentVideo(reason = "navigation", { coordinatorId = nextCoordinatorId() } = {}) {
    const runId = ++latestEvaluationRunId;
    const isStaleRun = () => runId !== latestEvaluationRunId;
    const resolutionEpochAtStart = evaluationResolutionEpoch;
    const isCancelledByWinner = () => evaluationResolutionEpoch !== resolutionEpochAtStart;
    let reloadFallbackTimer = null;
    const clearReloadFallbackTimer = () => {
      if (!reloadFallbackTimer) return;
      clearTimeout(reloadFallbackTimer);
      reloadFallbackTimer = null;
    };
    let pausedByThisRun = false;
    const restoreMediaIfPausedByThisRun = () => {
      if (!pausedByThisRun) return;
      unmuteAndResumeMedia();
      pausedByThisRun = false;
    };
    const targetUrl = location.href;
    const persistedSnapshot = !lastEvaluatedSnapshot ? await getPersistedLastSnapshot() : null;
    const effectivePreviousSnapshot = lastEvaluatedSnapshot || persistedSnapshot;
    const snapshotOrigin = lastEvaluatedSnapshot
      ? "local-memory"
      : persistedSnapshot
        ? "background-hydrated"
        : "none";
    const previousSnapshotAtRunStart = effectivePreviousSnapshot
      ? {
          videoId: effectivePreviousSnapshot.videoId,
          title: effectivePreviousSnapshot.title,
          description: effectivePreviousSnapshot.description
        }
      : null;

    // Defensive cleanup: each new run may clear transient evaluation UI, but
    // must not erase persistent decision blockers before a replacement verdict
    // is ready. Otherwise follow-up YouTube SPA events can briefly show and
    // immediately remove off-topic/borderline blockers.
    clearTransientEvaluationOverlays();

    if (!isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "coord-abort-not-active", runId, reason, coordinatorId, targetUrl, phase: "aborted" });
      return;
    }

    await emitEvalDebug({
      type: "evaluation-start",
      runId,
      reason,
      coordinatorId,
      phase: "collecting-meta",
      gateStartMs: Date.now(),
      targetUrl,
      snapshotOrigin,
      previous: previousSnapshotAtRunStart
        ? {
            url: `https://www.youtube.com/watch?v=${previousSnapshotAtRunStart.videoId}`,
            videoId: previousSnapshotAtRunStart.videoId,
            title: previousSnapshotAtRunStart.title,
            description: previousSnapshotAtRunStart.description
          }
        : null
    });

    const stateRes = await send("GET_STATE");
    if (isStaleRun()) return;
    const state = stateRes?.state;
    const activeSessionId = state?.activeSession?.id || null;
    const activeSessionSignature = getBgeIntentSessionSignature(state?.activeSession);
    if (activeSessionId !== lastBgeIntentSessionId || activeSessionSignature !== lastBgeIntentSessionSignature) {
      intentCache.clear();
      globalThis.IntentGuardBGE?.clearIntentEmbeddingCache?.();
      lastBgeIntentSessionId = activeSessionId;
      lastBgeIntentSessionSignature = activeSessionSignature;
    }
    const reloadFallbackAfterMs = Math.round(Math.min(15000, Math.max(500, Number(state?.settings?.reloadFallbackAfterMs) || DEFAULT_RELOAD_FALLBACK_AFTER_MS)));
    const metaGateTimeoutMs = Math.round(Math.min(15000, Math.max(1000, Number(state?.settings?.metaGateTimeoutMs) || DEFAULT_META_GATE_TIMEOUT_MS)));

    if (!state?.activeSession) {
      pauseAndMuteMedia();
      await renderSessionTypeBlocker();
      if (isStaleRun()) return;
      return;
    }

    if (isRelaxSessionExpired(state.activeSession)) {
      await renderExpiredRelaxSessionBlockerFullscreenSafe(state.activeSession);
      return;
    }

    if (state.activeSession.mode === "learn") {
      if (applyLearnSearchRedirect(state.activeSession)) return;
    }

    if (!isWatchPage() && !isShortsPage()) {
      removeOverlay();
      unmuteAndResumeMedia();
      return;
    }

    if (state.activeSession.mode !== "learn") {
      if (isShortsPage()) {
        await emitEvalDebug({
          type: "relax-shorts-allowed",
          runId,
          reason,
          targetUrl,
          targetVideoId: getVideoIdFromUrl() || ""
        });
      }
      removeOverlay();
      unmuteAndResumeMedia();
      return;
    }

    if (isShortsPage()) {
      const shortsVideoId = getVideoIdFromUrl();
      const watchUrl = buildWatchUrlFromVideoId(shortsVideoId);
      pauseAndMuteMedia();
      pausedByThisRun = true;
      await emitEvalDebug({
        type: "learn-shorts-blocked",
        runId,
        reason,
        targetUrl,
        targetVideoId: shortsVideoId || "",
        watchUrl
      });
      await renderOverlay(`
        <div class="ig-card">
          <h2 class="ig-title">Shorts are blocked in Learn mode</h2>
          <p class="ig-copy">To stay focused on learning, Shorts are disabled in Learn mode. You can go back, or open this video in normal player mode.</p>
          <div class="ig-actions">
            <button id="ig-go-back" class="ig-btn ig-btn-primary">Go back</button>
            <button id="ig-open-normal-player" class="ig-btn">Watch short in normal player mode</button>
          </div>
        </div>
      `);
      if (isStaleRun()) return;
      document.getElementById("ig-go-back")?.addEventListener("click", handleGoBackNavigation);
      document.getElementById("ig-open-normal-player")?.addEventListener("click", () => location.assign(watchUrl));
      return;
    }

    const videoId = getVideoIdFromUrl();
    if (!videoId) return;

    const nowMs = Date.now();
    const hasAppliedDecisionForCurrentVideo =
      appliedDecisionLock?.videoId === videoId &&
      appliedDecisionLock?.sessionId === activeSessionId &&
      appliedDecisionLock?.sessionSignature === activeSessionSignature;
    if (hasAppliedDecisionForCurrentVideo) {
      const elapsedSinceAppliedDecision = nowMs - Number(appliedDecisionLock?.appliedAt || 0);
      await emitEvalDebug({
        type: "evaluation-skipped-current-decision-lock",
        runId,
        reason,
        coordinatorId,
        targetUrl,
        targetVideoId: videoId,
        checks: {
          elapsedSinceAppliedDecision,
          appliedDecisionLockVideoId: appliedDecisionLock.videoId,
          appliedDecisionLockVerdict: appliedDecisionLock.verdict,
          appliedDecisionLockSessionId: appliedDecisionLock.sessionId || "",
          activeSessionId: activeSessionId || "",
          skipReason: "current-video-decision-lock"
        }
      });
      return;
    }

    reloadFallbackTimer = setTimeout(() => {
      if (isStaleRun() || !isActiveCoordinator(coordinatorId) || isCancelledByWinner()) return;
      if (!isWatchPage()) return;
      if (getVideoIdFromUrl() !== videoId) return;
      if (!canUseReloadFallbackForVideo(videoId)) return;
      markReloadFallbackUsed(videoId);
      emitEvalDebug({
        type: "reload-fallback-triggered",
        runId,
        reason,
        coordinatorId,
        targetUrl,
        targetVideoId: videoId,
        checks: { fallbackAfterMs: reloadFallbackAfterMs }
      }).finally(() => {
        location.reload();
      });
    }, reloadFallbackAfterMs);

    // NOTE: allowlist functionality is temporarily disabled.
    // const approvedVideoIds = new Set(state.activeSession?.approvedVideoIds || []);
    // if (approvedVideoIds.has(videoId)) {
    //   removeOverlay();
    //   removeOverlay("intent-guard-loading");
    //   removeOverlay("intent-guard-borderline");
    //   unmuteAndResumeMedia();
    //   activeEvaluationVideoId = videoId;
    //   return;
    // }

    if (isShortsPage()) {
      trackShortsUrl(location.href);
      if (videoId !== activeShortsKey) {
        activeShortsKey = videoId;
      }
    }

    pauseAndMuteMedia();
    pausedByThisRun = true;
    await renderOverlay(`
      <div class="ig-card">
        <h2 class="ig-title">Checking relevance…</h2>
        <p class="ig-copy">Comparing this video to your learning goal.</p>
      </div>
    `, "intent-guard-loading");
    if (isStaleRun() || !isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "abort-stale-run-after-loading", runId, reason, targetUrl, targetVideoId: videoId });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    // Strict BGE-only validation mode:
    // - Legacy scorers are intentionally disabled for decisioning.
    // - If BGE is unavailable or errors, we fail closed.
    const strictBgeOnlyMode = true;
    try {
      await Promise.race([
        globalThis.IntentGuardBGELoaded || Promise.resolve(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("bge-module-load-timeout")), 5000))
      ]);
    } catch (err) {
      await emitEvalDebug({
        type: "bge-module-load-error",
        runId,
        reason,
        targetUrl,
        targetVideoId: videoId,
        checks: { error: String(err?.message || err || "unknown") }
      });
    }
    globalThis.IntentGuardBGE?.warmup?.();
    const meta = await waitForNavigationStability(videoId, previousSnapshotAtRunStart, metaGateTimeoutMs, {
      runId,
      reason,
      targetUrl,
      coordinatorId
    }, () => isStaleRun() || !isActiveCoordinator(coordinatorId) || isCancelledByWinner());
    if (meta?.abortedByWinner || isCancelledByWinner()) {
      await emitEvalDebug({ type: "run-cancelled-after-winner", runId, reason, targetUrl, targetVideoId: videoId, coordinatorId });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }
    if (isStaleRun() || !isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "abort-stale-run-after-meta", runId, reason, targetUrl, targetVideoId: videoId });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    const currentVideoIdAfterMeta = getVideoIdFromUrl();
    if (currentVideoIdAfterMeta && currentVideoIdAfterMeta !== videoId) {
      await emitEvalDebug({
        type: "abort-url-mismatch-after-meta",
        runId,
        reason,
        targetUrl,
        targetVideoId: videoId,
        currentVideoIdAfterMeta
      });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    if (meta?.sourceVideoId && videoId && meta.sourceVideoId !== videoId) {
      await emitEvalDebug({ type: "meta-id-mismatch-no-score", runId, reason, coordinatorId, targetUrl, targetVideoId: videoId, sourceVideoId: meta.sourceVideoId, phase: "gate-timeout" });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    if (!meta?.isReady) {
      await emitEvalDebug({
        type: "meta-gate-timeout",
        runId,
        reason,
        coordinatorId,
        targetUrl,
        targetVideoId: videoId,
        current: meta?.lastObserved
          ? {
              url: targetUrl,
              videoId,
              sourceVideoId: meta.lastObserved.sourceVideoId,
              title: meta.lastObserved.title,
              description: meta.lastObserved.description,
              titleSource: meta.lastObserved.titleSource,
              descriptionSource: meta.lastObserved.descriptionSource,
              metaReady: meta.lastObserved.isReady
            }
          : null,
        previous: previousSnapshotAtRunStart
          ? {
              url: `https://www.youtube.com/watch?v=${previousSnapshotAtRunStart.videoId}`,
              videoId: previousSnapshotAtRunStart.videoId,
              title: normalizeMetaText(previousSnapshotAtRunStart.title),
              description: normalizeMetaText(previousSnapshotAtRunStart.description)
            }
          : null,
        checks: meta?.lastChecks || null,
        phase: "gate-timeout",
        note: "Strict URL/title/description change gate did not pass before timeout."
      });
      clearLoadingOverlay();
      await renderOverlay(`
        <div class="ig-card">
          <h2 class="ig-title">Metadata gate timeout</h2>
          <p class="ig-copy">This navigation did not satisfy strict URL + title + description change conditions in time. No scoring was performed.</p>
        </div>
      `, "intent-guard-loading");
      const timeoutCoordinatorId = coordinatorId;
      setTimeout(() => {
        if (isActiveCoordinator(timeoutCoordinatorId)) removeOverlay("intent-guard-loading");
      }, 900);
      unmuteAndResumeMedia();
      return;
    }

    if (!isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "coord-abort-before-snapshot-write", runId, reason, coordinatorId, targetUrl, phase: "aborted" });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    // Owner-token guard: only the currently active coordinator is allowed to
    // write the "lastEvaluatedSnapshot" baseline used by future comparisons.
    // Accessible mental model: the latest coordinator is the "designated note taker".
    // Older coordinators may still finish async work, but they cannot overwrite the notes.
    lastEvaluatedSnapshot = {
      videoId,
      title: meta.title,
      description: meta.description
    };
    await setPersistedLastSnapshot(lastEvaluatedSnapshot);

    const intentText = getIntentText(state.activeSession);
    const videoText = IntentGuardRelevance.buildVideoText(meta);

    let semanticBge = null;
    try {
      semanticBge = await globalThis.IntentGuardBGE?.scoreIntentVsVideo?.(intentText, videoText, {
        sessionId: state.activeSession.id
      });
    } catch (err) {
      await emitEvalDebug({
        type: "bge-score-error",
        runId,
        reason,
        targetUrl,
        targetVideoId: videoId,
        checks: {
          strictBgeOnlyMode,
          error: String(err?.message || err || "unknown")
        }
      });
    }

    if (!semanticBge || typeof semanticBge.semanticScore !== "number") {
      await emitEvalDebug({
        type: "bge-unavailable-fail-closed",
        runId,
        reason,
        targetUrl,
        targetVideoId: videoId,
        checks: {
          strictBgeOnlyMode,
          hasIntentGuardBGE: !!globalThis.IntentGuardBGE,
          hasScoreFunction: typeof globalThis.IntentGuardBGE?.scoreIntentVsVideo === "function"
        }
      });
      clearLoadingOverlay();
      await renderOverlay(`
        <div class="ig-card">
          <h2 class="ig-title">Relevance engine unavailable</h2>
          <p class="ig-copy">BGE semantic engine is unavailable in strict validation mode, so this video is blocked by policy. Please initialize BGE and try again.</p>
        </div>
      `);
      clearReloadFallbackTimer();
      restoreMediaIfPausedByThisRun();
      markDecisionApplied(videoId, "blocked-bge-unavailable", {
        sessionId: activeSessionId,
        sessionSignature: activeSessionSignature
      });
      return;
    }

    const semanticLegacy = { semanticScore: Number.NaN, elapsedMs: 0 };
    const semanticEmbedding = { semanticScore: Number.NaN, elapsedMs: 0 };
    const activeSemantic = semanticBge;
    const profile = IntentGuardRelevance.buildIntentProfile(state.activeSession);
    const keywordDiag = IntentGuardRelevance.scoreVideoKeywordDiagnostic(meta, profile);
    const relevantMin = state.settings?.semanticRelevantMin ?? 0.6;
    const borderlineMin = state.settings?.semanticBorderlineMin ?? 0.55;
    const verdict = IntentGuardRelevance.classifySemanticScore(activeSemantic.semanticScore, state.settings);
    const intentTextNormalized = globalThis.IntentGuardBGE?.normalize
      ? globalThis.IntentGuardBGE.normalize(intentText)
      : String(intentText || "").trim();
    const videoTextNormalized = globalThis.IntentGuardBGE?.normalize
      ? globalThis.IntentGuardBGE.normalize(videoText)
      : String(videoText || "").trim();
    const intentHash = simpleHash(intentTextNormalized);
    const videoHash = simpleHash(videoTextNormalized);
    await emitEvalDebug({
      type: "evaluation-complete",
      runId,
      reason,
      targetUrl,
      targetVideoId: videoId,
      current: { url: targetUrl, videoId, title: meta.title, description: meta.description },
      previous: previousSnapshotAtRunStart
        ? {
            url: `https://www.youtube.com/watch?v=${previousSnapshotAtRunStart.videoId}`,
            videoId: previousSnapshotAtRunStart.videoId,
            title: previousSnapshotAtRunStart.title,
            description: previousSnapshotAtRunStart.description
          }
        : null,
      verdict,
      semanticScore: activeSemantic.semanticScore,
      semanticScores: {
        activeSource: "bge-strict",
        bge: semanticBge.semanticScore,
        embedding: semanticEmbedding.semanticScore,
        legacy: semanticLegacy.semanticScore
      },
      semanticLatencyMs: {
        bge: semanticBge.elapsedMs,
        embedding: semanticEmbedding.elapsedMs,
        legacy: semanticLegacy.elapsedMs
      },
      snapshotOrigin,
      baselineWriteReason: meta?.baselineWriteReason || "strict-pass",
      sourceStrength: meta?.sourceStrength || getSourceStrength(meta || {}),
      thresholds: { relevantMin, borderlineMin },
      scoreInputs: {
        intentTextRaw: intentText,
        videoTextRaw: videoText,
        intentTextNormalized,
        videoTextNormalized,
        intentHash,
        videoHash,
        titleSource: meta.titleSource || "",
        descriptionSource: meta.descriptionSource || "",
        descriptionConfidence: meta.descriptionConfidence || "unknown"
      }
    });
    if (isStaleRun() || !isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "abort-stale-run-after-scoring", runId, reason, targetUrl, targetVideoId: videoId });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    // Ownership guard: if URL changed to a different video while this run was computing,
    // drop this result and let the latest run render.
    const currentVideoIdAtRender = getVideoIdFromUrl();
    if (currentVideoIdAtRender && currentVideoIdAtRender !== videoId) {
      await emitEvalDebug({
        type: "abort-url-mismatch-before-render",
        runId,
        reason,
        targetUrl,
        targetVideoId: videoId,
        currentVideoIdAtRender
      });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    clearLoadingOverlay();

    await logCalibration({
      videoId,
      reason,
      mode: "learn",
      semanticScore: activeSemantic.semanticScore,
      semanticScores: {
        activeSource: "bge-strict",
        bge: semanticBge.semanticScore,
        embedding: semanticEmbedding.semanticScore,
        legacy: semanticLegacy.semanticScore
      },
      keywordScore: keywordDiag.keywordScore,
      verdict,
      latencyMs: activeSemantic.elapsedMs,
      topic: state.activeSession.learnAnswers?.topic || "",
      goal: state.activeSession.learnAnswers?.goal || "",
      titlePreview: (meta.title || "").slice(0, 180),
      descriptionPreview: (meta.description || "").slice(0, 220)
    });
    if (isStaleRun() || !isActiveCoordinator(coordinatorId)) {
      await emitEvalDebug({ type: "abort-stale-run-after-calibration-log", runId, reason, targetUrl, targetVideoId: videoId });
      clearLoadingOverlay();
      restoreMediaIfPausedByThisRun();
      return;
    }

    if (verdict === "relevant") {
      // NOTE: allowlist functionality is temporarily disabled.
      // await approveCurrentVideo(videoId);
      removeOverlay();
      unmuteAndResumeMedia();
      clearReloadFallbackTimer();
      markDecisionApplied(videoId, verdict, {
        sessionId: activeSessionId,
        sessionSignature: activeSessionSignature
      });
      return;
    }

    const escapedGoal = escapeHtml(state.activeSession.learnAnswers.goal || "(none)");
    const escapedVideoTitle = escapeHtml(meta.title || "(unknown video)");

    if (verdict === "borderline") {
      await renderOverlay(`
        <div class="ig-card">
          <h2 class="ig-title">Borderline relevance</h2>
          <p class="ig-copy">Is this worth your time for your goal: <strong>${escapedGoal}</strong>?<br/>Video: <strong>${escapedVideoTitle}</strong><br/>Relevance score: ${semanticBge.semanticScore.toFixed(3)}</p>
          <div class="ig-actions">
            <button id="ig-continue" class="ig-btn ig-btn-primary">Continue anyway</button>
            <button id="ig-borderline-back" class="ig-btn">Go back</button>
          </div>
        </div>
      `, "intent-guard-borderline");
      if (isStaleRun()) return;

      document.getElementById("ig-continue")?.addEventListener("click", () => removeOverlay("intent-guard-borderline"));
      document.getElementById("ig-continue")?.addEventListener("click", async () => {
        // NOTE: allowlist functionality is temporarily disabled.
        // await approveCurrentVideo(videoId);
        unmuteAndResumeMedia();
      });
      document.getElementById("ig-borderline-back")?.addEventListener("click", handleGoBackNavigation);
      clearReloadFallbackTimer();
      markDecisionApplied(videoId, verdict, {
        sessionId: activeSessionId,
        sessionSignature: activeSessionSignature
      });
      return;
    }

    await renderOverlay(`
      <div class="ig-card">
        <h2 class="ig-title">This video looks off-topic</h2>
        <p class="ig-copy"><strong>Goal:</strong> ${escapedGoal}<br/>Choose content that better aligns with your learning intent.<br/>Relevance score: ${semanticBge.semanticScore.toFixed(3)}</p>
        <div class="ig-actions">
          <button id="ig-back" class="ig-btn ig-btn-primary">Go back</button>
        </div>
      </div>
    `);
    if (isStaleRun()) return;

    document.getElementById("ig-back")?.addEventListener("click", handleGoBackNavigation);
    clearReloadFallbackTimer();
    markDecisionApplied(videoId, verdict, {
      sessionId: activeSessionId,
      sessionSignature: activeSessionSignature
    });
  }

  function attachSpaListeners() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener("yt-navigate-finish", () => scheduleNavigationEvaluation("yt-navigate-finish"));
    window.addEventListener("popstate", () => scheduleNavigationEvaluation("popstate"));

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const out = originalPushState.apply(this, args);
      scheduleNavigationEvaluation("pushstate", 80);
      return out;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const out = originalReplaceState.apply(this, args);
      scheduleNavigationEvaluation("replacestate", 80);
      return out;
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "RELAX_SESSION_EXPIRED") return false;

    (async () => {
      const result = await showExpiredRelaxSessionNow(message.payload?.session || null);
      sendResponse(result);
    })();

    return true;
  });

  attachSpaListeners();
  scheduleNavigationEvaluation("initial", 30);
})();
