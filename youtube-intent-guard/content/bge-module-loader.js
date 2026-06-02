(() => {
  globalThis.IntentGuardBGELoaded = import(chrome.runtime.getURL("rules/bge-engine.js"))
    .catch((err) => {
      console.warn("[IntentGuard] Failed to load BGE module", err);
      throw err;
    });
})();