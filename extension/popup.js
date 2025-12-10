let activeTabId = null;
let currentItems = [];
let folderPath = ""; // legacy, UI 已移除
let serviceUrl = "http://127.0.0.1:3030";
let serviceFolder = "";

document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  await resolveActiveTab();
  // folderPath legacy 保留，但不再从存储读取
  await loadService();
  bindEvents();
  await refreshItems();
  chrome.runtime.onMessage.addListener(handleProgress);
}

async function resolveActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs?.[0]?.id || null;
}

function bindEvents() {
  document.getElementById("refresh").addEventListener("click", refreshItems);
  document.getElementById("downloadAll").addEventListener("click", startDownload);
  document.getElementById("autoCapture").addEventListener("click", autoCapture);
  document.getElementById("openManager").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  const sendBtn = document.getElementById("sendToLocal");
  if (sendBtn) {
    sendBtn.addEventListener("click", sendToLocal);
  }
}

async function refreshItems() {
  if (!activeTabId) {
    setInfo("未找到活动标签页");
    return;
  }
  setInfo("解析中…");
  log("popup:parse_click");
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, { type: "PARSE_ITEMS" });
    currentItems = (res?.items || []).map((item) => ({
      ...item,
      status: item.videoUrl ? "ready" : "待捕获"
    }));
    renderList();
    updateStats();
    const missing = currentItems.filter((i) => !i.videoUrl).length;
    setInfo(`解析完成，共 ${currentItems.length} 条${missing ? `，待捕获 ${missing}` : ""}`);
    if (missing > 0) {
      // 自动尝试捕获，减少人工操作
      autoCapture();
    }
  } catch (error) {
    setInfo("解析失败，请确认已在直播讲解页");
  }
}

function renderList() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  if (!currentItems.length) {
    list.textContent = "未找到商品列表";
    return;
  }

  currentItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="title">${escapeHtml(item.title)}</div>
      <div class="meta">SKU：${escapeHtml(item.sku)}</div>
      <div class="meta">地址：${item.videoUrl ? "已捕获" : "待捕获，可用自动捕获"}</div>
      <div class="status ${statusClass(item.status)}">${statusLabel(item.status)}</div>
    `;
    list.appendChild(row);
  });
}

function statusClass(status) {
  if (status === "failed") return "failed";
  if (status === "success") return "success";
  if (status === "downloading") return "downloading";
  return "";
}

function statusLabel(status) {
  const map = {
    ready: "可下载",
    "待捕获": "待捕获",
    downloading: "下载中",
    success: "完成",
    failed: "失败",
    retrying: "重试中"
  };
  return map[status] || status || "";
}

async function startDownload() {
  const ready = currentItems.filter((item) => item.videoUrl);
  if (!ready.length) {
    setInfo("未捕获到视频地址，请在页面点击“下载”后重试");
    log("popup:download_no_urls");
    return;
  }
  
  // 检查是否配置了本地服务，如果有则优先使用本地服务
  const urlInputInline = document.getElementById("serviceUrlInline");
  const folderInputInline = document.getElementById("serviceFolderInline");
  const configuredUrl = (urlInputInline?.value || serviceUrl || "").trim();
  if (configuredUrl) {
    setInfo("检测到本地服务配置，使用本地服务下载…");
    await sendToLocal();
    return;
  }
  
  // 否则使用浏览器默认下载
  setInfo(`提交下载 ${ready.length} 条（浏览器默认目录）`);
  log("popup:start_download", { count: ready.length });
  await chrome.runtime.sendMessage({
    type: "START_DOWNLOADS",
    items: ready
  });
}

function handleProgress(message) {
  if (message?.type !== "DOWNLOAD_PROGRESS") return;
  const target = currentItems.find((item) => item.sku === message.sku);
  if (target) {
    target.status = message.stage || target.status;
    target.videoUrl = target.videoUrl || message.videoUrl;
    renderList();
    updateStats();
  }
}

function setInfo(text) {
  const info = document.getElementById("info");
  info.textContent = text || "";
}

async function autoCapture() {
  if (!activeTabId) {
    setInfo("未找到活动标签页");
    return;
  }
  setInfo("自动捕获中…");
  log("popup:auto_capture_click");
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, {
      type: "AUTO_CAPTURE_URLS",
      options: { delayMs: 2200, retries: 3 }
    });
    
    if (!res) {
      setInfo("自动捕获异常：未收到响应，请刷新页面后重试");
      log("popup:auto_capture_no_response");
      return;
    }
    
    if (res?.error) {
      const errorMsg = res.error || "未知错误";
      setInfo(`捕获失败：${errorMsg}`);
      log("popup:auto_capture_error", { error: errorMsg });
      return;
    }
    
    if (!res.ok) {
      setInfo(`自动捕获失败：${res.error || "未知原因"}`);
      return;
    }
    
    currentItems = (res?.items || []).map((item) => ({
      ...item,
      status: item.videoUrl ? "ready" : "待捕获"
    }));
    renderList();
    updateStats();
    const success = res?.successCount || 0;
    const total = res?.totalTried || 0;
    setInfo(`自动捕获完成，成功 ${success}/${total}${success < total ? "，可在后台管理查看日志" : ""}`);
  } catch (error) {
    const errorMsg = error?.message || String(error);
    setInfo(`自动捕获异常：${errorMsg}。请刷新页面或查看后台日志`);
    log("popup:auto_capture_exception", { error: errorMsg, stack: error?.stack });
  }
}

function updateStats() {
  const total = currentItems.length;
  const ready = currentItems.filter((i) => i.videoUrl).length;
  const missing = total - ready;
  const totalEl = document.getElementById("stat-total");
  const readyEl = document.getElementById("stat-ready");
  const missingEl = document.getElementById("stat-missing");
  if (totalEl) totalEl.textContent = total;
  if (readyEl) readyEl.textContent = ready;
  if (missingEl) missingEl.textContent = missing;
}

async function loadService() {
  try {
    const res = await chrome.storage.local.get(["serviceUrl", "serviceFolder"]);
    serviceUrl = res?.serviceUrl || "http://127.0.0.1:3030";
    serviceFolder = res?.serviceFolder || "";
    const urlInputInline = document.getElementById("serviceUrlInline");
    const folderInputInline = document.getElementById("serviceFolderInline");
    if (urlInputInline) urlInputInline.value = serviceUrl;
    if (folderInputInline) folderInputInline.value = serviceFolder;
  } catch (e) {
    // ignore
  }
}

function saveService() {
  chrome.storage.local.set({
    serviceUrl: serviceUrl || "",
    serviceFolder: serviceFolder || ""
  });
}

async function sendToLocal() {
  const ready = currentItems.filter((item) => item.videoUrl);
  if (!ready.length) {
    setInfo("没有可发送的条目（未捕获到视频地址）");
    return;
  }
  const urlInputInline = document.getElementById("serviceUrlInline");
  const folderInputInline = document.getElementById("serviceFolderInline");
  serviceUrl = (urlInputInline?.value || serviceUrl || "").trim();
  serviceFolder = (folderInputInline?.value || serviceFolder || "").trim();
  saveService();
  if (!serviceUrl) {
    setInfo("请先填写本地服务地址");
    return;
  }
  setInfo("发送到本地服务中…");
  log("popup:send_local", { count: ready.length, serviceUrl });
  try {
    const resp = await fetch(serviceUrl.replace(/\/+$/, "") + "/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_dir: serviceFolder || null,
        sub_dir: null,
        items: ready.map((item) => ({
          sku: item.sku,
          title: item.title,
          videoUrl: item.videoUrl,
          headers: item.headers || null
        }))
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.error || `请求失败: ${resp.status}`);
    }
    setInfo(`已发送到本地服务，成功 ${data.success}/${data.total}`);
  } catch (e) {
    setInfo(`本地服务错误：${e.message}`);
  }
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function log(event, data) {
  chrome.runtime.sendMessage(
    {
      type: "LOG",
      origin: "popup",
      event,
      data
    },
    () => {}
  );
}


