let activeTabId = null;
let currentItems = [];

document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  await resolveActiveTab();
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
    console.log("[popup] 收到解析结果:", res);
    if (!res) {
      setInfo("错误：未收到响应，content.js 可能未加载");
      return;
    }
    currentItems = (res?.items || []).map((item) => ({
      ...item,
      status: item.videoUrl ? "ready" : "待捕获"
    }));
    renderList();
    updateStats();
    const missing = currentItems.filter((i) => !i.videoUrl).length;
    
    // 仅展示解析结果；不再自动触发捕获/点击逻辑（避免“打开插件就自动下载/弹窗”）
    // 如需捕获，请用户主动点击“自动捕获 URL”（若按钮隐藏，则按页面提示手动触发一次下载按钮再解析）。
    setInfo(`解析完成，共 ${currentItems.length} 条${missing ? `，待捕获 ${missing} 条（不会自动捕获）` : ""}`);
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
    
    // 构建状态显示
    let statusHtml = "";
    if (item.progress) {
      statusHtml = `<div class="meta progress">${escapeHtml(item.progress)}</div>`;
    }
    if (item.downloadPath) {
      statusHtml += `<div class="meta path">路径: ${escapeHtml(item.downloadPath)}</div>`;
    }
    
    row.innerHTML = `
      <div class="title">${escapeHtml(item.title)}</div>
      <div class="meta">SKU：${escapeHtml(item.sku)}</div>
      <div class="meta">地址：${item.videoUrl ? "已捕获" : "待捕获"}</div>
      ${statusHtml}
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
    success: "✅ 完成",
    failed: "❌ 失败",
    retrying: "重试中"
  };
  return map[status] || status || "";
}

async function startDownload() {
  // 筛选需要下载的项：有URL且未成功下载的
  const needDownload = currentItems.filter((item) => {
    return item.videoUrl && item.status !== "success" && item.status !== "downloading";
  });
  
  if (!needDownload.length) {
    const pending = currentItems.filter((item) => !item.videoUrl && item.hasDownloadButton);
    const allSuccess = currentItems.filter((item) => item.videoUrl && item.status === "success");
    
    if (allSuccess.length > 0 && allSuccess.length === currentItems.filter(i => i.videoUrl).length) {
      setInfo(`✅ 全部已下载完成 (${allSuccess.length})`);
    } else if (pending.length > 0) {
      setInfo(`还有 ${pending.length} 条待捕获：请先点击“自动捕获 URL”，或在页面手动点一次下载按钮后再“解析列表”`);
    } else {
      setInfo("没有需要下载的项");
    }
    log("popup:download_no_items", { total: currentItems.length, needDownload: needDownload.length, pending: pending.length });
    return;
  }
  
  // 首次下载目录提示（由后台决定是否弹出 saveAs 目录选择）
  try {
    const dirRes = await chrome.runtime.sendMessage({ type: "GET_DOWNLOAD_DIRECTORY" });
    if (!dirRes?.confirmed) {
      setInfo(`首次下载将弹出目录选择窗口（仅一次）…`);
    }
  } catch (e) {
    // ignore
  }

  setInfo(`开始下载 ${needDownload.length} 条...`);
  log("popup:start_download", { count: needDownload.length });
  
  // 通过background触发下载
  await chrome.runtime.sendMessage({
    type: "START_DOWNLOADS",
    items: needDownload.map(item => ({
      sku: item.sku,
      title: item.title,
      videoUrl: item.videoUrl,
      headers: item.headers || {}
    })),
    options: {}
  });
}

function handleProgress(message) {
  if (message?.type !== "DOWNLOAD_PROGRESS") return;
  const target = currentItems.find((item) => item.sku === message.sku);
  if (target) {
    // 更新状态和进度信息
    target.status = message.stage || target.status;
    target.videoUrl = target.videoUrl || message.videoUrl;
    
    // 保存进度信息
    if (message.stage === "downloading") {
      target.progress = "下载中...";
    } else if (message.stage === "success") {
      target.progress = "下载成功";
    } else if (message.stage === "failed") {
      target.progress = `失败: ${message.error || "未知错误"}`;
    } else if (message.stage === "retrying") {
      target.progress = `重试中 (${message.attempt || 0})...`;
    }
    
    target.downloadError = message.error || null;
    renderList();
    updateStats();
    
    // 更新提示信息
    if (message.stage === "success") {
      const successCount = currentItems.filter(i => i.status === "success").length;
      const total = currentItems.filter(i => i.videoUrl).length;
      if (successCount === total) {
        setInfo(`✅ 全部下载完成 (${successCount}/${total})`);
      } else {
        setInfo(`下载中... 已完成 ${successCount}/${total}`);
      }
    } else if (message.stage === "failed") {
      const failed = currentItems.filter(i => i.status === "failed").length;
      const total = currentItems.filter(i => i.videoUrl).length;
      setInfo(`⚠️ 部分下载失败 (${failed}/${total})`);
    }
  }
}

function setInfo(text) {
  const info = document.getElementById("info");
  info.textContent = text || "";
}

// 手动触发的自动捕获，会显示详细提示
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
      options: { delayMs: 2200, retries: 3 } // 使用V1.0稳定版的速度参数
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
    const stillMissing = currentItems.filter((i) => !i.videoUrl).length;
    
    if (success > 0) {
      setInfo(`自动捕获完成，成功 ${success}/${total}${stillMissing > 0 ? `，仍有 ${stillMissing} 条待捕获，可点击“自动捕获 URL”重试` : ""}`);
    } else {
      setInfo(`自动捕获完成，但未捕获到视频地址（0/${total}）。请检查后台日志或手动点击页面上的“下载”按钮`);
    }
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


