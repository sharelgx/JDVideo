let allLogs = [];
let filteredLogs = [];

document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  await loadService();
  await syncLogEndpoint();
  bindEvents();
  await refreshLogs();
}

function bindEvents() {
  document.getElementById("saveService").addEventListener("click", saveService);
  document.getElementById("pingService").addEventListener("click", pingService);
  document.getElementById("refreshLogs").addEventListener("click", refreshLogs);
  document.getElementById("clearLogs").addEventListener("click", clearLogs);
  document.getElementById("logSearch").addEventListener("input", filterLogs);
  document.getElementById("logFilter").addEventListener("change", filterLogs);
  document.getElementById("folderHint").addEventListener("click", showFolderHint);
  
  // 自动刷新日志（每5秒）
  setInterval(refreshLogs, 5000);
}

async function loadService() {
  const res = await chrome.storage.local.get(["serviceUrl", "serviceFolder"]);
  const url = res?.serviceUrl || "http://127.0.0.1:3030";
  const folder = res?.serviceFolder || "";
  document.getElementById("serviceUrl").value = url;
  document.getElementById("serviceFolder").value = folder;
}

async function saveService() {
  const url = (document.getElementById("serviceUrl").value || "").trim();
  const folder = (document.getElementById("serviceFolder").value || "").trim();
  
  if (!url) {
    setServiceInfo("请填写服务地址", "error");
    return;
  }
  
  await chrome.storage.local.set({
    serviceUrl: url,
    serviceFolder: folder
  });
  await syncLogEndpoint();
  setServiceInfo("✓ 配置已保存", "success");
  log("manager:config_saved", { url, folder: folder || "未设置" });
}

async function pingService() {
  const url = (document.getElementById("serviceUrl").value || "").trim() || "http://127.0.0.1:3030";
  setServiceInfo("测试中…");
  log("manager:ping_service", { url });
  try {
    const resp = await fetch(url.replace(/\/+$/, ""));
    const text = await resp.text();
    const status = resp.ok ? "success" : "error";
    setServiceInfo(`✓ 连接成功 (${resp.status})`, status);
    log("manager:ping_success", { status: resp.status });
  } catch (e) {
    setServiceInfo(`✗ 连接失败：${e.message}`, "error");
    log("manager:ping_error", { error: e.message });
  }
}

function setServiceInfo(text, type = "info") {
  const el = document.getElementById("serviceInfo");
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
}

function showFolderHint() {
  const hints = [
    "Windows: D:/JDDownloads",
    "WSL Linux: /mnt/d/JDDownloads",
    "Mac/Linux: /home/user/Downloads/JD",
    "必须使用绝对路径"
  ];
  alert("文件夹路径示例：\n\n" + hints.join("\n"));
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
    const url = (document.getElementById("serviceUrl").value || "http://127.0.0.1:3030").trim();
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
