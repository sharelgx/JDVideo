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
  await chrome.storage.local.set({
    serviceUrl: url,
    serviceFolder: folder
  });
  await syncLogEndpoint();
  setServiceInfo("已保存配置");
}

async function pingService() {
  const url = (document.getElementById("serviceUrl").value || "").trim() || "http://127.0.0.1:3030";
  setServiceInfo("测试中…");
  try {
    const resp = await fetch(url.replace(/\/+$/, ""));
    const text = await resp.text();
    setServiceInfo(`响应 ${resp.status}: ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
  } catch (e) {
    setServiceInfo(`测试失败：${e.message}`);
  }
}

function setServiceInfo(text) {
  document.getElementById("serviceInfo").textContent = text || "";
}

async function refreshLogs() {
  const res = await chrome.runtime.sendMessage({ type: "GET_LOGS" }).catch(() => null);
  const logs = res?.logs || [];
  const box = document.getElementById("logList");
  if (!logs.length) {
    box.textContent = "无日志";
    return;
  }
  box.innerHTML = "";
  logs.slice().reverse().forEach((entry) => {
    const div = document.createElement("div");
    div.className = "log-line";
    const ts = new Date(entry.ts || Date.now()).toISOString();
    div.innerHTML = `<span class="ts">${ts}</span> <span class="event">${entry.event}</span> <span class="data">${escapeHtml(
      JSON.stringify(entry.data)
    )}</span>`;
    box.appendChild(div);
  });
}

async function clearLogs() {
  // 仅清前端展示，后台日志不会清空，以免丢数据
  const box = document.getElementById("logList");
  box.textContent = "已清空本地视图（后台仍保留历史）";
}

async function syncLogEndpoint() {
  try {
    const url = (document.getElementById("serviceUrl").value || "http://127.0.0.1:3030").trim();
    await chrome.runtime.sendMessage({ type: "SET_LOG_ENDPOINT", url: url.replace(/\\/+$/, "") + "/log" });
  } catch (e) {
    // ignore
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

