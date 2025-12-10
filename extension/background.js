const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY = 2;
const LOG_LIMIT = 300;
const logs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_DOWNLOADS") {
    const { items = [], options = {} } = message;
    log("bg:start_downloads", { count: items.length, options });
    runDownloadQueue(items, options).then(() => {
      notifyProgress({ stage: "queue_completed" });
      log("bg:queue_completed");
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "GET_LOGS") {
    sendResponse({ ok: true, logs: [...logs] });
    return true;
  }
  return false;
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
  const folder = sanitizeFolder(options?.folder);
  return folder ? `${folder}/${base}` : base;
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

function triggerDownload(item, options) {
  const filename = buildFilename(item, options);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: item.videoUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
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


