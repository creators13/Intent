import { pipeline, env } from "../vendor/transformers.min.js";

(() => {
  const MODEL_ID = "Xenova/bge-small-en-v1.5";
  const INIT_TIMEOUT_MS = 25000;
  const SCORE_TIMEOUT_MS = 12000;

  let extractor = null;
  let initPromise = null;
  let scoreQueue = Promise.resolve();
  let cachedIntentSessionId = "";
  let cachedIntentText = "";
  let cachedIntentEmbeddingPromise = null;

  function normalize(text = "") {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function hasWebGPU() {
    return !!globalThis.navigator?.gpu;
  }

  function timeoutAfter(ms, label) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    });
  }

  function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
    const c = dot / denom;
    return Math.max(-1, Math.min(1, c));
  }

  async function initModel() {
    if (extractor) return extractor;
    if (!hasWebGPU()) {
      throw new Error("webgpu-unavailable");
    }

    if (!initPromise) {
      initPromise = (async () => {
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = chrome.runtime.getURL("models/");
        env.useBrowserCache = false;
        env.useFSCache = false;
        env.useCustomCache = false;

        const instance = await pipeline("feature-extraction", MODEL_ID, {
          quantized: true,
          device: "webgpu"
        });
        extractor = instance;
        return extractor;
      })();

      initPromise = Promise.race([
        initPromise,
        timeoutAfter(INIT_TIMEOUT_MS, "bge-init-timeout")
      ]).catch((err) => {
        initPromise = null;
        extractor = null;
        throw err;
      });
    }

    return initPromise;
  }

  async function embedText(text) {
    const model = await initModel();
    const out = await model(normalize(text), {
      pooling: "mean",
      normalize: true
    });
    return Array.from(out?.data || []);
  }

  function clearIntentEmbeddingCache() {
    cachedIntentSessionId = "";
    cachedIntentText = "";
    cachedIntentEmbeddingPromise = null;
  }

  async function embedIntentText(intentText, sessionId = "") {
    const key = normalize(intentText);
    const sid = String(sessionId || "");
    if (!key) return [];

    if (
      cachedIntentEmbeddingPromise &&
      cachedIntentSessionId === sid &&
      cachedIntentText === key
    ) {
      return cachedIntentEmbeddingPromise;
    }

    cachedIntentSessionId = sid;
    cachedIntentText = key;
    cachedIntentEmbeddingPromise = embedText(key).catch((err) => {
      if (cachedIntentSessionId === sid && cachedIntentText === key) {
        clearIntentEmbeddingCache();
      }
      throw err;
    });

    return cachedIntentEmbeddingPromise;
  }

  async function scoreIntentVsVideo(intentText, videoText, options = {}) {
    const run = async () => {
      const t0 = performance.now();
      const result = await Promise.race([
        (async () => {
          const [a, b] = await Promise.all([
            embedIntentText(intentText, options?.sessionId),
            embedText(videoText)
          ]);
          const semanticScore = cosine(a, b);
          return {
            semanticScore,
            elapsedMs: Math.round(performance.now() - t0),
            model: MODEL_ID,
            quantized: true,
            backend: "webgpu",
            intentEmbeddingCached: !!cachedIntentEmbeddingPromise,
            intentEmbeddingCacheSessionId: cachedIntentSessionId,
            intentEmbeddingCacheText: cachedIntentText
          };
        })(),
        timeoutAfter(SCORE_TIMEOUT_MS, "bge-score-timeout")
      ]);
      return result;
    };

    const queued = scoreQueue.then(run, run);
    scoreQueue = queued.catch(() => {});
    return queued;
  }

  function warmup() {
    return initModel().catch(() => null);
  }

  globalThis.IntentGuardBGE = {
    warmup,
    scoreIntentVsVideo,
    clearIntentEmbeddingCache,
    normalize,
    getStatus: () => ({
      modelId: MODEL_ID,
      quantized: true,
      webgpuRequired: true,
      webgpuAvailable: hasWebGPU(),
      initialized: !!extractor,
      initializing: !!initPromise && !extractor,
      intentEmbeddingCached: !!cachedIntentEmbeddingPromise,
      intentEmbeddingCacheSessionId: cachedIntentSessionId,
      intentEmbeddingCacheText: cachedIntentText
    })
  };
})();
