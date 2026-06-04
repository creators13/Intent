(() => {
  const DISTRACTION_KEYWORDS = [
    "prank", "drama", "celebrity", "gossip", "rage", "reaction", "asmr", "meme", "fortnite", "minecraft"
  ];

  function toWords(text = "") {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function uniqueWords(text = "") {
    return [...new Set(toWords(text))];
  }

  function cleanText(text = "") {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function buildIntentProfile(session) {
    const topicWords = uniqueWords(session?.learnAnswers?.topic || "");
    const goalWords = uniqueWords(session?.learnAnswers?.goal || "");
    return {
      mustHave: topicWords.slice(0, 8),
      helpful: [...new Set([...topicWords, ...goalWords])],
      distractors: DISTRACTION_KEYWORDS
    };
  }

  function scoreVideoKeywordDiagnostic(videoMeta, profile) {
    const haystack = `${videoMeta.title || ""} ${videoMeta.description || ""}`.toLowerCase();
    let score = 0;
    const matches = [];
    const distractorHits = [];

    for (const word of profile.mustHave) {
      if (haystack.includes(word)) {
        score += 12;
        matches.push(word);
      }
    }
    for (const word of profile.helpful) {
      if (haystack.includes(word)) score += 6;
    }
    for (const word of profile.distractors) {
      if (haystack.includes(word)) {
        score -= 15;
        distractorHits.push(word);
      }
    }

    return {
      keywordScore: Math.max(0, Math.min(100, score)),
      matches,
      distractorHits
    };
  }

  function classifySemanticScore(score, settings = {}) {
    const relevantMin = settings.semanticRelevantMin ?? 0.04;
    const borderlineMin = settings.semanticBorderlineMin ?? 0.02;

    if (score > relevantMin) return "relevant";
    if (score >= borderlineMin) return "borderline";
    return "irrelevant";
  }

  function buildIntentText(session) {
    const goal = cleanText(session?.learnAnswers?.goal || "");
    const topic = cleanText(session?.learnAnswers?.topic || "");

    if (!goal || !topic) return "";

    return `Represent this sentence for searching relevant passages: I want to learn about ${topic}. This is my goal: ${goal}.`;
  }

  function buildVideoText(videoMeta) {
    const title = cleanText(videoMeta?.title || "");
    const description = cleanText(videoMeta?.description || "");

    return [
      title ? `Title: ${title}` : "",
      description ? `Description: ${description}` : ""
    ].filter(Boolean).join("\n");
  }

  globalThis.IntentGuardRelevance = {
    buildIntentProfile,
    scoreVideoKeywordDiagnostic,
    classifySemanticScore,
    buildIntentText,
    buildVideoText
  };
})();
