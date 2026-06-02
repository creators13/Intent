(() => {
  const DEFAULT_STATE = {
    activeSession: null,
    sessionHistory: [],
    settings: {
      warnings: [15, 10, 5, 1],
      semanticBorderlineMin: 0.04,
      semanticRelevantMin: 0.08,
      reloadFallbackAfterMs: 3000,
      metaGateTimeoutMs: 5000,
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
    }
  };

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  globalThis.IntentGuardSchema = {
    DEFAULT_STATE,
    deepClone
  };
})();
