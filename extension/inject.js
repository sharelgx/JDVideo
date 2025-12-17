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
      lower.includes("download") ||
      lower.includes("transcode"); // 匹配 transcode 关键词（如 discover.300hu.com/transcode）
    const byType = contentType.includes("video") || contentType.includes("mpeg");
    const byOctet = contentType.includes("octet-stream");
    return byExt || byType || byHint || byOctet;
  };

  // 从响应数据中提取SKU（如果接口响应中包含SKU信息）
  const extractSkuFromResponse = (data) => {
    if (!data || typeof data !== "object") return null;
    // 查找常见的SKU字段
    const skuKeys = ["sku", "skuId", "id", "productId", "goodsId"];
    for (const key of skuKeys) {
      if (data[key]) {
        return String(data[key]);
      }
    }
    // 如果data中有data字段，递归查找
    if (data.data && typeof data.data === "object") {
      return extractSkuFromResponse(data.data);
    }
    return null;
  };

  const notifyCapture = (url, meta = {}) => {
    if (!url) return;
    const headers = meta.headers || buildHeaders();
    
    // 尝试从响应数据中提取SKU（如果meta中包含responseData）
    let currentSku = state.pendingSku;
    if (meta.responseData) {
      const responseSku = extractSkuFromResponse(meta.responseData);
      if (responseSku) {
        currentSku = responseSku;
        state.pendingSku = responseSku;
        log("inject:sku_extracted_from_response", { sku: responseSku });
      }
    }
    
    log("inject:capture_url", { url: url.substring(0, 100), sku: currentSku, meta: meta.via });
    
    const payload = {
      source: "jdvideo-inject",
      type: "CAPTURED_URL",
      url,
      sku: currentSku, // 使用提取的SKU
      ts: Date.now(),
      meta: { ...meta, headers }
    };
    
    // 延迟清空pending SKU，确保在异步JSON解析时还能使用
    setTimeout(() => {
      if (state.pendingSku === currentSku) {
        state.pendingSku = null;
      }
    }, 1200); // 延迟1.2秒清空，给JSON响应足够时间
    
    window.postMessage(payload, "*");
  };

  // 检测是否为可能的下载接口（更宽松的匹配）
  const isPapiUrl = (url) => {
    if (!url) return false;
    const lower = url.toLowerCase();
    // 排除明显的静态资源
    if (lower.includes(".css") || lower.includes(".js") || lower.includes(".png") || 
        lower.includes(".jpg") || lower.includes(".gif") || lower.includes(".svg") ||
        lower.includes(".woff") || lower.includes(".ttf") || lower.includes(".ico")) {
      return false;
    }
    // 匹配可能的API接口
    return lower.includes("papi") || 
           lower.includes("/api/") ||
           lower.includes("/papi/") ||
           lower.includes("explain") ||
           lower.includes("download") ||
           lower.includes("video") ||
           lower.includes("file") ||
           lower.includes("transcode") || // 匹配transcode接口
           (lower.includes("jd.com") && (lower.includes("get") || lower.includes("query") || lower.includes("info")));
  };
  
  // 存储页面加载时捕获到的所有可能包含视频URL的API响应
  const preloadApiResponses = new Map(); // url -> { data, timestamp }
  
  // 尝试从预加载的API响应中查找视频URL（用于方案2）
  window.__jdvideoGetPreloadVideoUrl = function(sku) {
    for (const [apiUrl, response] of preloadApiResponses.entries()) {
      try {
        const videoUrl = extractUrlFromJson(response.data);
        if (videoUrl && isLikelyVideo(videoUrl)) {
          // 检查是否匹配SKU（如果响应中包含SKU信息）
          const responseSku = extractSkuFromResponse(response.data);
          if (!responseSku || responseSku === sku) {
            log("inject:found_preload_url", { apiUrl, sku, videoUrl: videoUrl.substring(0, 100) });
            return videoUrl;
          }
        }
      } catch (e) {
        // ignore
      }
    }
    return null;
  };
  
  // 获取所有预加载的API响应（用于批量提取）
  window.__jdvideoGetAllPreloadResponses = function() {
    const results = [];
    for (const [apiUrl, response] of preloadApiResponses.entries()) {
      try {
        // 尝试提取所有SKU的视频URL
        if (response.data && typeof response.data === 'object') {
          const skuVideos = extractAllSkuVideosFromResponse(response.data);
          if (skuVideos && skuVideos.length > 0) {
            results.push(...skuVideos);
            log("inject:found_preload_sku_videos", { apiUrl, count: skuVideos.length });
          }
        }
      } catch (e) {
        // ignore
      }
    }
    return results;
  };
  
  // 从响应中提取所有SKU的视频URL
  function extractAllSkuVideosFromResponse(data) {
    if (!data || typeof data !== 'object') return [];
    
    const results = [];
    
    // 优先查找常见的数据结构路径（根据日志，可能是 data.list 或类似结构）
    const commonPaths = [
      'data.list',
      'data.data.list',
      'data.records',
      'data.items',
      'data.videos',
      'data.skuVideos',
      'result.data.list',
      'list',
      'data'
    ];
    
    // 先尝试从常见路径提取
    for (const path of commonPaths) {
      try {
        const target = path.split('.').reduce((obj, key) => obj?.[key], data);
        if (target && Array.isArray(target) && target.length > 0) {
          log("inject:found_array_at_path", { path, length: target.length, firstItemKeys: Object.keys(target[0] || {}).slice(0, 15) });
          // 输出第一个元素的完整内容用于调试
          if (target[0]) {
            log("inject:first_item_sample", { path, firstItem: JSON.stringify(target[0]).substring(0, 500) });
          }
          for (const item of target) {
            if (item && typeof item === 'object') {
              const skuKeys = ['sku', 'skuId', 'id', 'productId', 'goodsId', 'itemId'];
              const urlKeys = ['videoUrl', 'downloadUrl', 'url', 'mp4Url', 'fileUrl', 'video', 'download', 'file', 'playUrl'];
              
              let foundSku = null;
              let foundUrl = null;
              
              // 查找SKU
              for (const key of skuKeys) {
                if (item[key] && (typeof item[key] === 'string' || typeof item[key] === 'number')) {
                  foundSku = String(item[key]);
                  break;
                }
              }
              
              // 查找视频URL
              for (const key of urlKeys) {
                const val = item[key];
                if (val && typeof val === 'string' && isLikelyVideo(val)) {
                  foundUrl = val;
                  break;
                }
              }
              
              // 如果找到SKU和URL，添加到结果
              if (foundSku && foundUrl) {
                const exists = results.some(r => r.sku === foundSku);
                if (!exists) {
                  results.push({ sku: foundSku, url: foundUrl });
                  log("inject:extracted_sku_video_pair", { sku: foundSku, url: foundUrl.substring(0, 100), path });
                }
              } else if (foundUrl) {
                // 如果只有URL没有SKU，记录一下（可能需要从其他地方获取SKU）
                log("inject:found_url_without_sku", { url: foundUrl.substring(0, 100), path, itemKeys: Object.keys(item).slice(0, 10) });
              }
            }
          }
          if (results.length > 0) {
            log("inject:extractAllSkuVideos_success_from_path", { path, count: results.length });
            return results;
          }
        }
      } catch (e) {
        // ignore
      }
    }
    
    // 如果常见路径没找到，使用递归查找（兜底方案）
    function extractFromObject(obj, path = '', depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 6) return;
      
      if (Array.isArray(obj)) {
        for (const item of obj) {
          extractFromObject(item, path, depth + 1);
        }
        return;
      }
      
      const skuKeys = ['sku', 'skuId', 'id', 'productId', 'goodsId', 'itemId'];
      const urlKeys = ['videoUrl', 'downloadUrl', 'url', 'mp4Url', 'fileUrl', 'video', 'download', 'file'];
      
      let foundSku = null;
      let foundUrl = null;
      
      for (const key of skuKeys) {
        if (obj[key] && (typeof obj[key] === 'string' || typeof obj[key] === 'number')) {
          foundSku = String(obj[key]);
          break;
        }
      }
      
      for (const key of urlKeys) {
        const val = obj[key];
        if (val && typeof val === 'string' && isLikelyVideo(val)) {
          foundUrl = val;
          break;
        }
      }
      
      if (foundSku && foundUrl) {
        const exists = results.some(r => r.sku === foundSku);
        if (!exists) {
          results.push({ sku: foundSku, url: foundUrl });
        }
      }
      
      for (const key of Object.keys(obj)) {
        if (key !== 'parent' && key !== 'children' && obj[key] && typeof obj[key] === 'object') {
          extractFromObject(obj[key], path ? `${path}.${key}` : key, depth + 1);
        }
      }
    }
    
    extractFromObject(data);
    
    log("inject:extractAllSkuVideos_result", { count: results.length, skus: results.map(r => r.sku) });
    
    return results;
  }

  // 从请求URL或body中提取SKU
  const extractSkuFromRequest = (reqUrl, args) => {
    // 从URL参数中提取
    try {
      const urlObj = new URL(reqUrl, window.location.origin);
      const sku = urlObj.searchParams.get("sku") || 
                  urlObj.searchParams.get("id") ||
                  urlObj.searchParams.get("skuId");
      if (sku) return sku;
    } catch (e) {}
    
    // 从URL路径中提取（如 /api/video/123456）
    const skuMatch = reqUrl.match(/\/(\d{6,})/);
    if (skuMatch) return skuMatch[1];
    
    // 尝试从请求body中提取（如果是POST请求）
    try {
      if (args[1] && typeof args[1].body === "string") {
        const bodyObj = JSON.parse(args[1].body);
        const sku = bodyObj.sku || bodyObj.id || bodyObj.skuId;
        if (sku) return String(sku);
      }
    } catch (e) {}
    
    return null;
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
      
      // 记录所有请求（用于调试）
      if (reqUrl && !reqUrl.includes(".css") && !reqUrl.includes(".js") && !reqUrl.includes(".png")) {
        log("inject:fetch_request", { url: reqUrl.substring(0, 150), contentType: ctype });
      }
      
      // 优先处理PAPI接口
      const isPapi = isPapiUrl(reqUrl);
      
      // 从请求中提取SKU（优先级：请求参数 > pendingSku）
      let requestSku = extractSkuFromRequest(reqUrl, args);
      if (requestSku && !state.pendingSku) {
        state.pendingSku = requestSku;
        log("inject:sku_extracted_from_request", { sku: requestSku, url: reqUrl });
      }
      
      if (isVideoUrl(reqUrl, response?.headers)) {
        notifyCapture(reqUrl, { via: isPapi ? "fetch_papi_direct" : "fetch" });
      } else if (/json/i.test(ctype)) {
        // 对于PAPI接口或任何JSON响应，都尝试提取视频URL
        const cloned = response.clone();
        const pendingSkuSnapshot = requestSku || state.pendingSku;
        cloned
          .json()
          .then((data) => {
            // 方案2：保存所有API响应（即使暂时没有视频URL），供后续查询使用
            if (isPapi || reqUrl.includes("explain") || reqUrl.includes("transcode")) {
              preloadApiResponses.set(reqUrl, {
                data: data,
                timestamp: Date.now()
              });
              // 只保留最近30秒的响应
              const now = Date.now();
              for (const [url, resp] of preloadApiResponses.entries()) {
                if (now - resp.timestamp > 30000) {
                  preloadApiResponses.delete(url);
                }
              }
            }
            
            // 增强的URL提取：支持更多字段名
            const url = extractUrlFromJson(data);
            if (url && isLikelyVideo(url)) {
              // 如果从请求中提取到了SKU，使用它；否则尝试从响应中提取
              if (requestSku) {
                state.pendingSku = requestSku;
              } else {
                // 尝试从响应数据中提取SKU
                const responseSku = extractSkuFromResponse(data);
                if (responseSku) {
                  state.pendingSku = responseSku;
                } else if (!state.pendingSku && pendingSkuSnapshot) {
                  state.pendingSku = pendingSkuSnapshot;
                }
              }
              
              log("inject:papi_url_extracted", { 
                url: url.substring(0, 100), 
                sku: state.pendingSku,
                isPapi,
                via: isPapi ? "fetch_papi_json" : "fetch_json"
              });
              notifyCapture(url, { 
                via: isPapi ? "fetch_papi_json" : "fetch_json",
                responseData: data // 传递响应数据以便提取SKU
              });
            } else if (isPapi) {
              // PAPI接口但未找到URL，记录详细日志用于调试
              log("inject:papi_no_url", { 
                url: reqUrl, 
                dataKeys: Object.keys(data || {}).slice(0, 20),
                dataSample: JSON.stringify(data).substring(0, 500) // 输出前500字符用于调试
              });
            }
          })
          .catch((e) => {
            if (isPapi) {
              log("inject:papi_parse_error", { url: reqUrl, error: e.message });
            }
          });
      } else if (state.pendingSku && !/text\/html/i.test(ctype)) {
        // 当存在待绑定 SKU 且非明显 HTML 时，兜底抓取
        notifyCapture(reqUrl, { via: isPapi ? "fetch_papi_fallback" : "fetch_fallback" });
      } else {
        if (isPapi) {
          log("inject:papi_fetch_skip", { url: reqUrl, ctype });
        } else {
          log("inject:fetch_skip", { url: reqUrl });
        }
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
    // 从请求URL中提取SKU
    try {
      const reqUrl = args[1] || "";
      const extractedSku = extractSkuFromRequest(reqUrl, [null, this._jdvideoUrl]);
      if (extractedSku && !state.pendingSku) {
        this._jdvideoExtractedSku = extractedSku;
        state.pendingSku = extractedSku;
        log("inject:xhr_sku_extracted", { sku: extractedSku, url: reqUrl });
      }
    } catch (e) {}
    return origOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const pendingSkuSnapshot = this._jdvideoExtractedSku || state.pendingSku;
    const reqUrl = this.responseURL || this._jdvideoUrl || "";
    const isPapi = isPapiUrl(reqUrl);
    
    // 记录所有XHR请求（用于调试）
    if (reqUrl && !reqUrl.includes(".css") && !reqUrl.includes(".js") && !reqUrl.includes(".png")) {
      log("inject:xhr_request", { url: reqUrl.substring(0, 150) });
    }
    
    this.addEventListener(
      "load",
      () => {
        try {
          const url = this.responseURL || this._jdvideoUrl;
          const contentType = this.getResponseHeader("content-type") || "";
          
          // 如果pending SKU已被清空，尝试恢复（仅在很短时间内）
          if (!state.pendingSku && pendingSkuSnapshot) {
            state.pendingSku = pendingSkuSnapshot;
          }
          
          // 特别处理 live_pc_getPageSkuVideo 接口，无论是什么格式都尝试解析
          const isGetPageSkuVideo = url.includes("getPageSkuVideo");
          
          // 排除接口URL本身（不是真正的视频URL）
          const isActualVideoUrl = isVideoUrl(url, { get: () => contentType }) && 
                                   !url.includes("getPageSkuVideo") && 
                                   !url.includes("api.m.jd.com");
          
          if (isActualVideoUrl) {
            notifyCapture(url, { via: isPapi ? "xhr_papi_direct" : "xhr" });
          } else if (/json/i.test(contentType) || isGetPageSkuVideo) {
            try {
              const data = JSON.parse(this.responseText || "{}");
              
              // 方案2：保存所有API响应（特别是 live_pc_getPageSkuVideo），供后续批量提取
              if (isPapi || isGetPageSkuVideo || reqUrl.includes("explain") || reqUrl.includes("transcode")) {
                preloadApiResponses.set(reqUrl, {
                  data: data,
                  timestamp: Date.now()
                });
                // 只保留最近30秒的响应
                const now = Date.now();
                for (const [url, resp] of preloadApiResponses.entries()) {
                  if (now - resp.timestamp > 30000) {
                    preloadApiResponses.delete(url);
                  }
                }
                log("inject:preload_response_saved", { 
                  url: reqUrl.substring(0, 100), 
                  dataKeys: Object.keys(data || {}).slice(0, 10),
                  isGetPageSkuVideo: isGetPageSkuVideo
                });
                
                // 对于 getPageSkuVideo 接口，输出完整的响应结构用于调试
                if (isGetPageSkuVideo) {
                  log("inject:getPageSkuVideo_full_response", { 
                    fullData: JSON.stringify(data).substring(0, 5000), // 输出前5000字符
                    dataStructure: JSON.stringify(data, null, 2).substring(0, 5000) // 格式化的完整结构
                  });
                  // 也输出到控制台，方便查看完整数据
                  console.log("[jdvideo] getPageSkuVideo 完整响应对象:", data);
                  console.log("[jdvideo] getPageSkuVideo 完整JSON字符串:", JSON.stringify(data, null, 2));
                  
                  // 立即尝试提取所有SKU视频
                  const allSkuVideos = extractAllSkuVideosFromResponse(data);
                  console.log("[jdvideo] 从getPageSkuVideo提取到的SKU视频列表:", allSkuVideos);

                  // 将批量 SKU->URL 映射推送给 content script（避免隔离世界无法直接读取 window 函数/变量）
                  if (allSkuVideos && allSkuVideos.length > 0) {
                    try {
                      window.postMessage(
                        {
                          source: "jdvideo-inject",
                          type: "SKU_VIDEOS_BULK",
                          items: allSkuVideos,
                          ts: Date.now(),
                          meta: { apiUrl: reqUrl }
                        },
                        "*"
                      );
                      log("inject:sku_videos_bulk_posted", { count: allSkuVideos.length, apiUrl: reqUrl.substring(0, 120) });
                    } catch (e) {
                      log("inject:sku_videos_bulk_post_error", { error: e.message });
                    }
                  }
                  
                  if (allSkuVideos.length === 0) {
                    console.warn("[jdvideo] 警告：未能从getPageSkuVideo响应中提取到SKU视频映射，请检查数据结构");
                  }
                }
              }
              
              const videoUrl = extractUrlFromJson(data);
              if (videoUrl && isLikelyVideo(videoUrl)) {
                // 尝试从响应数据中提取SKU
                const responseSku = extractSkuFromResponse(data);
                if (responseSku) {
                  state.pendingSku = responseSku;
                } else if (!state.pendingSku && pendingSkuSnapshot) {
                  state.pendingSku = pendingSkuSnapshot;
                }
                
                log("inject:papi_xhr_url_extracted", { 
                  url: videoUrl.substring(0, 100), 
                  sku: state.pendingSku,
                  isPapi,
                  via: isPapi ? "xhr_papi_json" : "xhr_json"
                });
                notifyCapture(videoUrl, { 
                  via: isPapi ? "xhr_papi_json" : "xhr_json",
                  responseData: data // 传递响应数据以便提取SKU
                });
                return;
              } else if (isPapi || reqUrl.includes("getPageSkuVideo")) {
                // PAPI接口或getPageSkuVideo接口但未找到URL，记录详细日志用于调试
                log("inject:papi_xhr_no_url", { 
                  url: reqUrl, 
                  dataKeys: Object.keys(data || {}).slice(0, 30),
                  dataSample: JSON.stringify(data).substring(0, 1000) // 输出前1000字符用于调试
                });
              }
            } catch (e) {
              if (isPapi || reqUrl.includes("getPageSkuVideo")) {
                log("inject:papi_xhr_parse_error", { url: reqUrl, error: e.message });
              }
            }
          } else if (state.pendingSku || pendingSkuSnapshot) {
            // 使用当前pending SKU或快照
            if (!state.pendingSku && pendingSkuSnapshot) {
              state.pendingSku = pendingSkuSnapshot;
            }
            notifyCapture(url, { via: isPapi ? "xhr_papi_fallback" : "xhr_fallback" });
          } else {
            if (isPapi) {
              log("inject:papi_xhr_skip", { url, contentType });
            } else {
              log("inject:xhr_skip", { url });
            }
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
      // 同时输出到控制台（方便调试）
      console.log("[jdvideo-inject]", event, payload || "");
      
      // 发送给content script
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
      // 优先查找常见的下载地址字段（按优先级）
      const priorityKeys = [
        "downloadUrl", "download_url", "download", "downloadLink",
        "videoUrl", "video_url", "video", "videoLink",
        "url", "fileUrl", "file_url", "file",
        "mp4Url", "mp4_url", "mp4",
        "m3u8Url", "m3u8_url", "m3u8",
        "playUrl", "play_url", "play",
        "source", "src", "link"
      ];
      
      // 先按优先级查找
      for (const key of priorityKeys) {
        if (obj[key] && typeof obj[key] === "string" && isLikelyVideo(obj[key])) {
          return obj[key];
        }
      }
      
      // 如果data字段存在，递归查找
      if (obj.data) {
        const found = extractUrlFromJson(obj.data);
        if (found) return found;
      }
      
      // 遍历所有字段查找
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


