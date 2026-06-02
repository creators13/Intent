(() => {
  // Local lightweight embedding-style scorer (no network/API)
  // Uses token + character-trigram hashing into a larger vector space.
  const DIM = 768;
  const cache = new Map();
  const MAX_CACHE = 800;

  function normalize(text = "") {
    return String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
  }

  function tokens(text) {
    const n = normalize(text);
    if (!n) return [];
    return n.split(" ").filter(Boolean);
  }

  function charTrigrams(token) {
    const t = `^${token}$`;
    const out = [];
    for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3));
    return out;
  }

  function vectorize(text = "") {
    const key = normalize(text);
    if (!key) return new Array(DIM).fill(0);
    if (cache.has(key)) return cache.get(key);

    const vec = new Array(DIM).fill(0);
    const toks = tokens(key);

    for (const tok of toks) {
      vec[hash(`tok:${tok}`) % DIM] += 1.0;
      for (const tri of charTrigrams(tok)) {
        vec[hash(`tri:${tri}`) % DIM] += 0.35;
      }
    }

    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    const out = vec.map((x) => x / norm);

    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(key, out);
    return out;
  }

  function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.max(0, Math.min(1, dot));
  }

  function scoreIntentVsVideo(intentText, videoText) {
    const t0 = performance.now();
    const score = cosine(vectorize(intentText), vectorize(videoText));
    return { semanticScore: score, elapsedMs: Math.round(performance.now() - t0) };
  }

  function warmup() {
    vectorize("basic algebra equations multiplication numbers digits");
    vectorize("comedy prank meme reaction compilation");
  }

  globalThis.IntentGuardEmbedding = {
    scoreIntentVsVideo,
    warmup,
    normalize
  };
})();
