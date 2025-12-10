// scripts/background.js

// 默认配置
const DEFAULT_CONFIG = {
    concurrency: 3,
    retries: 2,
    namingTemplate: "SKUID_[标题名].mp4"
};

let downloadQueue = [];
let isProcessing = false;
let config = DEFAULT_CONFIG;

// 加载配置
chrome.storage.sync.get(DEFAULT_CONFIG, (items) => {
    config = items;
    console.log("Loaded config:", config);
});

// 监听来自 Content Script 或 Popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "parseResult") {
        // 接收 Content Script 解析的商品列表
        console.log("Received parse result:", request.data);
        // 可以在这里存储或转发给 Popup
        sendResponse({ status: "ok" });
    } else if (request.action === "startDownload") {
        // 接收下载请求
        const itemsToDownload = request.data.map(item => ({
            ...item,
            status: "pending",
            retryCount: 0
        }));
        downloadQueue.push(...itemsToDownload);
        processQueue();
        sendResponse({ status: "download_started" });
    } else if (request.action === "getConfig") {
        sendResponse({ config: config });
    } else if (request.action === "saveConfig") {
        config = { ...config, ...request.data };
        chrome.storage.sync.set(config, () => {
            console.log("Config saved:", config);
            sendResponse({ status: "saved" });
        });
        return true; // 异步响应
    }
});

// 处理下载队列
function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    const activeDownloads = downloadQueue.filter(item => item.status === "downloading").length;
    const pendingDownloads = downloadQueue.filter(item => item.status === "pending");

    if (activeDownloads >= config.concurrency || pendingDownloads.length === 0) {
        isProcessing = false;
        return;
    }

    const item = pendingDownloads.shift();
    if (!item) {
        isProcessing = false;
        return;
    }

    item.status = "downloading";
    // 通知 Content Script/Popup 状态更新
    notifyStatusUpdate(item.sku, "下载中");

    const filename = generateFilename(item);
    
    // 启动下载
    chrome.downloads.download({
        url: item.videoUrl,
        filename: filename,
        saveAs: false // 不弹出保存对话框
    }, (downloadId) => {
        if (chrome.runtime.lastError) {
            console.error("Download failed to start:", chrome.runtime.lastError.message);
            handleDownloadFailure(item, "下载启动失败: " + chrome.runtime.lastError.message);
        } else {
            item.downloadId = downloadId;
            console.log(`Download started for ${item.sku}, ID: ${downloadId}`);
        }
        isProcessing = false;
        processQueue(); // 尝试启动下一个
    });
}

// 监听下载状态变化
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state) {
        const item = downloadQueue.find(i => i.downloadId === delta.id);
        if (item) {
            if (delta.state.current === "complete") {
                item.status = "success";
                notifyStatusUpdate(item.sku, "成功");
                console.log(`Download complete for ${item.sku}`);
            } else if (delta.state.current === "interrupted") {
                handleDownloadFailure(item, "下载中断");
            }
            isProcessing = false;
            processQueue(); // 继续处理队列
        }
    }
});

// 处理下载失败和重试
function handleDownloadFailure(item, reason) {
    if (item.retryCount < config.retries) {
        item.retryCount++;
        item.status = "pending";
        notifyStatusUpdate(item.sku, `重试 ${item.retryCount}/${config.retries}`);
        downloadQueue.push(item); // 重新加入队列
    } else {
        item.status = "failed";
        notifyStatusUpdate(item.sku, `失败: ${reason}`);
        console.error(`Download failed for ${item.sku} after ${config.retries} retries.`);
    }
}

// 生成文件名
function generateFilename(item) {
    let filename = config.namingTemplate
        .replace("SKUID", item.sku)
        .replace("[标题名]", item.title);
    
    // 清洗非法文件字符 (简单处理, 替换为下划线)
    filename = filename.replace(/[\\/:*?"<>|]/g, "_");
    
    // 确保有 .mp4 后缀
    if (!filename.toLowerCase().endsWith(".mp4")) {
        filename += ".mp4";
    }
    
    return filename;
}

// 通知 Content Script/Popup 状态更新
function notifyStatusUpdate(sku, statusText) {
    // 广播给所有 Content Script 和 Popup
    chrome.tabs.query({ url: "https://jlive.jd.com/explain*" }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                action: "updateStatus",
                sku: sku,
                status: statusText
            }).catch(e => console.warn("Could not send message to tab:", e));
        });
    });
    
    chrome.runtime.sendMessage({
        action: "updateStatus",
        sku: sku,
        status: statusText
    }).catch(e => console.warn("Could not send message to popup:", e));
}

// 暴露给 Popup/Content Script 获取当前队列状态
function getQueueStatus() {
    return downloadQueue;
}

// 重新尝试所有失败项
function retryAllFailed() {
    downloadQueue.forEach(item => {
        if (item.status === "failed") {
            item.status = "pending";
            item.retryCount = 0;
            notifyStatusUpdate(item.sku, "待下载");
        }
    });
    processQueue();
}

// 暴露给 Popup/Content Script 的接口
globalThis.getQueueStatus = getQueueStatus;
globalThis.retryAllFailed = retryAllFailed;
globalThis.processQueue = processQueue;
