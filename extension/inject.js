(function () {
  const state = {
    pendingSku: null
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source === "jdvideo-content" && data.type === "SET_PENDING_SKU") {
      state.pendingSku = data.sku || null;
      log("inject:set_pending_sku", { sku: state.pendingSku });
    }
  });

  const isVideoUrl = (url, headers) => {
    if (!url) return false;
    const lower = url.toLowerCase();
    const contentType = (headers?.get?.("content-type") || "").toLowerCase();
    const byExt =
      lower.includes(".mp4") ||
      lower.includes(".m3u8") ||
      lower.includes(".flv") ||
      lower.includes(".ts");
    const byHint =
      lower.includes("video") ||
      lower.includes("vod") ||
      lower.includes("download");
    const byType = contentType.includes("video") || contentType.includes("mpeg");
    const byOctet = contentType.includes("octet-stream");
    return byExt || byType || byHint || byOctet;
  };

  const notifyCapture = (url, meta = {}) => {
    if (!url) return;
    const headers = meta.headers || buildHeaders();
    log("inject:capture_url", { url, sku: state.pendingSku });
    const payload = {
      source: "jdvideo-inject",
      type: "CAPTURED_URL",
      url,
      sku: state.pendingSku,
      ts: Date.now(),
      meta: { ...meta, headers }
    };
    state.pendingSku = null;
    window.postMessage(payload, "*");
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const reqUrl =
        (response && response.url) ||
        (typeof args[0] === "string" ? args[0] : args[0]?.url) ||
        "";
      const ctype = response?.headers?.get?.("content-type") || "";
      if (isVideoUrl(reqUrl, response?.headers)) {
        notifyCapture(reqUrl, { via: "fetch" });
      } else if (/json/i.test(ctype)) {
        // 尝试从 JSON 响应中提取视频 URL
        const cloned = response.clone();
        cloned
          .json()
          .then((data) => {
            const url = extractUrlFromJson(data);
            if (url && isLikelyVideo(url)) {
              notifyCapture(url, { via: "fetch_json" });
            }
          })
          .catch(() => {});
      } else if (state.pendingSku && !/text\/html/i.test(ctype)) {
        // 当存在待绑定 SKU 且非明显 HTML 时，兜底抓取
        notifyCapture(reqUrl, { via: "fetch_fallback" });
      } else {
        log("inject:fetch_skip", { url: reqUrl });
      }
    } catch (e) {
      // ignore
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    this._jdvideoUrl = args[1];
    return origOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener(
      "load",
      () => {
        try {
          const url = this.responseURL || this._jdvideoUrl;
          const contentType = this.getResponseHeader("content-type") || "";
          if (isVideoUrl(url, { get: () => contentType })) {
            notifyCapture(url, { via: "xhr" });
          } else if (/json/i.test(contentType)) {
            try {
              const data = JSON.parse(this.responseText || "{}");
              const videoUrl = extractUrlFromJson(data);
              if (videoUrl && isLikelyVideo(videoUrl)) {
                notifyCapture(videoUrl, { via: "xhr_json" });
                return;
              }
            } catch (e) {
              // ignore
            }
          } else if (state.pendingSku) {
            notifyCapture(url, { via: "xhr_fallback" });
          } else {
            log("inject:xhr_skip", { url });
          }
        } catch (e) {
          // ignore
        }
      },
      { once: true }
    );
    return origSend.apply(this, args);
  };

  function log(event, payload) {
    try {
      window.postMessage(
        {
          source: "jdvideo-inject",
          type: "LOG_INJECT",
          payload: { event, payload, ts: Date.now() }
        },
        "*"
      );
    } catch (e) {
      // ignore
    }
  }

  function buildHeaders() {
    return {
      referer: window.location.href,
      ua: window.navigator.userAgent,
      cookie: document.cookie || ""
    };
  }

  function extractUrlFromJson(obj) {
    if (!obj) return null;
    if (typeof obj === "string") {
      if (isLikelyVideo(obj)) return obj;
      return null;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = extractUrlFromJson(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === "string" && isLikelyVideo(val)) return val;
        const found = extractUrlFromJson(val);
        if (found) return found;
      }
    }
    return null;
  }

  function isLikelyVideo(url) {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase();
    return (
      lower.includes(".mp4") ||
      lower.includes(".m3u8") ||
      lower.includes(".flv") ||
      lower.includes(".ts") ||
      lower.includes("video") ||
      lower.includes("vod")
    );
  }
})();


