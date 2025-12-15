const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY = 2;
const LOG_LIMIT = 300;
const logs = [];
const DEFAULT_LOG_ENDPOINT = "http://127.0.0.1:3030/log";
let logEndpoint = DEFAULT_LOG_ENDPOINT;

// 存储用户选择的下载目录
let savedDownloadDirectory = null;
// 标志：用户是否已经确认过一次下载位置（即使无法提取绝对目录，也用于避免每个文件都弹框）
let hasConfirmedDownloadLocation = false;
// 某些浏览器环境下 `chrome.downloads.download({ filename })` 可能不接受绝对路径。
// 用于在失败时自动回退到“仅文件名（默认下载目录）”模式，避免整队列失败。
let disableDirectoryPrefixForFilename = false;

// 跟踪需要提取目录的下载ID（首次下载时）
const pendingDirectoryExtractions = new Set();

// 标志：是否正在等待用户选择目录（避免多个下载同时弹框）
let isWaitingForDirectorySelection = false;
// 全局Promise：确保目录选择是原子的，所有等待的下载共享同一个Promise
let directorySelectionPromise = null;
// 锁：用于确保创建Promise的操作是原子的（防止并发创建）
let isCreatingDirectorySelectionPromise = false;

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
    disableDirectoryPrefixForFilename = false;
    hasConfirmedDownloadLocation = Boolean(savedDownloadDirectory);
    chrome.storage.local.set({ downloadDirectory: savedDownloadDirectory });
    log("bg:directory_saved", { directory: savedDownloadDirectory });
    sendResponse({ ok: true, directory: savedDownloadDirectory });
    return true;
  }
  if (message?.type === "GET_DOWNLOAD_DIRECTORY") {
    // 获取保存的下载目录
    chrome.storage.local.get(["downloadDirectory", "downloadDirectoryConfirmed"]).then((result) => {
      savedDownloadDirectory = result.downloadDirectory || null;
      hasConfirmedDownloadLocation = Boolean(result.downloadDirectoryConfirmed) || Boolean(savedDownloadDirectory);
      sendResponse({ ok: true, directory: savedDownloadDirectory, confirmed: hasConfirmedDownloadLocation });
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
chrome.storage.local.get(["downloadDirectory", "downloadDirectoryConfirmed"]).then((result) => {
  savedDownloadDirectory = result.downloadDirectory || null;
  hasConfirmedDownloadLocation = Boolean(result.downloadDirectoryConfirmed) || Boolean(savedDownloadDirectory);
});

// 监听下载项变化：用于在 saveAs=true 的首次下载中，等用户真正选完路径后提取目录。
// 注意：onDeterminingFilename 触发时通常还没完成用户选择，因此不能依赖 downloadItem.filename。
chrome.downloads.onChanged.addListener((delta) => {
  try {
    const downloadId = delta?.id;
    if (!downloadId) return;
    if (!pendingDirectoryExtractions.has(downloadId)) return;
    const fullPath = delta?.filename?.current;
    if (!fullPath || typeof fullPath !== "string") return;

    // 只要 filename 有了最终值，就视为用户已经确认过保存位置（用于避免每个文件都弹框）
    if (!hasConfirmedDownloadLocation) {
      hasConfirmedDownloadLocation = true;
      chrome.storage.local.set({ downloadDirectoryConfirmed: true });
      log("bg:download_location_confirmed_onChanged", { downloadId, fullPath });
    }

    // 从完整路径中提取目录
    if (fullPath.includes("/") || fullPath.includes("\\")) {
      const dirMatch = fullPath.match(/^(.+)[\\/][^\\/]+$/);
      if (dirMatch && dirMatch[1]) {
        let selectedDir = dirMatch[1];
        selectedDir = selectedDir.replace(/\\/g, "/");
        savedDownloadDirectory = selectedDir;
        chrome.storage.local.set({ downloadDirectory: savedDownloadDirectory });
        pendingDirectoryExtractions.delete(downloadId);
        isWaitingForDirectorySelection = false;
        log("bg:directory_selected_onChanged", { directory: savedDownloadDirectory, fullPath });
      }
    }
  } catch (e) {
    // ignore
  }
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
    // 从完整路径中提取目录
    const fullPath = downloadItem.filename;
    // 只要能走到这里，说明用户已进入过保存流程；标记“已确认过位置”
    if (!hasConfirmedDownloadLocation) {
      hasConfirmedDownloadLocation = true;
      chrome.storage.local.set({ downloadDirectoryConfirmed: true });
      log("bg:download_location_confirmed_onDeterminingFilename", { downloadId, fullPath: String(fullPath || "").substring(0, 120) });
    }
    if (fullPath && (fullPath.includes("/") || fullPath.includes("\\"))) {
      const dirMatch = fullPath.match(/^(.+)[\\/][^\\/]+$/);
      if (dirMatch && dirMatch[1]) {
        let selectedDir = dirMatch[1];
        selectedDir = selectedDir.replace(/\\/g, "/");
        savedDownloadDirectory = selectedDir;
        chrome.storage.local.set({ downloadDirectory: selectedDir });
        log("bg:directory_selected", { directory: selectedDir, fullPath });
        pendingDirectoryExtractions.delete(downloadId);
        
        // 清除等待标志，允许后续下载使用已选择的目录
        // 注意：directorySelectionPromise会在triggerDownload中的定时检查中自动resolve
        isWaitingForDirectorySelection = false;
      }
    } else {
      log("bg:directory_selection_cancelled", { downloadId });
      pendingDirectoryExtractions.delete(downloadId);
      // 如果用户取消了选择，清除标志和Promise，允许下次再试
      isWaitingForDirectorySelection = false;
      directorySelectionPromise = null;
      isCreatingDirectorySelectionPromise = false;
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
  const variantIndex = Number(item.variantIndex || 0);
  const variantTotal = Number(item.variantTotal || 0);
  const variantSuffix =
    variantIndex > 0 && variantTotal > 1 ? `_${variantIndex}` : "";
  const base = `${sku}_${title}${variantSuffix}.mp4`;
  
  // 如果用户选择了下载目录，构建完整路径
  if (savedDownloadDirectory && !disableDirectoryPrefixForFilename) {
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
        // 使用await确保第一个下载先执行（如果还未选择目录）
        // 但这在并发场景下可能不够，所以我们在triggerDownload中使用Promise机制
        downloadWithRetry(item, retry, options)
          .catch((error) => {
            console.error("Download failed:", error);
            log("bg:download_queue_error", { sku: item.sku, error: error.message });
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
      notifyProgress({ stage: "downloading", sku: item.sku, title: item.title, videoUrl: item.videoUrl, variantIndex: item.variantIndex, variantTotal: item.variantTotal });
      const downloadId = await triggerDownload(item, options);
      notifyProgress({ stage: "success", sku: item.sku, title: item.title, videoUrl: item.videoUrl, downloadId, variantIndex: item.variantIndex, variantTotal: item.variantTotal });
      return;
    } catch (error) {
      attempts += 1;
      const isLast = attempts > retry;
      notifyProgress({
        stage: isLast ? "failed" : "retrying",
        sku: item.sku,
        title: item.title,
        videoUrl: item.videoUrl,
        variantIndex: item.variantIndex,
        variantTotal: item.variantTotal,
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
  
  // 确保 videoUrl 是字符串，如果是对象则提取 url 字段
  let videoUrl = item.videoUrl;
  
  // 如果 videoUrl 是对象，尝试提取 url 字段
  if (typeof videoUrl === 'object' && videoUrl !== null) {
    videoUrl = videoUrl.url || videoUrl.videoUrl || videoUrl.src || String(videoUrl);
    log("bg:videoUrl_extracted_from_object", { original: typeof item.videoUrl, extracted: typeof videoUrl, videoUrl: String(videoUrl).substring(0, 100) });
  }
  
  // 确保是字符串
  if (videoUrl) {
    videoUrl = String(videoUrl).trim();
  }
  
  // 验证URL格式
  if (!videoUrl || typeof videoUrl !== 'string' || videoUrl.length === 0) {
    const error = new Error(`Invalid videoUrl: ${typeof item.videoUrl} - ${JSON.stringify(item.videoUrl).substring(0, 100)}`);
    log("bg:download_invalid_url", { sku: item.sku, videoUrlType: typeof item.videoUrl, videoUrl: String(item.videoUrl).substring(0, 100) });
    throw error;
  }
  
  // 验证URL格式（必须以http://或https://开头）
  if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
    const error = new Error(`Invalid URL format: ${videoUrl.substring(0, 100)}`);
    log("bg:download_invalid_url_format", { sku: item.sku, videoUrl: videoUrl.substring(0, 100) });
    throw error;
  }
  
  log("bg:download_url_validated", { sku: item.sku, url: videoUrl.substring(0, 100) });
  
  // 关键：先检查Promise，再检查目录（确保原子性）
  // 如果已经有目录选择Promise，说明正在等待目录选择，加入等待队列
  if (directorySelectionPromise) {
    log("bg:waiting_for_directory_selection_promise", { sku: item.sku, hasPromise: !!directorySelectionPromise });
    return directorySelectionPromise.then(() => {
      // 目录选择完成，使用保存的目录继续下载
      const finalFilename = buildFilename(item, options);
      log("bg:directory_selected_resuming_download", { sku: item.sku, directory: savedDownloadDirectory });
      return new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: videoUrl,
            filename: finalFilename,
            conflictAction: "uniquify",
            saveAs: false
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              // 兜底：如果目录前缀导致 filename 非法，回退到默认下载目录
              const msg = chrome.runtime.lastError.message || "";
              log("bg:download_failed_with_directory_prefix", { sku: item.sku, error: msg, filename: finalFilename });
              if (!disableDirectoryPrefixForFilename && /invalid.*filename|filename.*invalid/i.test(msg)) {
                disableDirectoryPrefixForFilename = true;
                const fallbackFilename = buildFilename(item, options);
                log("bg:download_fallback_filename", { sku: item.sku, filename: fallbackFilename });
                chrome.downloads.download(
                  {
                    url: videoUrl,
                    filename: fallbackFilename,
                    conflictAction: "uniquify",
                    saveAs: false
                  },
                  (downloadId2) => {
                    if (chrome.runtime.lastError) {
                      reject(new Error(chrome.runtime.lastError.message));
                    } else {
                      resolve(downloadId2);
                    }
                  }
                );
                return;
              }
              reject(new Error(msg));
            } else {
              resolve(downloadId);
            }
          }
        );
      });
    });
  }
  
  // 检查是否首次下载（未选择目录）
  // 使用锁确保只有一个下载会创建Promise
  if (!hasConfirmedDownloadLocation && !directorySelectionPromise && !isCreatingDirectorySelectionPromise) {
    // 立即设置锁和标志，防止其他下载也弹框（原子操作）
    isCreatingDirectorySelectionPromise = true;
    isWaitingForDirectorySelection = true;
    log("bg:first_download_selecting_directory", { sku: item.sku });
    
    // 创建全局Promise，所有等待的下载都会等待这个Promise完成
    directorySelectionPromise = new Promise((resolve, reject) => {
      // Promise创建后，立即清除锁（允许其他下载检查Promise是否存在）
      isCreatingDirectorySelectionPromise = false;
      
      chrome.downloads.download(
        {
          url: videoUrl,
          filename: filename,
          conflictAction: "uniquify",
          saveAs: true // 首次下载时让用户选择目录
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            // 如果用户取消了选择，清除标志和Promise，允许下次再试
            isWaitingForDirectorySelection = false;
            directorySelectionPromise = null;
            isCreatingDirectorySelectionPromise = false;
            log("bg:directory_selection_cancelled_by_user", { sku: item.sku, error: chrome.runtime.lastError.message });
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            // 标记这个下载ID需要提取目录
            pendingDirectoryExtractions.add(downloadId);
            log("bg:directory_selection_download_created", { downloadId, sku: item.sku });
            // 注意：Promise在这里不resolve，等待onDeterminingFilename中目录提取完成后再resolve
            // 使用定时检查目录是否已保存
            const checkDir = setInterval(() => {
              // 只要用户确认过一次位置，就放行后续下载（不再反复弹框）
              if (hasConfirmedDownloadLocation) {
                clearInterval(checkDir);
                resolve(downloadId);
              } else if (!isWaitingForDirectorySelection) {
                // 用户取消了选择
                clearInterval(checkDir);
                reject(new Error("用户取消了目录选择"));
              }
            }, 50);
            // 最多等待10秒
            setTimeout(() => {
              clearInterval(checkDir);
              if (!hasConfirmedDownloadLocation) {
                reject(new Error("等待目录选择超时"));
              }
            }, 10000);
          }
        }
      );
    });
    
    return directorySelectionPromise.then((firstDownloadId) => {
      // 目录选择完成后，清除Promise引用，后续下载可以直接使用已保存的目录
      directorySelectionPromise = null;
      // 如果用户完成了确认但无法解析目录，也确保标记为已确认
      if (hasConfirmedDownloadLocation) {
        chrome.storage.local.set({ downloadDirectoryConfirmed: true });
      }
      return firstDownloadId;
    });
  }
  
  // 后续下载：使用保存的目录，不弹框
  log("bg:download_using_saved_directory", { sku: item.sku, directory: savedDownloadDirectory });
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: videoUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false // 不弹框，直接下载到已选择的目录
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          // 兜底：如果目录前缀导致 filename 非法，回退到默认下载目录
          const msg = chrome.runtime.lastError.message || "";
          log("bg:download_failed_with_directory_prefix", { sku: item.sku, error: msg, filename });
          if (!disableDirectoryPrefixForFilename && /invalid.*filename|filename.*invalid/i.test(msg)) {
            disableDirectoryPrefixForFilename = true;
            const fallbackFilename = buildFilename(item, options);
            log("bg:download_fallback_filename", { sku: item.sku, filename: fallbackFilename });
            chrome.downloads.download(
              {
                url: videoUrl,
                filename: fallbackFilename,
                conflictAction: "uniquify",
                saveAs: false
              },
              (downloadId2) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(downloadId2);
                }
              }
            );
            return;
          }
          reject(new Error(msg));
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




