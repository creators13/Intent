import { getState, startSession, endSession, logCalibrationEvent, updateSemanticThresholds, updateEvaluationSettings, updateState } from "./storage/storage.js";

function nowIso() {
  return new Date().toISOString();
}

function toUrlKey(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return "unknown-url";
  return raw;
}

function toTabScopeKey(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId === "number") return `tab:${tabId}`;
  return "tab:unknown";
}

const RELAX_TEXT_MIN_NON_WHITESPACE = 10;

function nonWhitespaceLength(value = "") {
  return String(value || "").replace(/\s/g, "").length;
}

function validateLearnAnswers(learnAnswers = {}) {
  if (!String(learnAnswers.topic || "").trim()) {
    return { ok: false, error: "Please enter the topic(s) you want to learn." };
  }
  if (!String(learnAnswers.goal || "").trim()) {
    return { ok: false, error: "Please enter your goal for this session." };
  }
  return { ok: true };
}

function validateRelaxAnswers(relaxAnswers = {}) {
  const fields = [
    ["currentFeel", "how you currently feel"],
    ["desiredFeel", "how you want to feel"],
    ["alternativesNow", "what else can help you now"],
    ["tomorrowNeed", "what you are going to do after this relax session and why it is important to follow through"],
    ["durationWhy", "why this is the right length for you"]
  ];

  for (const [key, label] of fields) {
    if (nonWhitespaceLength(relaxAnswers[key]) < RELAX_TEXT_MIN_NON_WHITESPACE) {
      return { ok: false, error: `Please elaborate more on ${label}.` };
    }
  }

  return { ok: true };
}

async function scheduleRelaxWarnings(activeSession, warnings) {
  if (activeSession.mode !== "relax") return;

  const endTs = activeSession.endTime;
  for (const min of warnings) {
    const trigger = endTs - min * 60_000;
    if (trigger > Date.now()) {
      await chrome.alarms.create(`warn-${activeSession.id}-${min}`, { when: trigger });
    }
  }

  await chrome.alarms.create(`end-${activeSession.id}`, { when: endTs });
}

async function closeYoutubeTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const tabIds = tabs.map((t) => t.id).filter((id) => typeof id === "number");
  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch (err) {
      console.warn("Intent Guard: could not close one or more YouTube tabs", err);
    }
  }
  return tabIds.length;
}

async function notifyYoutubeTabs(message) {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const results = [];

  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      results.push({ tabId: tab.id, ok: true });
    } catch (err) {
      results.push({ tabId: tab.id, ok: false, error: String(err?.message || err || "unknown") });
      console.warn("Intent Guard: could not notify YouTube tab", tab.id, err);
    }
  }

  return results;
}

async function completeActiveSession(state, completionCheck = null) {
  const active = state.activeSession;
  if (!active) return { ok: false, error: "No active session." };

  const durationMinutes = Math.max(1, Math.round((Date.now() - active.startTime) / 60_000));
  const summary = {
    ...active,
    endedAtIso: nowIso(),
    durationMinutes,
    completionCheck
  };

  await endSession(summary);
  await updateState((s) => ({
    ...s,
    evaluationRuntime: {
      ...(s.evaluationRuntime || {}),
      lastSnapshotByTab: {}
    },
    evaluationDebug: {
      ...(s.evaluationDebug || {}),
      current: null,
      lastEvent: null,
      currentWinner: null,
      logsByUrl: {}
    }
  }));
  await chrome.alarms.clearAll();
  const closedTabCount = await closeYoutubeTabs();
  return { ok: true, summary, closedTabCount };
}

chrome.runtime.onInstalled.addListener(async () => {
  await getState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const state = await getState();

    if (message.type === "GET_STATE") return sendResponse({ ok: true, state });

    if (message.type === "GET_LAST_EVALUATED_SNAPSHOT") {
      const tabKey = toTabScopeKey(sender);
      const snap = state?.evaluationRuntime?.lastSnapshotByTab?.[tabKey] || null;
      return sendResponse({ ok: true, snapshot: snap, tabKey });
    }

    if (message.type === "SET_LAST_EVALUATED_SNAPSHOT") {
      const tabKey = toTabScopeKey(sender);
      const payload = message.payload || {};
      const nextState = await updateState((s) => ({
        ...s,
        evaluationRuntime: {
          ...(s.evaluationRuntime || {}),
          lastSnapshotByTab: {
            ...((s.evaluationRuntime && s.evaluationRuntime.lastSnapshotByTab) || {}),
            [tabKey]: payload?.snapshot || null
          }
        }
      }));
      return sendResponse({ ok: true, snapshot: nextState?.evaluationRuntime?.lastSnapshotByTab?.[tabKey] || null, tabKey });
    }

    if (message.type === "START_SESSION") {
      if (state.activeSession) {
        return sendResponse({ ok: false, error: "A session is already active." });
      }

      if (message.payload?.mode === "learn") {
        const validation = validateLearnAnswers(message.payload?.learnAnswers || {});
        if (!validation.ok) return sendResponse(validation);
      }

      if (message.payload?.mode === "relax") {
        const validation = validateRelaxAnswers(message.payload?.relaxAnswers || {});
        if (!validation.ok) return sendResponse(validation);
      }

      const session = {
        ...message.payload,
        id: crypto.randomUUID(),
        startTime: Date.now(),
        startedAtIso: nowIso(),
        approvedVideoIds: []
      };

      if (session.mode === "relax") {
        session.endTime = session.startTime + session.relaxAnswers.durationMinutes * 60_000;
      }

      await startSession(session);
      await chrome.alarms.clearAll();
      await scheduleRelaxWarnings(session, state.settings.warnings || [15, 10, 5, 1]);
      return sendResponse({ ok: true, session });
    }

    if (message.type === "END_SESSION") {
      const result = await completeActiveSession(state, message.payload?.completionCheck || null);
      return sendResponse(result);
    }

    if (message.type === "END_SESSION_FROM_BLOCKER") {
      const result = await completeActiveSession(state, message.payload?.completionCheck || {
        note: "Ended expired Relax session from timeout blocker."
      });
      return sendResponse(result);
    }

    if (message.type === "OPEN_DASHBOARD") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("ui/dashboard.html") });
      return sendResponse({ ok: true });
    }

    if (message.type === "LOG_CALIBRATION_EVENT") {
      await logCalibrationEvent({ ...message.payload, loggedAtIso: nowIso() });
      return sendResponse({ ok: true });
    }

    if (message.type === "EVAL_DEBUG_UPDATE") {
      const payload = message.payload || {};
      const urlKey = toUrlKey(payload.url || payload.targetUrl || payload.currentUrl);
      const event = {
        ...payload,
        urlKey,
        loggedAtIso: nowIso()
      };

      await updateState((s) => {
        const evalDebug = s.evaluationDebug || { current: null, logsByUrl: {}, maxEventsPerUrl: 250 };
        const logsByUrl = { ...(evalDebug.logsByUrl || {}) };
        const maxEventsPerUrl = Number(evalDebug.maxEventsPerUrl || 250);
        const existing = Array.isArray(logsByUrl[urlKey]) ? logsByUrl[urlKey] : [];
        logsByUrl[urlKey] = [...existing, event].slice(-maxEventsPerUrl);
        const isWinnerEvent = event?.type === "evaluation-complete";
        return {
          ...s,
          evaluationDebug: {
            ...evalDebug,
            current: isWinnerEvent ? event : (evalDebug.current || null),
            lastEvent: event,
            currentWinner: isWinnerEvent ? event : (evalDebug.currentWinner || null),
            logsByUrl,
            maxEventsPerUrl
          }
        };
      });

      return sendResponse({ ok: true });
    }

    if (message.type === "GET_EVAL_DEBUG") {
      return sendResponse({ ok: true, evaluationDebug: state.evaluationDebug || null });
    }

    if (message.type === "CLEAR_EVAL_DEBUG_LOGS") {
      const nextState = await updateState((s) => ({
        ...s,
        evaluationDebug: {
          ...(s.evaluationDebug || {}),
          current: null,
          lastEvent: null,
          currentWinner: null,
          logsByUrl: {}
        }
      }));
      return sendResponse({ ok: true, evaluationDebug: nextState.evaluationDebug || null });
    }

    if (message.type === "APPLY_THRESHOLD_RECOMMENDATION") {
      await updateSemanticThresholds(message.payload);
      return sendResponse({ ok: true });
    }

    if (message.type === "UPDATE_EVALUATION_SETTINGS") {
      const payload = message.payload || {};
      const nextState = await updateEvaluationSettings(payload);
      return sendResponse({ ok: true, settings: nextState?.settings || null });
    }

    if (message.type === "APPROVE_VIDEO") {
      const approvedVideoId = message.payload?.videoId;
      const active = state.activeSession;
      if (!active || active.mode !== "learn") return sendResponse({ ok: false, error: "No active learn session." });
      if (!approvedVideoId) return sendResponse({ ok: false, error: "Missing videoId." });

      const nextState = await updateState((s) => {
        const cur = s.activeSession;
        if (!cur || cur.mode !== "learn") return s;
        const existing = new Set(cur.approvedVideoIds || []);
        existing.add(String(approvedVideoId));
        return {
          ...s,
          activeSession: {
            ...cur,
            approvedVideoIds: [...existing]
          }
        };
      });

      return sendResponse({ ok: true, approvedVideoIds: nextState?.activeSession?.approvedVideoIds || [] });
    }

    return sendResponse({ ok: false, error: "Unknown message type" });
  })();

  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const state = await getState();
  const session = state.activeSession;
  if (!session || session.mode !== "relax") return;

  if (alarm.name.startsWith("warn-")) {
    const mins = alarm.name.split("-").pop();
    await chrome.notifications.create({
      type: "basic",
      title: "YouTube Relax Timer",
      message: `${mins} minute(s) remaining in your session.`,
      iconUrl: "assets/icon48.png"
    });
    return;
  }

  if (alarm.name.startsWith("end-")) {
    await chrome.notifications.create({
      type: "basic",
      title: "Session Complete",
      message: "Time is up. Open YouTube to review your commitment and end the session.",
      iconUrl: "assets/icon48.png"
    });
    await notifyYoutubeTabs({
      type: "RELAX_SESSION_EXPIRED",
      payload: { session }
    });
  }
});
