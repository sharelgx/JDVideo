let activeTabId = null;
let currentItems = [];
let folderPath = ""; // legacy, UI 已移除

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
  setInfo(`提交下载 ${ready.length} 条`);
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
  // v1 无自动捕获
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
  // v2 无本地服务配置
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


