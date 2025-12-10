const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY = 2;
const LOG_LIMIT = 300;
const logs = [];
const DEFAULT_LOG_ENDPOINT = "http://127.0.0.1:3030/log";
let logEndpoint = DEFAULT_LOG_ENDPOINT;

// 存储用户选择的下载目录
let savedDownloadDirectory = null;

// 跟踪需要提取目录的下载ID（首次下载时）
const pendingDirectoryExtractions = new Set();

// 捕获模式：用于拦截自动捕获时触发的下载
let captureMode = false;
const capturingSkus = new Set();
// 追踪捕获模式下创建的下载，用于拦截
const captureModeDownloads = new Map(); // downloadId -> { sku, url, timestamp }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_DOWNLOADS") {
    const { items = [], options = {} } = message;
    log("bg:start_downloads", { count: items.length });
    runDownloadQueue(items, options).then(() => {
      notifyProgress({ stage: "queue_completed" });
      log("bg:queue_completed");
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "SET_DOWNLOAD_DIRECTORY") {
    // 设置下载目录
    savedDownloadDirectory = message.directory || null;
    chrome.storage.local.set({ downloadDirectory: savedDownloadDirectory });
    log("bg:directory_saved", { directory: savedDownloadDirectory });
    sendResponse({ ok: true, directory: savedDownloadDirectory });
    return true;
  }
  if (message?.type === "GET_DOWNLOAD_DIRECTORY") {
    // 获取保存的下载目录
    chrome.storage.local.get(["downloadDirectory"]).then((result) => {
      savedDownloadDirectory = result.downloadDirectory || null;
      sendResponse({ ok: true, directory: savedDownloadDirectory });
    });
    return true;
  }
  if (message?.type === "GET_LOGS") {
    sendResponse({ ok: true, logs: [...logs], logEndpoint });
    return true;
  }
  if (message?.type === "LOG") {
    log(message.event || "log", {
      origin: message.origin || sender?.url || "unknown",
      data: message.data
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "SET_LOG_ENDPOINT") {
    logEndpoint = message.url || DEFAULT_LOG_ENDPOINT;
    sendResponse({ ok: true, logEndpoint });
    return true;
  }
  if (message?.type === "START_CAPTURE_MODE") {
    // 进入捕获模式
    captureMode = true;
    capturingSkus.clear();
    captureModeDownloads.clear();
    const skus = message.skus || [];
    skus.forEach(sku => capturingSkus.add(sku));
    log("bg:capture_mode_start", { 
      skus: skus.length, 
      skuList: Array.from(capturingSkus).slice(0, 5) // 只记录前5个SKU，避免日志过长
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "END_CAPTURE_MODE") {
    // 退出捕获模式
    captureMode = false;
    const capturedCount = captureModeDownloads.size;
    captureModeDownloads.clear();
    log("bg:capture_mode_end", { intercepted: capturedCount });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// 初始化时加载保存的目录
chrome.storage.local.get(["downloadDirectory"]).then((result) => {
  savedDownloadDirectory = result.downloadDirectory || null;
});

// 全局监听下载创建事件，用于立即拦截捕获模式下的下载
chrome.downloads.onCreated.addListener((downloadItem) => {
  const downloadUrl = downloadItem.url || "";
  const downloadId = downloadItem.id;
  
  log("bg:download_created", {
    downloadId,
    url: downloadUrl.substring(0, 100),
    captureMode,
    capturingSkusCount: capturingSkus.size,
    mimeType: downloadItem.mimeType,
    state: downloadItem.state
  });
  
  // 如果是在捕获模式下，立即拦截（不等待onDeterminingFilename）
  if (captureMode && capturingSkus.size > 0) {
    const urlLowerCreated = downloadUrl.toLowerCase();
    const isVideoUrlCreated = urlLowerCreated.includes(".mp4") ||
                              urlLowerCreated.includes(".m3u8") ||
                              urlLowerCreated.includes(".flv") ||
                              urlLowerCreated.includes(".ts") ||
                              urlLowerCreated.includes(".avi") ||
                              urlLowerCreated.includes(".mov") ||
                              urlLowerCreated.includes("video") ||
                              urlLowerCreated.includes("vod") ||
                              urlLowerCreated.includes("stream") ||
                              urlLowerCreated.includes("media") ||
                              downloadItem.mimeType?.includes("video") ||
                              downloadItem.mimeType?.includes("mpeg") ||
                              (downloadUrl && downloadUrl.length > 10 && !urlLowerCreated.includes(".html") && !urlLowerCreated.includes(".htm"));
    
    // 在捕获模式下拦截所有可能的视频下载
    if (isVideoUrlCreated) {
      // 尝试匹配SKU
      let matchedSku = null;
      for (const sku of capturingSkus) {
        if (downloadUrl.includes(sku)) {
          matchedSku = sku;
          break;
        }
      }
      
      // 记录拦截信息
      captureModeDownloads.set(downloadId, {
        sku: matchedSku || "auto-detected",
        url: downloadUrl,
        timestamp: Date.now()
      });
      
      log("bg:capture_intercept_cancelling", {
        downloadId,
        url: downloadUrl.substring(0, 100),
        sku: matchedSku || "auto-detected",
        method: "onCreated_cancel"
      });
      
      // 立即取消下载（不等待）
      chrome.downloads.cancel(downloadId, () => {
        if (chrome.runtime.lastError) {
          log("bg:capture_cancel_error", {
            downloadId,
            error: chrome.runtime.lastError.message
          });
        } else {
          log("bg:capture_cancelled_success", {
            downloadId,
            url: downloadUrl.substring(0, 100)
          });
        }
      });
      
      // 延迟删除下载记录
      setTimeout(() => {
        chrome.downloads.removeFile(downloadId, () => {});
        chrome.downloads.erase({ id: downloadId }, () => {});
      }, 1000);
    }
  }
});

// 全局监听下载文件名确定事件，用于提取用户选择的目录和拦截捕获模式下载
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const downloadUrl = downloadItem.url || "";
  const downloadId = downloadItem.id;
  
  // ========== 优先级1：捕获模式拦截（必须在最前面，阻止下载）==========
  log("bg:onDeterminingFilename", {
    downloadId,
    url: downloadUrl.substring(0, 100),
    captureMode,
    capturingSkusCount: capturingSkus.size,
    alreadyInMap: captureModeDownloads.has(downloadId)
  });
  
  if (captureMode && capturingSkus.size > 0) {
    const urlLower = downloadUrl.toLowerCase();
    // 更宽松的视频URL检测
    const isVideoUrl = urlLower.includes(".mp4") ||
                       urlLower.includes(".m3u8") ||
                       urlLower.includes(".flv") ||
                       urlLower.includes(".ts") ||
                       urlLower.includes(".avi") ||
                       urlLower.includes(".mov") ||
                       urlLower.includes(".mkv") ||
                       urlLower.includes("video") ||
                       urlLower.includes("vod") ||
                       urlLower.includes("stream") ||
                       urlLower.includes("media") ||
                       downloadItem.mimeType?.includes("video") ||
                       downloadItem.mimeType?.includes("mpeg") ||
                       (downloadUrl && downloadUrl.length > 10 && !urlLower.includes(".html") && !urlLower.includes(".htm"));
    
    // 检查是否已经在onCreated中被标记为要拦截
    const shouldBlock = captureModeDownloads.has(downloadId) || isVideoUrl;
    
    if (shouldBlock) {
      // 尝试匹配SKU
      let matchedSku = null;
      for (const sku of capturingSkus) {
        if (downloadUrl.includes(sku)) {
          matchedSku = sku;
          break;
        }
      }
      
      // 记录拦截
      if (!captureModeDownloads.has(downloadId)) {
        captureModeDownloads.set(downloadId, {
          sku: matchedSku || "auto-detected",
          url: downloadUrl,
          timestamp: Date.now()
        });
      }
      
      log("bg:capture_intercept_blocked_onDeterminingFilename", { 
        downloadId,
        url: downloadUrl.substring(0, 100),
        sku: matchedSku || "auto-detected",
        isVideoUrl,
        method: "onDeterminingFilename_no_suggest"
      });
      
      // 关键：不调用suggest()，这会阻止下载
      return; // 直接返回，不调用suggest()
    }
  }
  
  // ========== 优先级2：目录提取（用户选择目录）==========
  if (pendingDirectoryExtractions.has(downloadId)) {
    pendingDirectoryExtractions.delete(downloadId);
    
    // 从完整路径中提取目录
    const fullPath = downloadItem.filename;
    if (fullPath && (fullPath.includes("/") || fullPath.includes("\\"))) {
      const dirMatch = fullPath.match(/^(.+)[\\/][^\\/]+$/);
      if (dirMatch && dirMatch[1]) {
        let selectedDir = dirMatch[1];
        selectedDir = selectedDir.replace(/\\/g, "/");
        savedDownloadDirectory = selectedDir;
        chrome.storage.local.set({ downloadDirectory: selectedDir });
        log("bg:directory_selected", { directory: selectedDir, fullPath });
      }
    } else {
      log("bg:directory_selection_cancelled", { downloadId });
    }
  }
  
  // ========== 允许下载继续 ==========
  suggest({ filename: downloadItem.filename });
});

function log(event, data) {
  const entry = {
    ts: Date.now(),
    event,
    data
  };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.shift();
  console.debug("[jdvideo]", event, data || "");
  // 可选：仍然支持日志上报到Python服务（如果配置了的话）
  postLog(entry);
}

function postLog(entry) {
  try {
    const url = logEndpoint || DEFAULT_LOG_ENDPOINT;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    }).catch(() => {});
  } catch (e) {
    // ignore
  }
}

function sanitizeFilenamePart(input) {
  return (input || "unknown").replace(/[\\/:*?"<>|]/g, "_").trim();
}

function sanitizeFolder(input) {
  if (!input) return "";
  // 去掉首尾斜杠和非法字符，避免跳出默认下载目录
  return input
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .split(/[\\/]+/)
    .map((seg) => sanitizeFilenamePart(seg))
    .filter(Boolean)
    .join("/");
}

function buildFilename(item, options) {
  const sku = sanitizeFilenamePart(item.sku || "unknown");
  const title = sanitizeFilenamePart(item.title || "video");
  const base = `${sku}_${title}.mp4`;
  
  // 如果用户选择了下载目录，构建完整路径
  if (savedDownloadDirectory) {
    // 确保目录路径格式正确（使用/分隔符）
    const dir = savedDownloadDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
    return `${dir}/${base}`;
  }
  
  // 如果没有选择目录，只返回文件名（下载到浏览器默认目录）
  return base;
}

async function runDownloadQueue(items, options) {
  const concurrency = Number(options.concurrency) || DEFAULT_CONCURRENCY;
  const retry = Number(options.retry) || DEFAULT_RETRY;
  let index = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (index >= items.length && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && index < items.length) {
        const item = items[index++];
        active++;
        downloadWithRetry(item, retry, options)
          .catch((error) => {
            console.error("Download failed:", error);
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

async function downloadWithRetry(item, retry, options) {
  let attempts = 0;
  while (attempts <= retry) {
    try {
      if (!item.videoUrl) {
        throw new Error("缺少视频地址");
      }
      notifyProgress({ stage: "downloading", sku: item.sku, title: item.title, videoUrl: item.videoUrl });
      const downloadId = await triggerDownload(item, options);
      notifyProgress({ stage: "success", sku: item.sku, title: item.title, videoUrl: item.videoUrl, downloadId });
      return;
    } catch (error) {
      attempts += 1;
      const isLast = attempts > retry;
      notifyProgress({
        stage: isLast ? "failed" : "retrying",
        sku: item.sku,
        title: item.title,
        videoUrl: item.videoUrl,
        error: error?.message || String(error),
        attempt: attempts
      });
      if (isLast) throw error;
      await wait(400 * attempts);
    }
  }
}

async function triggerDownload(item, options) {
  const filename = buildFilename(item, options);
  
  // 检查是否首次下载（未选择目录）
  const needsDirectorySelection = !savedDownloadDirectory;
  
  // 如果首次下载，需要让用户选择目录
  if (needsDirectorySelection) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: item.videoUrl,
          filename: filename,
          conflictAction: "uniquify",
          saveAs: true // 首次下载时让用户选择目录
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            // 标记这个下载ID需要提取目录
            pendingDirectoryExtractions.add(downloadId);
            resolve(downloadId);
          }
        }
      );
    });
  }
  
  // 后续下载：使用保存的目录，不弹框
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: item.videoUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false // 不弹框，直接下载到已选择的目录
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyProgress(payload) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", ...payload }, () => {
    // 忽略可能的未监听错误
  });
}




