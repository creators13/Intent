(() => {
  if (window.__intentGuardPageBridgeInstalled) return;
  window.__intentGuardPageBridgeInstalled = true;

  const shouldCapture = (url, text) => {
    if (!url || !/youtube\.com/.test(url)) return false;
    if (typeof text !== "string" || text.length < 2) return false;
    return /shortDescription|videoDetails|reel|shorts|playerResponse|watchNextResponse/.test(text);
  };

  const postPayload = (url, text) => {
    try {
      if (!shouldCapture(url, text)) return;
      window.postMessage({ __intentGuardType: "INTENT_GUARD_YT_PAYLOAD", url, text }, "*");
    } catch {
      // no-op
    }
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const reqUrl = String(args?.[0]?.url || args?.[0] || res?.url || "");
        const cloned = res?.clone?.();
        if (cloned) cloned.text().then((t) => postPayload(reqUrl, t)).catch(() => {});
      } catch {
        // no-op
      }
      return res;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__intentGuardUrl = String(url || "");
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (this.responseType && this.responseType !== "" && this.responseType !== "text") return;
        postPayload(this.__intentGuardUrl || "", String(this.responseText || ""));
      } catch {
        // no-op
      }
    });
    return origSend.apply(this, args);
  };
})();
