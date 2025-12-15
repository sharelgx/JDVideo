const state = {
  items: [],
  capturedUrls: new Map(), // sku -> { url, headers }
  buttonMap: new Map(),
  pendingSku: null, // 当前待捕获的SKU
  // 分页累计：跨页合并后的全量商品（按 SKU 去重）
  allItemsBySku: new Map(), // sku -> item
  allSkuOrder: [], // 按首次发现顺序保存 sku
  explainId: null // 当前讲解页id（切换讲解页时自动清空累计）
};

console.log("[content] ========== content.js 已加载 ==========");
console.log("[content] 当前URL:", window.location.href);
console.log("[content] 检查 __jdvideoGetAllPreloadResponses:", typeof window.__jdvideoGetAllPreloadResponses);

ensureInject();
bindPageListeners();

console.log("[content] 消息监听器已设置");
console.log("[content] ======================================");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[content] 收到消息:", message?.type);
  if (message?.type === "PARSE_ITEMS") {
    console.log("[content] 收到 PARSE_ITEMS 消息");
    try {
      const items = parseItems();
      console.log("[content] parseItems 完成，返回", items.length, "项");
      sendResponse({ items });
    } catch (error) {
      console.error("[content] parseItems 出错:", error);
      sendResponse({ items: [], error: error.message });
    }
    return true;
  }
  // ====== 测试：分页累计（不依赖真实DOM分页）======
  if (message?.type === "TEST_SET_PAGE_ITEMS") {
    try {
      const pageItems = Array.isArray(message.pageItems) ? message.pageItems : [];
      const explainId = message.explainId ?? "test-explain";
      const reset = Boolean(message.reset);

      if (reset || state.explainId !== explainId) {
        state.explainId = explainId;
        state.allItemsBySku.clear();
        state.allSkuOrder = [];
        log("content:test_accumulate_reset", { explainId });
      }

      const baseHeaders = buildHeaders();
      const pageResults = pageItems.map((it, idx) => ({
        sku: String(it?.sku ?? `test-${idx + 1}`),
        title: String(it?.title ?? `测试商品${idx + 1}`),
        videoUrl: it?.videoUrl ? String(it.videoUrl) : null,
        headers: it?.headers || baseHeaders,
        hasDownloadButton: Boolean(it?.hasDownloadButton ?? true),
        extractedFromDom: false
      }));

      for (const item of pageResults) {
        const sku = item.sku;
        if (!sku) continue;
        const prev = state.allItemsBySku.get(sku);
        if (!prev) {
          state.allItemsBySku.set(sku, item);
          state.allSkuOrder.push(sku);
          continue;
        }
        const mergedTitle =
          (prev.title && prev.title.length >= (item.title || "").length) ? prev.title : item.title;
        const mergedVideoUrl = prev.videoUrl || item.videoUrl || null;
        state.allItemsBySku.set(sku, {
          ...prev,
          ...item,
          title: mergedTitle,
          videoUrl: mergedVideoUrl,
          headers: prev.headers || item.headers || baseHeaders,
          hasDownloadButton: Boolean(prev.hasDownloadButton || item.hasDownloadButton)
        });
      }

      const mergedResults = state.allSkuOrder
        .map((sku) => state.allItemsBySku.get(sku))
        .filter(Boolean);

      state.items = mergedResults;
      log("content:test_set_page_items_done", { pageCount: pageResults.length, totalCount: mergedResults.length });
      sendResponse({ ok: true, items: mergedResults });
    } catch (e) {
      sendResponse({ ok: false, items: [], error: e?.message || String(e) });
    }
    return true;
  }
  if (message?.type === "TEST_RESET_ACCUMULATOR") {
    const explainId = message.explainId ?? "test-explain";
    state.explainId = explainId;
    state.allItemsBySku.clear();
    state.allSkuOrder = [];
    state.items = [];
    log("content:test_accumulate_reset", { explainId });
    sendResponse({ ok: true });
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

        // 同步写回累计 items（跨页也能拿到）
        const existing = state.allItemsBySku.get(sku);
        if (existing) {
          existing.videoUrl = existing.videoUrl || data.url;
          existing.headers = existing.headers || headers;
          // 不强行修改 hasDownloadButton（它只代表“当前页是否可点击”）
          state.allItemsBySku.set(sku, existing);
          // 同步 state.items（给弹窗刷新用）
          state.items = state.allSkuOrder.map((k) => state.allItemsBySku.get(k)).filter(Boolean);
        }
        
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

// 批量获取所有SKU的视频URL（方案2：不点击）
async function fetchAllSkuVideosFromApi(explainId) {
  try {
    // 关键接口：live_pc_getPageSkuVideo - 获取页面所有SKU的视频信息
    // 从日志看，这个接口在页面加载时已经调用了，我们应该从inject.js的预加载响应中获取
    // 但如果需要主动调用，需要模拟页面的请求格式
    
    log("content:fetching_all_sku_videos", { explainId });
    
    // 方法1：先尝试从inject.js的预加载API响应中获取（如果页面加载时已经调用了）
    if (window.__jdvideoGetPreloadVideoUrl) {
      // 这个函数只能获取单个SKU，我们需要一个能获取所有SKU的函数
      // 先检查是否有批量接口的响应
      log("content:checking_preload_responses");
    }
    
    // 方法2：尝试主动调用接口（但需要正确的参数格式）
    // 从Network日志看，这个接口可能需要特定的参数，我们先尝试简单的调用
    const apiUrl = `https://api.m.jd.com/live_pc_getPageSkuVideo?functionId=live_pc_getPageSkuVideo&appid=plat-live-operate`;
    
    log("content:trying_api_call", { apiUrl, explainId });
    
    // 尝试GET请求（虽然可能失败，但先试试）
    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Referer': window.location.href,
          'User-Agent': navigator.userAgent
        },
        credentials: 'include' // 包含cookie
      });
      
      log("content:api_response_status", { status: response.status, statusText: response.statusText });
      
      if (response.ok) {
        const data = await response.json();
        log("content:getPageSkuVideo_response", { 
          dataKeys: Object.keys(data || {}).slice(0, 30),
          dataSample: JSON.stringify(data).substring(0, 1000) // 输出前1000字符用于调试
        });
        
        // 提取所有SKU的视频URL
        const skuVideos = extractSkuVideosFromResponse(data);
        if (skuVideos && skuVideos.length > 0) {
          log("content:extracted_sku_videos", { count: skuVideos.length, videos: skuVideos });
          return skuVideos; // 返回 [{sku, url}, ...]
        } else {
          log("content:no_sku_videos_extracted", { dataStructure: JSON.stringify(data).substring(0, 500) });
        }
      } else {
        log("content:api_response_not_ok", { status: response.status, statusText: response.statusText });
      }
    } catch (fetchError) {
      log("content:api_fetch_error", { error: fetchError.message, stack: fetchError.stack });
    }
    
  } catch (e) {
    log("content:fetch_all_sku_videos_error", { error: e.message, stack: e.stack });
  }
  
  return null;
}

// 从接口响应中提取所有SKU的视频URL
function extractSkuVideosFromResponse(data) {
  if (!data || typeof data !== 'object') return null;
  
  const results = [];
  
  // 尝试不同的数据结构
  const dataPaths = [
    'data',
    'data.list',
    'data.videos',
    'data.skuVideos',
    'result',
    'result.data',
    'list'
  ];
  
  for (const path of dataPaths) {
    try {
      const target = path.split('.').reduce((obj, key) => obj?.[key], data);
      if (target && Array.isArray(target)) {
        for (const item of target) {
          if (item && typeof item === 'object') {
            const sku = item.sku || item.skuId || item.id;
            const url = item.videoUrl || item.downloadUrl || item.url || item.mp4Url || item.fileUrl;
            if (sku && url && isLikelyVideoUrl(url)) {
              results.push({ sku: String(sku), url: String(url) });
            }
          }
        }
        if (results.length > 0) {
          log("content:extracted_from_path", { path, count: results.length });
          return results;
        }
      } else if (target && typeof target === 'object') {
        // 如果是对象，尝试提取所有字段中的URL
        for (const [key, value] of Object.entries(target)) {
          if (value && typeof value === 'object') {
            const sku = value.sku || value.skuId || value.id || key;
            const url = value.videoUrl || value.downloadUrl || value.url || value.mp4Url || value.fileUrl;
            if (sku && url && isLikelyVideoUrl(url)) {
              results.push({ sku: String(sku), url: String(url) });
            }
          }
        }
        if (results.length > 0) {
          log("content:extracted_from_object", { path, count: results.length });
          return results;
        }
      }
    } catch (e) {
      // ignore
    }
  }
  
  return results.length > 0 ? results : null;
}

// 调用existsPlayUrl接口获取视频URL（备用方案）
async function fetchVideoUrlFromExistsPlayUrl(explainId, sku) {
  try {
    const apiUrl = `https://drlives.jd.com/console/live/existsPlayUrl?liveId=${explainId}`;
    
    log("content:fetching_existsPlayUrl", { explainId, apiUrl });
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Referer': window.location.href
      },
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      const videoUrl = extractUrlFromJsonResponse(data);
      if (videoUrl) {
        log("content:found_url_from_existsPlayUrl", { explainId, url: videoUrl.substring(0, 100) });
        return videoUrl;
      }
    }
  } catch (e) {
    log("content:existsPlayUrl_error", { error: e.message });
  }
  
  return null;
}

// 从JSON响应中提取视频URL
function extractUrlFromJsonResponse(data) {
  if (!data || typeof data !== 'object') return null;
  
  // 常见的响应格式
  const urlPaths = [
    'data.downloadUrl',
    'data.videoUrl',
    'data.url',
    'downloadUrl',
    'videoUrl',
    'url',
    'data.fileUrl',
    'data.mp4Url'
  ];
  
  for (const path of urlPaths) {
    const keys = path.split('.');
    let value = data;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        value = null;
        break;
      }
    }
    if (value && typeof value === 'string' && isLikelyVideoUrl(value)) {
      return value;
    }
  }
  
  // 递归查找
  return extractUrlFromObject(data, null);
}

// 尝试从页面数据中获取视频URL（方案2：不点击）
async function tryExtractVideoUrlFromPage(sku) {
  try {
    // 方法1：尝试从inject.js的预加载API响应中获取
    if (window.__jdvideoGetPreloadVideoUrl) {
      try {
        const url = window.__jdvideoGetPreloadVideoUrl(sku);
        if (url) {
          log("content:found_url_from_preload_api", { sku, url: url.substring(0, 100) });
          return url;
        }
      } catch (e) {
        log("content:preload_api_error", { error: e.message });
      }
    }
    
    // 方法2：从页面URL中提取explain ID，然后主动调用接口
    // 注意：这个现在是同步的，接口调用在autoCaptureUrls中批量执行
    const urlParams = new URLSearchParams(window.location.search);
    const explainId = urlParams.get("id");
    
    if (explainId && sku) {
      log("content:will_try_fetch_from_api", { explainId, sku });
      // 接口调用将在autoCaptureUrls中批量执行
    }
    
    // 方法2：查找页面中的JavaScript数据对象
    // 很多单页应用会在window或全局对象中存储数据
    const possibleDataKeys = [
      'window.__INITIAL_STATE__',
      'window.__APP_DATA__',
      'window.appData',
      'window.pageData',
      'window.videoData',
      'window.downloadData'
    ];
    
    for (const key of possibleDataKeys) {
      try {
        const value = eval(key);
        if (value && typeof value === 'object') {
          const videoUrl = extractUrlFromObject(value, sku);
          if (videoUrl) {
            log("content:found_url_in_global_data", { key, sku, url: videoUrl });
            return videoUrl;
          }
        }
      } catch (e) {
        // ignore
      }
    }
    
    // 方法3：查找DOM中的data属性
    const dataElements = document.querySelectorAll('[data-video-url], [data-download-url], [data-url]');
    for (const el of dataElements) {
      const url = el.getAttribute('data-video-url') || 
                  el.getAttribute('data-download-url') || 
                  el.getAttribute('data-url');
      if (url && isLikelyVideoUrl(url)) {
        log("content:found_url_in_data_attribute", { sku, url });
        return url;
      }
    }
    
    // 方法4：查找页面中所有可能的视频URL链接
    const links = document.querySelectorAll('a[href*=".mp4"], a[href*="transcode"], a[href*="video"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href && isLikelyVideoUrl(href)) {
        log("content:found_url_in_link", { sku, url: href });
        return href;
      }
    }
    
  } catch (e) {
    log("content:extract_video_url_error", { error: e.message });
  }
  
  return null;
}

// 从对象中递归查找视频URL
function extractUrlFromObject(obj, targetSku) {
  if (!obj || typeof obj !== 'object') return null;
  
  // 如果是数组，遍历查找
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractUrlFromObject(item, targetSku);
      if (found) return found;
    }
    return null;
  }
  
  // 查找包含sku或id的字段，匹配目标SKU
  const skuKeys = ['sku', 'skuId', 'id', 'productId'];
  let matchesTarget = false;
  for (const key of skuKeys) {
    if (obj[key] && String(obj[key]) === String(targetSku)) {
      matchesTarget = true;
      break;
    }
  }
  
  // 如果匹配到目标SKU，查找URL字段
  if (matchesTarget) {
    const urlKeys = ['videoUrl', 'downloadUrl', 'url', 'mp4Url', 'fileUrl'];
    for (const key of urlKeys) {
      if (obj[key] && typeof obj[key] === 'string' && isLikelyVideoUrl(obj[key])) {
        return obj[key];
      }
    }
  }
  
  // 递归查找子对象
  for (const key of Object.keys(obj)) {
    if (key !== 'parent' && key !== 'children') { // 避免循环引用
      const found = extractUrlFromObject(obj[key], targetSku);
      if (found) return found;
    }
  }
  
  return null;
}

// 判断是否是视频URL
function isLikelyVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return lower.includes('.mp4') || 
         lower.includes('.m3u8') || 
         lower.includes('transcode') ||
         lower.includes('video') ||
         lower.includes('download');
}

function parseItems() {
  console.log("[content] parseItems 开始执行");
  log("content:parse_start");

  // 讲解页切换时清空累计（避免不同讲解页的数据混在一起）
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const currentExplainId = urlParams.get("id") || null;
    if (state.explainId !== currentExplainId) {
      state.explainId = currentExplainId;
      state.allItemsBySku.clear();
      state.allSkuOrder = [];
      log("content:accumulate_reset_on_explain_change", { explainId: currentExplainId });
    }
  } catch (e) {
    // ignore
  }

  const nodes = document.querySelectorAll(".antd-pro-pages-explain-components-table-list-goodsInfoContent");
  const pageResults = [];
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
    
    // 方案2：尝试从页面数据中提取视频URL（不点击）
    // 优先从inject.js的预加载响应中获取（特别是 live_pc_getPageSkuVideo 接口）
    let videoUrl = null;
    
    // 方法1：从预加载的批量响应中获取（最优先）
    if (window.__jdvideoGetAllPreloadResponses) {
      try {
        const allSkuVideos = window.__jdvideoGetAllPreloadResponses();
        console.log("[content] parseItems 检查预加载数据:", { sku, totalSkuVideos: allSkuVideos.length, allSkus: allSkuVideos.map(r => r.sku) });
        log("content:parse_checking_preload", { sku, totalSkuVideos: allSkuVideos.length, allSkus: allSkuVideos.map(r => r.sku) });
        const matched = allSkuVideos.find(item => item.sku === sku);
        if (matched && matched.url) {
          videoUrl = String(matched.url); // 确保是字符串
          console.log("[content] parseItems 找到匹配的URL:", { sku, url: videoUrl.substring(0, 100) });
          log("content:parse_found_url_from_preload", { sku, url: videoUrl.substring(0, 100) });
          // 保存到capturedUrls
          state.capturedUrls.set(sku, {
            url: videoUrl,
            headers: baseHeaders
          });
        } else {
          console.log("[content] parseItems 未找到匹配的SKU:", { sku, availableSkus: allSkuVideos.map(r => r.sku) });
          log("content:parse_no_match_in_preload", { sku, availableSkus: allSkuVideos.map(r => r.sku) });
        }
      } catch (e) {
        console.error("[content] parseItems 预加载数据提取错误:", e);
        log("content:parse_preload_error", { error: e.message, stack: e.stack });
      }
    } else {
      console.warn("[content] parseItems: __jdvideoGetAllPreloadResponses 函数不可用");
      log("content:parse_preload_function_not_available", { sku });
    }
    
    // 方法2：从单个预加载响应中获取（注意：这是同步的，不返回Promise）
    if (!videoUrl) {
      // tryExtractVideoUrlFromPage 是 async 函数，但在 parseItems 中我们同步调用
      // 所以这里不应该直接调用，应该跳过或使用同步方式
      // videoUrl = tryExtractVideoUrlFromPage(sku); // 这会导致返回 Promise
    }
    
    // 如果方案2没找到，尝试从按钮中读取
    if (!videoUrl) {
      videoUrl = readUrlFromButton(downloadBtn);
    }
    
    // 检查是否已经捕获过
    const captured = state.capturedUrls.get(sku);
    const headers = captured?.headers || baseHeaders;
    if (captured?.url) {
      videoUrl = captured.url;
    }
    
    if (downloadBtn) {
      attachClickHook(downloadBtn, sku);
    }
    // 确保 videoUrl 是字符串或null（绝对不能是 Promise）
    let finalVideoUrl = null;
    if (videoUrl) {
      // 如果是 Promise，直接设为 null（Promise 不应该出现在这里）
      if (videoUrl instanceof Promise) {
        console.error("[content] parseItems: videoUrl 是 Promise，这是错误的！", sku);
        log("content:parse_videourl_is_promise", { sku });
        finalVideoUrl = null;
      } else if (typeof videoUrl === 'string') {
        finalVideoUrl = videoUrl.trim();
      } else if (typeof videoUrl === 'object' && videoUrl !== null) {
        // 如果是对象，尝试提取url字段
        finalVideoUrl = videoUrl.url || videoUrl.videoUrl || videoUrl.src || String(videoUrl).trim();
      } else {
        finalVideoUrl = String(videoUrl).trim();
      }
      // 如果提取后是空字符串，设为null
      if (finalVideoUrl === '' || finalVideoUrl === 'undefined' || finalVideoUrl === 'null') {
        finalVideoUrl = null;
      }
    }
    
    pageResults.push({
      sku,
      title,
      videoUrl: finalVideoUrl,
      headers,
      hasDownloadButton: Boolean(downloadBtn),
      extractedFromDom: Boolean(finalVideoUrl)
    });
  });

  // ========= 分页累计合并（按 SKU 去重）=========
  for (const item of pageResults) {
    const sku = item.sku;
    if (!sku) continue;
    const prev = state.allItemsBySku.get(sku);
    if (!prev) {
      state.allItemsBySku.set(sku, item);
      state.allSkuOrder.push(sku);
      continue;
    }
    // 合并：标题/URL/headers/按钮可见性
    const mergedTitle =
      (prev.title && prev.title.length >= (item.title || "").length) ? prev.title : item.title;
    const mergedVideoUrl = prev.videoUrl || item.videoUrl || null;
    state.allItemsBySku.set(sku, {
      ...prev,
      ...item,
      title: mergedTitle,
      videoUrl: mergedVideoUrl,
      headers: prev.headers || item.headers || baseHeaders,
      hasDownloadButton: Boolean(prev.hasDownloadButton || item.hasDownloadButton)
    });
  }

  const mergedResults = state.allSkuOrder
    .map((sku) => state.allItemsBySku.get(sku))
    .filter(Boolean);

  state.items = mergedResults;
  log("content:parse_done", { pageCount: pageResults.length, totalCount: mergedResults.length });
  return mergedResults;
}

async function autoCaptureUrls(options) {
  try {
    // 方案2优先：先尝试从页面数据中提取（不点击）
    // 如果失败，再使用方案B：自动点击按钮触发接口
    const clickDelay = 2000; // 点击后等待时间（等待fetch请求完成）
    const clickRetries = 2; // 每个按钮最多重试2次
    let success = 0;

    log("content:auto_capture_start_scheme2_first", { clickDelay, clickRetries });
    
    // 确保注入脚本已加载
    ensureInject();
    await wait(500); // 等待注入脚本初始化
    
    // 解析列表，获取所有SKU
    const initialItems = parseItems();
    
    // 方案2：批量调用接口获取所有商品的视频URL
    const urlParams = new URLSearchParams(window.location.search);
    const explainId = urlParams.get("id");
    const missingItems = initialItems.filter((item) => !item.videoUrl);
    
    if (explainId && missingItems.length > 0) {
      log("content:scheme2_fetch_all_sku_videos", { explainId, missingCount: missingItems.length });
      
      // 方法1：先从inject.js的预加载响应中获取（如果页面加载时已经调用了接口）
      let allSkuVideos = [];
      if (window.__jdvideoGetAllPreloadResponses) {
        try {
          allSkuVideos = window.__jdvideoGetAllPreloadResponses();
          log("content:scheme2_from_preload", { count: allSkuVideos.length });
        } catch (e) {
          log("content:scheme2_preload_error", { error: e.message });
        }
      }
      
      // 方法2：如果预加载没有数据，尝试主动调用 live_pc_getPageSkuVideo 接口
      if (allSkuVideos.length === 0) {
        log("content:scheme2_trying_active_api_call");
        const apiSkuVideos = await fetchAllSkuVideosFromApi(explainId);
        if (apiSkuVideos && apiSkuVideos.length > 0) {
          allSkuVideos = apiSkuVideos;
        }
      }
      
      // 保存获取到的视频URL
      if (allSkuVideos && allSkuVideos.length > 0) {
        for (const { sku, url } of allSkuVideos) {
          state.capturedUrls.set(sku, {
            url: url,
            headers: buildHeaders()
          });
          log("content:scheme2_sku_video_saved", { sku, url: url.substring(0, 100) });
        }
        log("content:scheme2_batch_success", { count: allSkuVideos.length });
      } else {
        // 方法3：如果批量接口失败，尝试调用 existsPlayUrl（备用方案，但可能无法区分SKU）
        log("content:scheme2_batch_failed_trying_existsPlayUrl");
        const existsUrl = await fetchVideoUrlFromExistsPlayUrl(explainId);
        if (existsUrl) {
          log("content:scheme2_existsPlayUrl_found", { url: existsUrl.substring(0, 100), note: "但无法确定对应哪个SKU" });
        }
      }
    }
    
    // 重新解析，这次应该包含从接口获取的URL
    const itemsAfterApi = parseItems();
    const extractedByApi = itemsAfterApi.filter((item) => item.videoUrl).length;
    
    if (extractedByApi > 0) {
      log("content:scheme2_api_extracted_urls", { count: extractedByApi });
    }
    
    // 如果方案2（API调用）已经全部提取到，直接返回
    const stillMissing = itemsAfterApi.filter((item) => !item.videoUrl && state.buttonMap.get(item.sku));
    if (stillMissing.length === 0) {
      log("content:all_urls_extracted_by_scheme2_api");
      return {
        ok: true,
        successCount: itemsAfterApi.filter(i => i.videoUrl).length,
        totalTried: itemsAfterApi.length,
        items: itemsAfterApi
      };
    }
    
    // 方案2（API调用）未完全成功，继续使用方案B（自动点击）
    log("content:scheme2_api_partial_success", { 
      extracted: extractedByApi, 
      missing: stillMissing.length,
      falling_back_to_click: true 
    });
    
    let targets = stillMissing;
    const initialSkus = targets.map(item => item.sku);
    
    // 通知background进入捕获模式（用于拦截浏览器下载）
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

    // 自动点击按钮触发fetch请求，然后拦截视频URL
    for (const item of targets) {
      try {
        const btn = state.buttonMap.get(item.sku);
        if (!btn) {
          log("content:auto_capture_no_button", { sku: item.sku });
          continue;
        }
        
        let captured = false;
        for (let attempt = 0; attempt <= clickRetries; attempt++) {
          try {
            // 每次尝试前重新设置pending SKU，确保inject.js能正确绑定
            markPendingSku(item.sku);
            await wait(200); // 给足够时间让pending SKU设置到注入脚本
            
            // 自动点击按钮触发fetch请求
            log("content:auto_click_trigger", { sku: item.sku, attempt: attempt + 1 });
            dispatchHumanClick(btn);
            
            // 等待fetch请求完成并拦截视频URL
            await wait(clickDelay);
            
            // 检查是否捕获到URL
            const currentItems = parseItems();
            const updatedItem = currentItems.find(i => i.sku === item.sku);
            if (updatedItem?.videoUrl) {
              captured = true;
              success += 1;
              log("content:auto_capture_success", { sku: item.sku, attempt: attempt + 1, url: updatedItem.videoUrl });
              break;
            }
          } catch (e) {
            log("content:auto_capture_attempt_error", { sku: item.sku, attempt: attempt + 1, error: e.message });
          }
        }
        
        if (!captured) {
          log("content:auto_capture_miss", { sku: item.sku, attempts: clickRetries + 1 });
        }
        
        // 按钮之间稍作延迟，避免请求过快
        if (item !== targets[targets.length - 1]) {
          await wait(500);
        }
      } catch (e) {
        log("content:auto_capture_item_error", { sku: item.sku, error: e.message });
      }
    }

    // 最终解析
    const finalItems = parseItems();
    const finalCaptured = finalItems.filter((item) => item.videoUrl);
    success = finalCaptured.length;
    
    // 通知background退出捕获模式
    try {
      await chrome.runtime.sendMessage({
        type: "END_CAPTURE_MODE"
      });
      log("content:capture_mode_ended");
    } catch (e) {
      log("content:capture_mode_end_error", { error: e.message });
    }
    
    log("content:auto_capture_done_hybrid", { 
      success, 
      total: finalItems.length 
    });
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

