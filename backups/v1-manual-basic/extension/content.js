const state = {
  items: [],
  capturedUrls: new Map(), // sku -> { url, headers }
  buttonMap: new Map()
};

ensureInject();
bindPageListeners();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PARSE_ITEMS") {
    const items = parseItems();
    sendResponse({ items });
    return true;
  }
  if (message?.type === "GET_CAPTURED_URLS") {
    sendResponse({ captured: Object.fromEntries(state.capturedUrls.entries()) });
    return true;
  }
  if (message?.type === "GET_LOGS") {
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (res) => {
      sendResponse(res);
    });
    return true;
  }
  return false;
});

function ensureInject() {
  if (document.getElementById("__jdvideo_inject")) return;
  const script = document.createElement("script");
  script.id = "__jdvideo_inject";
  script.src = chrome.runtime.getURL("inject.js");
  (document.head || document.documentElement).appendChild(script);
}

function bindPageListeners() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source === "jdvideo-inject" && data.type === "CAPTURED_URL") {
      const sku = data.sku || findFirstPendingSku() || `capture-${Date.now()}`;
      if (data.url) {
        state.capturedUrls.set(sku, {
          url: data.url,
          headers: data.meta?.headers || buildHeaders()
        });
        log("content:captured_url", { sku, url: data.url });
      }
    }
    if (data?.source === "jdvideo-inject" && data.type === "LOG_INJECT") {
      log("inject", data.payload || {});
    }
  });
}

function parseItems() {
  log("content:parse_start");
  const nodes = document.querySelectorAll(".antd-pro-pages-explain-components-table-list-goodsInfoContent");
  const results = [];
  state.buttonMap.clear();
  const baseHeaders = buildHeaders();
  nodes.forEach((node, idx) => {
    const rawText = (node.textContent || "").replace(/\s+/g, " ").trim();
    const skuMatch = rawText.match(/SKUID[:：]\s*(\d+)/i);
    const title = deriveTitle(rawText);
    const sku = skuMatch?.[1] || `unknown-${idx + 1}`;
    const container = findContainer(node);
    const downloadBtn = findDownloadButton(container);
    if (downloadBtn) {
      state.buttonMap.set(sku, downloadBtn);
    }
    let videoUrl = readUrlFromButton(downloadBtn);
    const captured = state.capturedUrls.get(sku);
    const headers = captured?.headers || baseHeaders;
    if (captured?.url) {
      videoUrl = captured.url;
    }
    if (downloadBtn) {
      attachClickHook(downloadBtn, sku);
    }
    results.push({
      sku,
      title,
      videoUrl,
      headers,
      hasDownloadButton: Boolean(downloadBtn),
      extractedFromDom: Boolean(videoUrl)
    });
  });
  state.items = results;
  log("content:parse_done", { count: results.length });
  return results;
}

async function autoCaptureUrls(options) {
  // v1 无自动捕获
}

function markPendingSku(sku) {
  window.postMessage(
    {
      source: "jdvideo-content",
      type: "SET_PENDING_SKU",
      sku
    },
    "*"
  );
}

function deriveTitle(text) {
  if (!text) return "未命名";
  const cleaned = text.replace(/SKUID[:：]\s*\d+/i, "").trim();
  return cleaned || "未命名";
}

function findContainer(node) {
  if (!node) return null;
  return (
    node.closest(".ant-table-row") ||
    node.closest("[class*='table']") ||
    node.parentElement
  );
}

function findDownloadButton(container) {
  if (!container) return null;
  const candidates = container.querySelectorAll("p, a, button, span");
  return Array.from(candidates).find((el) => /下载/.test(el.textContent || ""));
}

function readUrlFromButton(btn) {
  if (!btn) return null;
  return (
    btn.dataset?.src ||
    btn.dataset?.url ||
    btn.getAttribute("data-src") ||
    btn.getAttribute("data-url") ||
    btn.getAttribute("href") ||
    null
  );
}

function attachClickHook(btn, sku) {
  if (!btn || btn.dataset.jdvideoHooked) return;
  btn.dataset.jdvideoHooked = "1";
  btn.addEventListener("click", () => {
    markPendingSku(sku);
    log("content:btn_click", { sku });
  });
}

function findFirstPendingSku() {
  const pending = state.items.find((item) => !item.videoUrl);
  return pending?.sku;
}

function buildHeaders() {
  return {
    referer: window.location.href,
    ua: window.navigator.userAgent,
    cookie: document.cookie || ""
  };
}

function log(event, data) {
  chrome.runtime.sendMessage(
    {
      type: "LOG",
      origin: "content",
      event,
      data
    },
    () => {}
  );
}

