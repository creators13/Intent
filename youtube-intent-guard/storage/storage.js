const STORAGE_KEY = "intentGuardState";
const SETTINGS_VERSION = 3;

const DEFAULT_STATE = {
  activeSession: null,
  sessionHistory: [],
  settings: {
    warnings: [15, 10, 5, 1],
    semanticBorderlineMin: 0.04,
    semanticRelevantMin: 0.08,
    reloadFallbackAfterMs: 3000,
    metaGateTimeoutMs: 5000,
    settingsVersion: SETTINGS_VERSION,
    calibrationMinSamples: 25
  },
  metrics: {
    totalMinutesLearn: 0,
    totalMinutesRelax: 0,
    sessionsLearn: 0,
    sessionsRelax: 0
  },
  calibration: {
    events: [],
    maxEvents: 500
  },
  evaluationRuntime: {
    lastSnapshotByTab: {}
  },
  evaluationDebug: {
    current: null,
    lastEvent: null,
    currentWinner: null,
    logsByUrl: {},
    maxEventsPerUrl: 250
  }
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDefaultState() {
  return deepClone(DEFAULT_STATE);
}

export async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (!result[STORAGE_KEY]) {
    const fallback = getDefaultState();
    await setState(fallback);
    return fallback;
  }

  const merged = {
    ...getDefaultState(),
    ...result[STORAGE_KEY],
    settings: {
      ...getDefaultState().settings,
      ...(result[STORAGE_KEY].settings || {})
    },
    metrics: {
      ...getDefaultState().metrics,
      ...(result[STORAGE_KEY].metrics || {})
    },
    calibration: {
      ...getDefaultState().calibration,
      ...(result[STORAGE_KEY].calibration || {})
    },
    evaluationRuntime: {
      ...getDefaultState().evaluationRuntime,
      ...(result[STORAGE_KEY].evaluationRuntime || {})
    },
    evaluationDebug: {
      ...getDefaultState().evaluationDebug,
      ...(result[STORAGE_KEY].evaluationDebug || {})
    }
  };

  const settings = { ...(merged.settings || {}) };
  const needsMigration = (settings.settingsVersion || 0) < SETTINGS_VERSION;

  if (needsMigration) {
    settings.semanticRelevantMin = 0.08;
    settings.semanticBorderlineMin = 0.04;
    settings.reloadFallbackAfterMs = 3000;
    settings.metaGateTimeoutMs = 5000;
    settings.settingsVersion = SETTINGS_VERSION;
  }

  if (!(typeof settings.semanticRelevantMin === "number") || !Number.isFinite(settings.semanticRelevantMin)) {
    settings.semanticRelevantMin = 0.08;
  }
  if (!(typeof settings.semanticBorderlineMin === "number") || !Number.isFinite(settings.semanticBorderlineMin)) {
    settings.semanticBorderlineMin = Number((settings.semanticRelevantMin * 0.5).toFixed(3));
  }

  if (!(typeof settings.reloadFallbackAfterMs === "number") || !Number.isFinite(settings.reloadFallbackAfterMs)) {
    settings.reloadFallbackAfterMs = 3000;
  }
  if (!(typeof settings.metaGateTimeoutMs === "number") || !Number.isFinite(settings.metaGateTimeoutMs)) {
    settings.metaGateTimeoutMs = 5000;
  }

  settings.semanticRelevantMin = Math.min(0.2, Math.max(0.05, settings.semanticRelevantMin));
  settings.semanticBorderlineMin = Number((settings.semanticRelevantMin * 0.5).toFixed(3));
  settings.reloadFallbackAfterMs = Math.round(Math.min(15000, Math.max(500, settings.reloadFallbackAfterMs)));
  settings.metaGateTimeoutMs = Math.round(Math.min(15000, Math.max(1000, settings.metaGateTimeoutMs)));

  const next = { ...merged, settings };
  if (needsMigration) {
    await setState(next);
  }

  return next;
}

export async function setState(nextState) {
  await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
}

export async function updateState(updater) {
  const current = await getState();
  const next = await updater(current);
  await setState(next);
  return next;
}

export async function startSession(session) {
  return updateState((state) => ({
    ...state,
    activeSession: session
  }));
}

export async function updateActiveSession(updater) {
  return updateState((state) => {
    if (!state.activeSession) return state;
    const nextActiveSession = updater(state.activeSession, state);
    return {
      ...state,
      activeSession: nextActiveSession
    };
  });
}

export async function endSession(summary) {
  return updateState((state) => {
    const history = [...state.sessionHistory, summary];
    const metrics = { ...state.metrics };

    if (summary.mode === "learn") {
      metrics.totalMinutesLearn += summary.durationMinutes;
      metrics.sessionsLearn += 1;
    } else {
      metrics.totalMinutesRelax += summary.durationMinutes;
      metrics.sessionsRelax += 1;
    }

    return {
      ...state,
      activeSession: null,
      sessionHistory: history,
      metrics
    };
  });
}

export async function logCalibrationEvent(event) {
  return updateState((state) => {
    const max = state.calibration?.maxEvents || 500;
    const events = [...(state.calibration?.events || []), event].slice(-max);
    return {
      ...state,
      calibration: {
        ...(state.calibration || {}),
        events
      }
    };
  });
}

export async function updateSemanticThresholds({ relevantMin, borderlineMin }) {
  return updateState((state) => ({
    ...state,
    settings: {
      ...state.settings,
      semanticRelevantMin: relevantMin,
      semanticBorderlineMin: borderlineMin
    }
  }));
}

export async function updateEvaluationSettings({ relevantMin, reloadFallbackAfterMs, metaGateTimeoutMs }) {
  const normalizedRelevant = Math.min(0.2, Math.max(0.05, Number(relevantMin)));
  const normalizedReloadMs = Math.round(Math.min(15000, Math.max(500, Number(reloadFallbackAfterMs))));
  const normalizedTimeoutMs = Math.round(Math.min(15000, Math.max(1000, Number(metaGateTimeoutMs))));
  return updateState((state) => ({
    ...state,
    settings: {
      ...state.settings,
      semanticRelevantMin: normalizedRelevant,
      semanticBorderlineMin: Number((normalizedRelevant * 0.5).toFixed(3)),
      reloadFallbackAfterMs: normalizedReloadMs,
      metaGateTimeoutMs: normalizedTimeoutMs
    }
  }));
}
