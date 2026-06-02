const send = (type, payload = {}) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

async function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get("intentGuardState", (result) => {
      resolve(result.intentGuardState || null);
    });
  });
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function recommendThresholds(events) {
  const scores = events
    .map((e) => e.semanticScore)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);

  if (scores.length < 15) return null;

  const borderlineMin = Number((quantile(scores, 0.35) ?? 0.02).toFixed(3));
  const relevantMin = Number((quantile(scores, 0.7) ?? 0.04).toFixed(3));

  return relevantMin <= borderlineMin
    ? { borderlineMin, relevantMin: Number((borderlineMin + 0.08).toFixed(3)) }
    : { borderlineMin, relevantMin };
}

(async function init() {
  const state = await loadState();
  const metrics = state?.metrics || {};
  const settings = state?.settings || {};
  const events = state?.calibration?.events || [];

  document.getElementById("learn-mins").textContent = metrics.totalMinutesLearn || 0;
  document.getElementById("relax-mins").textContent = metrics.totalMinutesRelax || 0;
  document.getElementById("learn-count").textContent = metrics.sessionsLearn || 0;
  document.getElementById("relax-count").textContent = metrics.sessionsRelax || 0;

  document.getElementById("cur-relevant").textContent = (settings.semanticRelevantMin ?? 0.04).toFixed(2);
  document.getElementById("cur-borderline").textContent = (settings.semanticBorderlineMin ?? 0.02).toFixed(2);
  document.getElementById("calibration-samples").textContent = String(events.length);

  const reco = recommendThresholds(events);
  const recoEl = document.getElementById("calibration-reco");
  const btn = document.getElementById("apply-recommendation");

  if (!reco) {
    recoEl.textContent = "Need at least 15 calibration samples before recommending thresholds.";
    btn.disabled = true;
  } else {
    recoEl.textContent = `Recommended: relevant >= ${reco.relevantMin}, borderline >= ${reco.borderlineMin}`;
    btn.disabled = false;
    btn.addEventListener("click", async () => {
      await send("APPLY_THRESHOLD_RECOMMENDATION", reco);
      location.reload();
    });
  }

  const history = state?.sessionHistory || [];
  const historyList = document.getElementById("history");
  history.slice().reverse().slice(0, 20).forEach((session) => {
    const li = document.createElement("li");
    const title = session.mode === "learn"
      ? `Learn: ${session.learnAnswers?.topic || "(no topic)"}`
      : `Relax: ${session.relaxAnswers?.desiredFeel || "(no target mood)"}`;
    li.textContent = `${title} — ${session.durationMinutes} min — ended ${new Date(session.endedAtIso).toLocaleString()}`;
    historyList.appendChild(li);
  });
})();
