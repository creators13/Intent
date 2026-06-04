const send = (type, payload = {}) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

let debugPollTimer = null;
let activeSession = null;

const STRICT_MIN = 0.05;
const STRICT_MAX = 0.2;
const RELAX_TEXT_MIN_NON_WHITESPACE = 10;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sliderToRelevant(sliderValue) {
  const t = clamp(Number(sliderValue) / 100, 0, 1);
  return Number((STRICT_MAX - (STRICT_MAX - STRICT_MIN) * t).toFixed(3));
}

function relevantToSlider(relevantMin) {
  const r = clamp(Number(relevantMin), STRICT_MIN, STRICT_MAX);
  const t = (STRICT_MAX - r) / (STRICT_MAX - STRICT_MIN);
  return Math.round(clamp(t, 0, 1) * 100);
}

function renderStrictnessSummary(relevantMin) {
  const el = document.getElementById("strictness-summary");
  if (!el) return;
  const rel = Number(relevantMin).toFixed(3);
  const border = Number((Number(relevantMin) * 0.5).toFixed(3)).toFixed(3);
  el.textContent = `Relevant cutoff: ${rel} · Borderline cutoff: ${border}`;
}

async function loadEvaluationSettings() {
  const res = await send("GET_STATE");
  const settings = res?.state?.settings || {};
  const reloadSec = (Number(settings.reloadFallbackAfterMs) || 3000) / 1000;
  const timeoutSec = (Number(settings.metaGateTimeoutMs) || 5000) / 1000;
  const relevantMin = Number(settings.semanticRelevantMin) || 0.08;

  const reloadInput = document.getElementById("reload-wait-seconds");
  const timeoutInput = document.getElementById("meta-timeout-seconds");
  const slider = document.getElementById("strictness-slider");

  if (reloadInput) reloadInput.value = String(reloadSec);
  if (timeoutInput) timeoutInput.value = String(timeoutSec);
  if (slider) slider.value = String(relevantToSlider(relevantMin));
  renderStrictnessSummary(relevantMin);
}

async function saveEvaluationSettings() {
  const reloadSec = Number(value("reload-wait-seconds") || 3);
  const timeoutSec = Number(value("meta-timeout-seconds") || 5);
  const slider = document.getElementById("strictness-slider");
  const relevantMin = sliderToRelevant(Number(slider?.value || 80));

  await send("UPDATE_EVALUATION_SETTINGS", {
    relevantMin,
    reloadFallbackAfterMs: Math.round(clamp(reloadSec, 0.5, 15) * 1000),
    metaGateTimeoutMs: Math.round(clamp(timeoutSec, 1, 15) * 1000)
  });

  await loadEvaluationSettings();
}

function value(id) {
  return document.getElementById(id)?.value?.trim();
}

function setValue(id, value = "") {
  const el = document.getElementById(id);
  if (el) el.value = value ?? "";
}

function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = !!hidden;
}

function setCardTitle(cardId, text) {
  const title = document.querySelector(`#${cardId} h2`);
  if (title) title.textContent = text;
}

function nonWhitespaceLength(text = "") {
  return String(text || "").replace(/\s/g, "").length;
}

function clearPopupError() {
  const error = document.getElementById("popup-error");
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
  document.querySelectorAll(".input-error").forEach((el) => el.classList.remove("input-error"));
}

function showPopupError(message, fieldId = null) {
  const error = document.getElementById("popup-error");
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  document.querySelectorAll(".input-error").forEach((el) => el.classList.remove("input-error"));
  const field = fieldId ? document.getElementById(fieldId) : null;
  if (field) {
    field.classList.add("input-error");
    field.focus();
  }
}

function validateLearnPayload(payload) {
  if (!payload.learnAnswers.topic) {
    return { ok: false, message: "Please enter the topic(s) you want to learn.", fieldId: "learn-topic" };
  }
  if (!payload.learnAnswers.goal) {
    return { ok: false, message: "Please enter your goal for this session.", fieldId: "learn-goal" };
  }
  return { ok: true };
}

function validateRelaxPayload(payload) {
  const fields = [
    ["currentFeel", "relax-current", "how you currently feel"],
    ["desiredFeel", "relax-want", "how you want to feel"],
    ["alternativesNow", "relax-other", "what else can help you now"],
    ["tomorrowNeed", "relax-tomorrow", "what you need to do to make sure you feel good tomorrow"],
    ["durationWhy", "relax-why", "why this is the right length for you"]
  ];

  for (const [key, fieldId, label] of fields) {
    if (nonWhitespaceLength(payload.relaxAnswers[key]) < RELAX_TEXT_MIN_NON_WHITESPACE) {
      return {
        ok: false,
        message: `Please elaborate more on ${label}.`,
        fieldId
      };
    }
  }

  return { ok: true };
}

function formatRemainingTime(endTime) {
  const remainingMs = Math.max(0, Number(endTime || 0) - Date.now());
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes <= 0) return "Time remaining: less than 1 min";
  return `Time remaining: ${minutes} min`;
}

function buildLearnPayload() {
  return {
    mode: "learn",
    learnAnswers: {
      topic: value("learn-topic"),
      goal: value("learn-goal"),
      purposeReflection: value("learn-purpose"),
      timingReflection: value("learn-timing")
    }
  };
}

function buildRelaxPayload({ includeDuration = true } = {}) {
  const relaxAnswers = {
    currentFeel: value("relax-current"),
    desiredFeel: value("relax-want"),
    alternativesNow: value("relax-other"),
    tomorrowNeed: value("relax-tomorrow"),
    durationWhy: value("relax-why")
  };

  if (includeDuration) {
    relaxAnswers.durationMinutes = Number(value("relax-duration") || 30);
  }

  return {
    mode: "relax",
    relaxAnswers
  };
}

function short(text = "", max = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function renderDebugPanel(data) {
  const panel = document.getElementById("eval-debug");
  if (!panel) return;
  const cur = data?.currentWinner || data?.current || data?.lastEvent;
  const lastEvent = data?.lastEvent || null;
  if (!cur) {
    panel.textContent = "No debug event yet. Trigger a new video evaluation to populate this panel.";
    return;
  }

  const previous = cur.previous || {};
  const current = cur.current || {};
  const checks = cur.checks || {};

  panel.textContent = [
    `type: ${cur.type || ""}`,
    `runId: ${cur.runId ?? ""}`,
    `reason: ${cur.reason || ""}`,
    `loggedAtIso: ${cur.loggedAtIso || ""}`,
    `viewMode: ${data?.currentWinner ? "winner" : "last-event"}`,
    `lastEventType: ${lastEvent?.type || ""}`,
    `lastEventRunId: ${lastEvent?.runId ?? ""}`,
    `targetUrl: ${cur.targetUrl || cur.urlKey || ""}`,
    "",
    "[CURRENT]",
    `url: ${current.url || cur.targetUrl || cur.pageUrl || ""}`,
    `videoId: ${current.videoId || cur.targetVideoId || cur.pageVideoId || ""}`,
    `title: ${short(current.title)}`,
    `description: ${short(current.description)}`,
    `titleSource: ${current.titleSource || ""}`,
    `descriptionSource: ${current.descriptionSource || ""}`,
    "",
    "[PREVIOUS]",
    `url: ${previous.url || ""}`,
    `videoId: ${previous.videoId || ""}`,
    `title: ${short(previous.title)}`,
    `description: ${short(previous.description)}`,
    "",
    "[CHECKS]",
    `urlChanged: ${checks.urlChanged ?? ""}`,
    `titleChanged: ${checks.titleChanged ?? ""}`,
    `descriptionChanged: ${checks.descriptionChanged ?? ""}`,
    `titleReady: ${checks.titleReady ?? ""}`,
    `descriptionReady: ${checks.descriptionReady ?? ""}`,
    `objectIdMatches: ${checks.objectIdMatches ?? ""}`,
    `attempt: ${checks.attempt ?? ""}`,
    "",
    `sourceVideoId: ${cur.sourceVideoId || ""}`,
    `pageUrl: ${cur.pageUrl || ""}`,
    `pageVideoId: ${cur.pageVideoId || ""}`
  ].join("\n");
}

function formatScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function buildEvaluationRows(data) {
  const logsByUrl = data?.logsByUrl || {};
  const allEvents = [];
  for (const events of Object.values(logsByUrl)) {
    if (Array.isArray(events)) allEvents.push(...events);
  }

  allEvents.sort((a, b) => (b?.emittedAtMs || 0) - (a?.emittedAtMs || 0));

  const byVideoId = new Map();
  for (const e of allEvents) {
    const cur = e.current || {};
    const videoId = cur.videoId || e.targetVideoId || e.pageVideoId || "";
    if (!videoId) continue;
    const existing = byVideoId.get(videoId) || {
      loggedAtIso: "",
      url: "",
      title: "",
      description: "",
      bge: null
    };

    if (!existing.loggedAtIso) existing.loggedAtIso = e.loggedAtIso || "";
    if (!existing.url) existing.url = cur.url || e.targetUrl || e.pageUrl || "";
    if (!existing.title) existing.title = cur.title || "";
    if (!existing.description) existing.description = cur.description || "";

    if (e?.type === "evaluation-complete") {
      const scores = e.semanticScores || {};
      existing.bge = Number.isFinite(scores.bge) ? scores.bge : e.semanticScore;
      existing.url = cur.url || e.targetUrl || e.pageUrl || existing.url;
      existing.title = cur.title || existing.title;
      existing.description = cur.description || existing.description;
    }

    byVideoId.set(videoId, existing);
  }

  return Array.from(byVideoId.values()).map((row) => ({
    ...row,
    title: short(row.title || "", 120),
    description: short(row.description || "", 180)
  }));
}

function renderVideoTraceTable(data) {
  const root = document.getElementById("video-trace");
  if (!root) return;
  const rows = buildEvaluationRows(data);
  if (!rows.length) {
    root.textContent = "No evaluation-complete events yet.";
    return;
  }

  const header = `
    <thead>
      <tr>
        <th>Time</th>
        <th>URL</th>
        <th>Title</th>
        <th>Description</th>
        <th>BGE Score</th>
      </tr>
    </thead>
  `;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td>${r.loggedAtIso || ""}</td>
        <td class="trace-cell-url">${r.url || ""}</td>
        <td class="trace-cell-title">${r.title || ""}</td>
        <td class="trace-cell-desc">${r.description || ""}</td>
        <td>${formatScore(r.bge)}</td>
      </tr>
    `
    )
    .join("");

  root.innerHTML = `<table class="trace-table">${header}<tbody>${body}</tbody></table>`;
}

async function refreshEvalDebug() {
  const res = await send("GET_EVAL_DEBUG");
  const debug = res?.evaluationDebug || null;
  renderDebugPanel(debug);
  renderVideoTraceTable(debug);
}

async function exportDebugLogs() {
  const res = await send("GET_EVAL_DEBUG");
  const payload = {
    exportedAtIso: new Date().toISOString(),
    evaluationDebug: res?.evaluationDebug || null
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `intent-guard-eval-debug-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function clearDebugLogs() {
  await send("CLEAR_EVAL_DEBUG_LOGS");
  await refreshEvalDebug();
}

async function refreshStatus() {
  const res = await send("GET_STATE");
  const session = res?.state?.activeSession;
  activeSession = session || null;
  const status = document.getElementById("status");

  if (!session) {
    status.textContent = "No active session";
    setHidden("learn-card", false);
    setHidden("relax-card", false);
    setHidden("relax-duration-field", false);
    setHidden("relax-time-remaining", true);
    setCardTitle("learn-card", "Start Learn Session");
    setCardTitle("relax-card", "Start Relax Session");
    const learnButton = document.getElementById("start-learn");
    const relaxButton = document.getElementById("start-relax");
    if (learnButton) learnButton.textContent = "Start Learn Session";
    if (relaxButton) relaxButton.textContent = "Start Relax Session";
    return;
  }

  if (session.mode === "learn") {
    status.textContent = `Active Learn session: ${session.learnAnswers.topic}`;
    setHidden("learn-card", false);
    setHidden("relax-card", true);
    setCardTitle("learn-card", "Edit Learn Session");
    const learnButton = document.getElementById("start-learn");
    if (learnButton) learnButton.textContent = "Save Changes";
    setValue("learn-topic", session.learnAnswers?.topic || "");
    setValue("learn-goal", session.learnAnswers?.goal || "");
    setValue("learn-purpose", session.learnAnswers?.purposeReflection || "");
    setValue("learn-timing", session.learnAnswers?.timingReflection || "");
  } else {
    const minsLeft = Math.max(0, Math.round((session.endTime - Date.now()) / 60_000));
    status.textContent = `Active Relax session: ${minsLeft} min left`;
    setHidden("learn-card", true);
    setHidden("relax-card", false);
    setHidden("relax-duration-field", true);
    setHidden("relax-time-remaining", false);
    setCardTitle("relax-card", "Edit Relax Session");
    const relaxButton = document.getElementById("start-relax");
    const remaining = document.getElementById("relax-time-remaining");
    if (relaxButton) relaxButton.textContent = "Save Changes";
    if (remaining) remaining.textContent = formatRemainingTime(session.endTime);
    setValue("relax-current", session.relaxAnswers?.currentFeel || "");
    setValue("relax-want", session.relaxAnswers?.desiredFeel || "");
    setValue("relax-other", session.relaxAnswers?.alternativesNow || "");
    setValue("relax-tomorrow", session.relaxAnswers?.tomorrowNeed || "");
    setValue("relax-duration", session.relaxAnswers?.durationMinutes || "");
    setValue("relax-why", session.relaxAnswers?.durationWhy || "");
  }
}

document.getElementById("start-learn")?.addEventListener("click", async () => {
  const payload = buildLearnPayload();
  const validation = validateLearnPayload(payload);
  if (!validation.ok) {
    showPopupError(validation.message, validation.fieldId);
    return;
  }
  clearPopupError();
  const res = await send(activeSession?.mode === "learn" ? "UPDATE_ACTIVE_SESSION" : "START_SESSION", payload);
  if (!res?.ok) {
    showPopupError(res?.error || "Could not save Learn session.");
    return;
  }
  window.close();
});

document.getElementById("start-relax")?.addEventListener("click", async () => {
  const editingRelax = activeSession?.mode === "relax";
  const payload = buildRelaxPayload({ includeDuration: !editingRelax });
  const validation = validateRelaxPayload(payload);
  if (!validation.ok) {
    showPopupError(validation.message, validation.fieldId);
    return;
  }
  clearPopupError();
  const res = await send(editingRelax ? "UPDATE_ACTIVE_SESSION" : "START_SESSION", payload);
  if (!res?.ok) {
    showPopupError(res?.error || "Could not save Relax session.");
    return;
  }
  window.close();
});

document.getElementById("end-session")?.addEventListener("click", async () => {
  await send("END_SESSION", {
    completionCheck: { note: "Ended manually from popup." }
  });
  await send("CLEAR_EVAL_DEBUG_LOGS");
  await refreshEvalDebug();
  await refreshStatus();
});

document.getElementById("open-dashboard")?.addEventListener("click", async () => {
  await send("OPEN_DASHBOARD");
});

document.getElementById("export-debug-logs")?.addEventListener("click", exportDebugLogs);
document.getElementById("clear-debug-logs")?.addEventListener("click", clearDebugLogs);
document.getElementById("save-eval-settings")?.addEventListener("click", saveEvaluationSettings);
document.getElementById("strictness-slider")?.addEventListener("input", (e) => {
  renderStrictnessSummary(sliderToRelevant(e.target.value));
});

refreshStatus();
refreshEvalDebug();
loadEvaluationSettings();
debugPollTimer = setInterval(refreshEvalDebug, 350);
window.addEventListener("beforeunload", () => {
  if (debugPollTimer) clearInterval(debugPollTimer);
});
