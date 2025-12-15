let allLogs = [];
let filteredLogs = [];

document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  await loadDirectory();
  await syncLogEndpoint();
  bindEvents();
  await refreshLogs();
  // 定期刷新目录显示（以防在后台被更新）
  setInterval(loadDirectory, 2000);
}

function bindEvents() {
  document.getElementById("clearDirectory").addEventListener("click", clearDirectory);
  document.getElementById("refreshLogs").addEventListener("click", refreshLogs);
  document.getElementById("clearLogs").addEventListener("click", clearLogs);
  document.getElementById("logSearch").addEventListener("input", filterLogs);
  document.getElementById("logFilter").addEventListener("change", filterLogs);
  
  // 自动刷新日志（每5秒）
  setInterval(refreshLogs, 5000);
}

async function loadDirectory() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_DOWNLOAD_DIRECTORY" });
    const directory = res?.directory || null;
    const confirmed = Boolean(res?.confirmed);
    const input = document.getElementById("downloadDirectory");
    if (directory) {
      input.value = directory;
      input.placeholder = "";
    } else {
      input.value = "";
      input.placeholder = confirmed ? "已确认（使用浏览器默认下载目录）" : "未设置（首次下载时会提示选择）";
    }
  } catch (e) {
    console.error("Failed to load directory:", e);
  }
}

async function clearDirectory() {
  if (!confirm("确定要清除下载目录设置吗？下次下载时会再次提示您选择目录。")) {
    return;
  }
  
  try {
    await chrome.runtime.sendMessage({
      type: "SET_DOWNLOAD_DIRECTORY",
      directory: null
    });
    // 同时清除“已确认”标记
    await chrome.storage.local.set({ downloadDirectoryConfirmed: false });
    setDirectoryInfo("✓ 目录设置已清除", "success");
    await loadDirectory();
    log("manager:directory_cleared");
  } catch (e) {
    setDirectoryInfo("✗ 清除失败：" + e.message, "error");
    log("manager:directory_clear_error", { error: e.message });
  }
}

function setDirectoryInfo(text, type = "info") {
  const el = document.getElementById("directoryInfo");
  el.textContent = text || "";
  el.className = "info-message";
  if (type === "success") {
    el.style.background = "#f0fdf4";
    el.style.color = "#166534";
    el.style.borderColor = "#86efac";
  } else if (type === "error") {
    el.style.background = "#fef2f2";
    el.style.color = "#991b1b";
    el.style.borderColor = "#fca5a5";
  } else {
    el.style.background = "#eff6ff";
    el.style.color = "#1e40af";
    el.style.borderColor = "#bfdbfe";
  }
  // 3秒后自动清除提示
  setTimeout(() => {
    el.textContent = "";
  }, 3000);
}

function getLogType(event) {
  if (!event) return "";
  const lower = event.toLowerCase();
  if (lower.includes("parse")) return "parse";
  if (lower.includes("capture")) return "capture";
  if (lower.includes("download")) return "download";
  if (lower.includes("popup")) return "popup";
  if (lower.includes("content:")) return "content";
  if (lower.includes("inject")) return "inject";
  if (lower.includes("bg:")) return "bg";
  return "";
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDate(ts) {
  const d = new Date(ts || Date.now());
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

async function refreshLogs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_LOGS" }).catch(() => null);
    allLogs = res?.logs || [];
    filterLogs();
    log("manager:logs_refreshed", { count: allLogs.length });
  } catch (e) {
    console.error("Failed to fetch logs:", e);
  }
}

function filterLogs() {
  const search = (document.getElementById("logSearch").value || "").toLowerCase();
  const filterType = document.getElementById("logFilter").value || "";
  
  filteredLogs = allLogs.filter((entry) => {
    const event = (entry.event || "").toLowerCase();
    const data = JSON.stringify(entry.data || {}).toLowerCase();
    const type = getLogType(entry.event);
    
    if (filterType && type !== filterType) return false;
    if (search && !event.includes(search) && !data.includes(search)) return false;
    
    return true;
  });
  
  renderLogs();
  updateLogCount();
}

function renderLogs() {
  const box = document.getElementById("logList");
  const empty = document.getElementById("logEmpty");
  
  if (!filteredLogs.length) {
    box.style.display = "none";
    empty.style.display = "block";
    empty.textContent = allLogs.length === 0 ? "暂无日志" : "没有匹配的日志";
    return;
  }
  
  box.style.display = "block";
  empty.style.display = "none";
  box.innerHTML = "";
  
  // 按日期分组
  const grouped = {};
  filteredLogs.slice().reverse().forEach((entry) => {
    const date = formatDate(entry.ts);
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(entry);
  });
  
  Object.keys(grouped).forEach((date) => {
    const groupDiv = document.createElement("div");
    groupDiv.style.marginBottom = "16px";
    groupDiv.style.paddingBottom = "16px";
    groupDiv.style.borderBottom = "1px solid rgba(255, 255, 255, 0.1)";
    
    const dateHeader = document.createElement("div");
    dateHeader.style.color = "#94a3b8";
    dateHeader.style.fontSize = "11px";
    dateHeader.style.fontWeight = "600";
    dateHeader.style.marginBottom = "10px";
    dateHeader.style.textTransform = "uppercase";
    dateHeader.textContent = date;
    groupDiv.appendChild(dateHeader);
    
    grouped[date].forEach((entry) => {
      const item = createLogItem(entry);
      groupDiv.appendChild(item);
    });
    
    box.appendChild(groupDiv);
  });
}

function createLogItem(entry) {
  const div = document.createElement("div");
  div.className = "log-item";
  const type = getLogType(entry.event);
  if (type) div.setAttribute("data-type", type);
  
  const header = document.createElement("div");
  header.className = "log-header";
  
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatTime(entry.ts);
  header.appendChild(time);
  
  const event = document.createElement("span");
  event.className = "log-event";
  event.textContent = entry.event || "unknown";
  header.appendChild(event);
  
  if (type) {
    const tag = document.createElement("span");
    tag.className = "log-tag";
    tag.setAttribute("data-type", type);
    tag.textContent = type;
    header.appendChild(tag);
  }
  
  div.appendChild(header);
  
  if (entry.data && Object.keys(entry.data).length > 0) {
    const data = document.createElement("div");
    data.className = "log-data";
    try {
      data.textContent = JSON.stringify(entry.data, null, 2);
    } catch (e) {
      data.textContent = String(entry.data);
    }
    div.appendChild(data);
  }
  
  return div;
}

function updateLogCount() {
  const count = document.getElementById("logCount");
  count.textContent = filteredLogs.length === allLogs.length 
    ? allLogs.length 
    : `${filteredLogs.length}/${allLogs.length}`;
}

async function clearLogs() {
  if (!confirm("确定要清空日志视图吗？（后台日志仍会保留）")) return;
  allLogs = [];
  filteredLogs = [];
  renderLogs();
  updateLogCount();
  log("manager:logs_cleared");
}

async function syncLogEndpoint() {
  try {
    // 可选：仍然支持日志上报到Python服务（如果用户有配置的话）
    // 这里保持默认值或从存储中读取
    const url = "http://127.0.0.1:3030";
    await chrome.runtime.sendMessage({ 
      type: "SET_LOG_ENDPOINT", 
      url: url.replace(/\/+$/, "") + "/log" 
    });
  } catch (e) {
    // ignore
  }
}

function log(event, data) {
  chrome.runtime.sendMessage(
    {
      type: "LOG",
      origin: "manager",
      event,
      data
    },
    () => {}
  );
}
