const send = (type, payload = {}) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

let debugPollTimer = null;

const STRICT_MIN = 0.05;
const STRICT_MAX = 0.2;

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
  const status = document.getElementById("status");

  if (!session) {
    status.textContent = "No active session";
    return;
  }

  if (session.mode === "learn") {
    status.textContent = `Active Learn session: ${session.learnAnswers.topic}`;
  } else {
    const minsLeft = Math.max(0, Math.round((session.endTime - Date.now()) / 60_000));
    status.textContent = `Active Relax session: ${minsLeft} min left`;
  }
}

document.getElementById("start-learn")?.addEventListener("click", async () => {
  const payload = {
    mode: "learn",
    learnAnswers: {
      topic: value("learn-topic"),
      goal: value("learn-goal"),
      purposeReflection: value("learn-purpose"),
      timingReflection: value("learn-timing")
    }
  };
  await send("START_SESSION", payload);
  await refreshStatus();
});

document.getElementById("start-relax")?.addEventListener("click", async () => {
  const payload = {
    mode: "relax",
    relaxAnswers: {
      currentFeel: value("relax-current"),
      desiredFeel: value("relax-want"),
      alternativesNow: value("relax-other"),
      tomorrowNeed: value("relax-tomorrow"),
      durationMinutes: Number(value("relax-duration") || 30),
      durationWhy: value("relax-why")
    }
  };
  await send("START_SESSION", payload);
  await refreshStatus();
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
