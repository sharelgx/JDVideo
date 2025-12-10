const state = {
  items: [],
  capturedUrls: new Map(), // sku -> { url, headers }
  buttonMap: new Map(),
  pendingSku: null // 当前待捕获的SKU
};

ensureInject();
bindPageListeners();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PARSE_ITEMS") {
    const items = parseItems();
    sendResponse({ items });
    return true;
  }
  if (message?.type === "AUTO_CAPTURE_URLS") {
    autoCaptureUrls(message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
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
  if (document.getElementById("__jdvideo_inject")) {
    log("content:inject_already_loaded");
    return;
  }
  try {
    const script = document.createElement("script");
    script.id = "__jdvideo_inject";
    script.src = chrome.runtime.getURL("inject.js");
    script.onerror = () => {
      log("content:inject_load_error", { src: script.src });
    };
    script.onload = () => {
      log("content:inject_load_success");
    };
    (document.head || document.documentElement).appendChild(script);
    log("content:inject_script_added");
  } catch (e) {
    log("content:inject_create_error", { error: e.message });
  }
}

function bindPageListeners() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source === "jdvideo-inject" && data.type === "CAPTURED_URL") {
      // 优先使用传入的SKU，其次使用state.pendingSku，最后才用临时SKU
      const sku = data.sku || state.pendingSku || findFirstPendingSku() || `capture-${Date.now()}`;
      if (data.url) {
        // 获取商品信息（从已解析的items中查找）
        const itemInfo = state.items.find(item => item.sku === sku);
        const title = itemInfo?.title || "未命名视频";
        const headers = data.meta?.headers || buildHeaders();
        
        state.capturedUrls.set(sku, {
          url: data.url,
          headers
        });
        log("content:captured_url", { sku, capturedSku: data.sku, pendingSku: state.pendingSku, url: data.url });
        
        // 方案2：不在这里自动下载，等待用户点击"批量下载"
        // 下载逻辑在background.js中，通过监听浏览器下载事件来实现转发
        
        // 清空pending SKU，避免下次误用
        if (state.pendingSku === sku) {
          state.pendingSku = null;
        }
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
  try {
    // 使用V1.0稳定版的速度参数，但保留改进的SKU绑定逻辑
    const delay = Number(options.delayMs) || 2200; // 恢复为V1.0的2.2秒
    const retries = Number(options.retries) || 3; // 恢复为V1.0的3次
    const maxRounds = 2; // 恢复为V1.0的2轮
    let round = 0;
    let success = 0;
    let targets = [];

    log("content:auto_capture_start", { delay, retries, maxRounds });
    
    // 确保注入脚本已加载
    ensureInject();
    await wait(500); // 等待注入脚本初始化
    
    // 首次解析，获取所有待捕获的SKU列表
    const initialItems = parseItems();
    const initialTargets = initialItems.filter((item) => !item.videoUrl && state.buttonMap.get(item.sku));
    const initialSkus = initialTargets.map(item => item.sku);
    
    // 通知background进入捕获模式
    if (initialSkus.length > 0) {
      try {
        await chrome.runtime.sendMessage({
          type: "START_CAPTURE_MODE",
          skus: initialSkus
        });
        log("content:capture_mode_started", { skuCount: initialSkus.length });
      } catch (e) {
        log("content:capture_mode_start_error", { error: e.message });
      }
    }

    do {
      const items = parseItems();
      targets = items.filter((item) => !item.videoUrl && state.buttonMap.get(item.sku));
      log("content:auto_capture_round", { round: round + 1, targets: targets.length });
      
      // 每轮开始时更新capturingSkus列表（可能有新的SKU）
      if (targets.length > 0) {
        const currentSkus = targets.map(item => item.sku);
        try {
          await chrome.runtime.sendMessage({
            type: "START_CAPTURE_MODE",
            skus: currentSkus
          });
        } catch (e) {
          // ignore
        }
      }
      
      if (targets.length === 0) {
        log("content:auto_capture_no_targets");
        break;
      }

      for (const item of targets) {
        try {
          const btn = state.buttonMap.get(item.sku);
          if (!btn) {
            log("content:auto_capture_no_button", { sku: item.sku });
            continue;
          }
          
          let captured = false;
          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              // 每次尝试前重新设置pending SKU，确保注入脚本收到
              markPendingSku(item.sku);
              await wait(150); // 给足够时间让pending SKU设置到注入脚本
              
              // 点击按钮
              log("content:btn_click", { sku: item.sku, attempt: attempt + 1 });
              dispatchHumanClick(btn);
              
              // 分段等待并检查，但减少检查间隔以提高响应速度
              const checkInterval = 400;
              let waited = 0;
              while (waited < delay && !captured) {
                await wait(checkInterval);
                waited += checkInterval;
                // 检查是否捕获到URL
                if (state.capturedUrls.get(item.sku)?.url) {
                  captured = true;
                  success += 1;
                  log("content:auto_capture_success", { sku: item.sku, attempt: attempt + 1, waited });
                  break;
                }
              }
              
              // 最终检查一次（JSON响应可能需要更长时间）
              if (!captured) {
                await wait(500);
                if (state.capturedUrls.get(item.sku)?.url) {
                  captured = true;
                  success += 1;
                  log("content:auto_capture_success_final_check", { sku: item.sku, attempt: attempt + 1 });
                  break;
                }
              }
              
              if (captured) break;
              
              // 如果还没捕获到，等待一段时间再重试
              if (attempt < retries) {
                await wait(400);
              }
            } catch (e) {
              log("content:auto_capture_attempt_error", { sku: item.sku, attempt: attempt + 1, error: e.message });
            }
          }
          
          if (!captured) {
            log("content:auto_capture_miss", { sku: item.sku, attempts: retries + 1 });
          }
        } catch (e) {
          log("content:auto_capture_item_error", { sku: item.sku, error: e.message });
        }
      }
      
      // 轮次之间等待，让网络请求有时间完成
      if (targets.length > 0 && round < maxRounds - 1) {
        await wait(800);
      }
      
      round += 1;
    } while (targets.length && round < maxRounds);

    // 最终再等待一下，收集可能延迟的URL（特别是JSON响应）
    await wait(1500); // 减少到1.5秒，接近V1.0速度
    const finalItems = parseItems();
    
    // 通知background退出捕获模式
    try {
      await chrome.runtime.sendMessage({
        type: "END_CAPTURE_MODE"
      });
      log("content:capture_mode_ended");
    } catch (e) {
      log("content:capture_mode_end_error", { error: e.message });
    }
    
    log("content:auto_capture_done", { success, total: finalItems.length, round });
    return {
      ok: true,
      successCount: success,
      totalTried: finalItems.length,
      items: finalItems
    };
  } catch (error) {
    // 确保在异常时也退出捕获模式
    try {
      await chrome.runtime.sendMessage({
        type: "END_CAPTURE_MODE"
      });
    } catch (e) {
      // ignore
    }
    log("content:auto_capture_fatal", { error: error?.message || String(error), stack: error?.stack });
    throw error;
  }
}

function markPendingSku(sku) {
  state.pendingSku = sku;
  window.postMessage(
    {
      source: "jdvideo-content",
      type: "SET_PENDING_SKU",
      sku
    },
    "*"
  );
  log("content:mark_pending_sku", { sku });
}

function dispatchHumanClick(btn) {
  if (!btn) return;
  
  try {
    // 对于 <a> 标签，尝试多种方式触发
    if (btn.tagName === "A") {
      // 方法1: 创建并派发完整的鼠标事件序列
      const events = [
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }),
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }),
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 })
      ];
      
      events.forEach(evt => {
        try {
          btn.dispatchEvent(evt);
        } catch (e) {
          // ignore
        }
      });
      
      // 方法2: 如果有 href，尝试触发默认行为
      if (btn.href) {
        // 先尝试直接点击
        try {
          btn.click();
        } catch (e) {
          // 如果失败，尝试手动触发导航（但不实际导航）
          // 这可能会触发相关的事件监听器
        }
      }
    } else {
      // 对于 button 或其他元素，使用标准点击事件
      const clickEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 1
      });
      
      btn.dispatchEvent(clickEvent);
      
      // 也尝试直接调用 click() 方法
      if (typeof btn.click === "function") {
        btn.click();
      }
    }
    
    log("content:dispatch_click", { 
      tag: btn.tagName, 
      href: btn.href || null,
      className: btn.className || null 
    });
  } catch (e) {
    log("content:dispatch_click_error", { error: e.message });
    // 最后的备选方案
    try {
      if (typeof btn.click === "function") {
        btn.click();
      }
    } catch (err) {
      // ignore
    }
  }
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
  // 优先查找 <a> 标签（通常包含下载链接）
  const linkCandidates = container.querySelectorAll("a");
  const linkBtn = Array.from(linkCandidates).find((el) => {
    const text = el.textContent || "";
    const innerText = Array.from(el.querySelectorAll("p, span")).map(p => p.textContent).join("");
    return /下载/.test(text) || /下载/.test(innerText);
  });
  if (linkBtn) return linkBtn;
  
  // 如果没找到 <a>，查找 <button>
  const buttonCandidates = container.querySelectorAll("button");
  const buttonBtn = Array.from(buttonCandidates).find((el) => {
    const text = el.textContent || "";
    return /下载/.test(text);
  });
  if (buttonBtn) {
    // 如果 button 内部有 <a>，优先返回 <a>
    const innerLink = buttonBtn.querySelector("a");
    if (innerLink) return innerLink;
    return buttonBtn;
  }
  
  // 最后查找其他元素
  const candidates = container.querySelectorAll("p, span");
  const otherBtn = Array.from(candidates).find((el) => /下载/.test(el.textContent || ""));
  if (otherBtn) {
    // 向上查找是否有 <a> 或 <button> 父元素
    const parentLink = otherBtn.closest("a");
    if (parentLink) return parentLink;
    const parentButton = otherBtn.closest("button");
    if (parentButton) {
      const innerLink = parentButton.querySelector("a");
      if (innerLink) return innerLink;
      return parentButton;
    }
    return otherBtn;
  }
  
  return null;
}

function readUrlFromButton(btn) {
  if (!btn) return null;
  // 尝试多种方式读取URL
  const url = (
    btn.dataset?.src ||
    btn.dataset?.url ||
    btn.getAttribute("data-src") ||
    btn.getAttribute("data-url") ||
    btn.getAttribute("href") ||
    (btn.tagName === "A" ? btn.href : null) ||
    null
  );
  
  // 如果没有找到URL，可能是因为URL是动态加载的，这是正常的
  if (!url) {
    log("content:no_url_in_button", { 
      tag: btn.tagName,
      className: btn.className || "",
      hasClstag: btn.hasAttribute("clstag")
    });
  }
  
  return url;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

