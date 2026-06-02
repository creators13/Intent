(() => {
  // Local semantic engine (no API / no remote model download)
  // Uses hashed token vectors + cosine similarity as a lightweight semantic baseline.

  const DIM = 256;
  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "this", "that",
    "it", "as", "at", "by", "from", "was", "were", "will", "you", "your", "about", "how", "what", "why"
  ]);

  const SYNONYMS = {
    bayes: ["bayesian", "probabilistic", "inference", "posterior", "prior"],
    probabilistic: ["bayes", "bayesian", "inference", "likelihood"],
    coding: ["programming", "software", "development", "javascript", "python"],
    ai: ["machine", "learning", "llm", "neural", "model"],
    workout: ["exercise", "fitness", "training", "strength", "cardio"],
    math: ["algebra", "calculus", "statistics", "probability"]
  };

  const embeddingCache = new Map();
  const MAX_CACHE = 500;

  function normalizeText(text = "") {
    return text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stem(token) {
    return token
      .replace(/(ingly|edly|ingly|ness|ments|ment|ation|ions|ion|ing|edly|edly|ed|ly|es|s)$/i, "")
      .trim();
  }

  function tokens(text = "") {
    return normalizeText(text)
      .split(" ")
      .map(stem)
      .filter(Boolean)
      .filter((t) => !STOPWORDS.has(t));
  }

  function expandTokens(rawTokens) {
    const expanded = [...rawTokens];
    for (const t of rawTokens) {
      if (SYNONYMS[t]) expanded.push(...SYNONYMS[t]);
    }
    return expanded.map(stem).filter(Boolean);
  }

  function hashToken(token) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return Math.abs(h >>> 0);
  }

  function vectorize(text = "") {
    const key = normalizeText(text);
    if (!key) return new Array(DIM).fill(0);
    if (embeddingCache.has(key)) return embeddingCache.get(key);

    const vec = new Array(DIM).fill(0);
    const toks = expandTokens(tokens(key));

    for (const tok of toks) {
      const idx = hashToken(tok) % DIM;
      vec[idx] += 1;
    }

    const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0)) || 1;
    const normalizedVec = vec.map((x) => x / norm);

    if (embeddingCache.size >= MAX_CACHE) {
      const first = embeddingCache.keys().next().value;
      embeddingCache.delete(first);
    }
    embeddingCache.set(key, normalizedVec);
    return normalizedVec;
  }

  function cosineSimilarity(a, b) {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  function scoreIntentVsVideo(intentText, videoText) {
    const t0 = performance.now();
    const intentVec = vectorize(intentText);
    const videoVec = vectorize(videoText);
    const semanticScore = cosineSimilarity(intentVec, videoVec);
    const elapsedMs = Math.round(performance.now() - t0);
    return { semanticScore, elapsedMs };
  }

  function warmup() {
    // deterministic warmup for first-install latency improvements
    vectorize("learn goal tutorial explanation deep understanding");
    vectorize("entertainment meme compilation prank reaction");
  }

  globalThis.IntentGuardSemantic = {
    normalizeText,
    scoreIntentVsVideo,
    warmup
  };
})();
