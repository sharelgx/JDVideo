// scripts/popup.js

document.addEventListener('DOMContentLoaded', () => {
    const parseListButton = document.getElementById('parseList');
    const startBatchDownloadButton = document.getElementById('startBatchDownload');
    const retryFailedButton = document.getElementById('retryFailed');
    const videoListContainer = document.getElementById('videoList');
    const loadingStatus = document.getElementById('loadingStatus');
    const saveConfigButton = document.getElementById('saveConfig');
    const configStatus = document.getElementById('configStatus');
    const concurrencyInput = document.getElementById('concurrencyInput');
    const retriesInput = document.getElementById('retriesInput');
    const namingTemplateInput = document.getElementById('namingTemplateInput');

    let currentItems = [];

    // 1. 加载配置
    function loadConfig() {
        chrome.runtime.sendMessage({ action: "getConfig" }, (response) => {
            if (response && response.config) {
                concurrencyInput.value = response.config.concurrency;
                retriesInput.value = response.config.retries;
                namingTemplateInput.value = response.config.namingTemplate;
            }
        });
    }
    loadConfig();

    // 2. 保存配置
    saveConfigButton.addEventListener('click', () => {
        const newConfig = {
            concurrency: parseInt(concurrencyInput.value, 10),
            retries: parseInt(retriesInput.value, 10),
            namingTemplate: namingTemplateInput.value
        };
        chrome.runtime.sendMessage({ action: "saveConfig", data: newConfig }, (response) => {
            if (response && response.status === "saved") {
                configStatus.textContent = "配置保存成功！";
                setTimeout(() => configStatus.textContent = "", 2000);
            }
        });
    });

    // 3. 渲染列表
    function renderList(items) {
        currentItems = items;
        videoListContainer.innerHTML = '';
        if (items.length === 0) {
            videoListContainer.innerHTML = '<p>未解析到商品列表，请确保在正确的直播讲解页面。</p>';
            return;
        }

        items.forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'item';
            itemDiv.innerHTML = `
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                    <div class="item-sku">SKU: ${item.sku}</div>
                </div>
                <div class="item-actions">
                    <span class="item-status" data-sku="${item.sku}">${item.status}</span>
                    <button class="download-single" data-sku="${item.sku}" ${item.videoUrl ? '' : 'disabled'}>下载</button>
                    <button class="retry-single" data-sku="${item.sku}" style="display: ${item.status.includes('失败') ? 'inline' : 'none'};">重试</button>
                </div>
            `;
            videoListContainer.appendChild(itemDiv);
        });
        
        // 绑定单个下载事件
        videoListContainer.querySelectorAll('.download-single').forEach(button => {
            button.addEventListener('click', (e) => {
                const sku = e.target.dataset.sku;
                const item = currentItems.find(i => i.sku === sku);
                if (item && item.videoUrl) {
                    startDownload([item]);
                }
            });
        });
        
        // 绑定单个重试事件 (目前 Service Worker 不支持单个重试，这里先调用批量重试)
        videoListContainer.querySelectorAll('.retry-single').forEach(button => {
            button.addEventListener('click', () => {
                // 暂时调用批量重试，因为 Service Worker 队列是全局的
                retryFailed();
            });
        });
    }

    // 4. 接收状态更新
    function updateStatus(sku, status) {
        const statusSpan = document.querySelector(`.item-status[data-sku="${sku}"]`);
        if (statusSpan) {
            statusSpan.textContent = status;
            const retryButton = statusSpan.closest('.item-actions').querySelector('.retry-single');
            if (retryButton) {
                retryButton.style.display = status.includes('失败') ? 'inline' : 'none';
            }
        }
    }

    // 5. 监听来自 Service Worker 的状态更新
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "updateStatus") {
            updateStatus(request.sku, request.status);
            sendResponse({ status: "ok" });
        } else if (request.action === "updateList") {
            renderList(request.data);
            sendResponse({ status: "ok" });
        }
    });

    // 6. 触发解析
    parseListButton.addEventListener('click', () => {
        loadingStatus.textContent = "正在解析页面中的商品列表...";
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: "triggerParse" }, (response) => {
                if (chrome.runtime.lastError) {
                    loadingStatus.textContent = "解析失败：请确保在正确的京东直播讲解页面并刷新页面。";
                    console.error(chrome.runtime.lastError);
                } else if (response && response.status === "parsing_started") {
                    loadingStatus.textContent = "解析已触发，等待结果...";
                }
            });
        });
    });

    // 7. 启动下载
    function startDownload(items) {
        const itemsToDownload = items.filter(item => item.videoUrl);
        if (itemsToDownload.length === 0) {
            alert("没有找到可下载的视频链接。请先解析列表。");
            return;
        }
        
        loadingStatus.textContent = `已将 ${itemsToDownload.length} 个视频加入下载队列...`;
        chrome.runtime.sendMessage({ action: "startDownload", data: itemsToDownload }, (response) => {
            if (response && response.status === "download_started") {
                loadingStatus.textContent = "下载已开始，请查看下载状态。";
            }
        });
    }

    // 8. 批量下载
    startBatchDownloadButton.addEventListener('click', () => {
        startDownload(currentItems);
    });
    
    // 9. 重试失败项 (Service Worker 中实现)
    retryFailedButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "retryAllFailed" }, (response) => {
            if (response && response.status === "retry_started") {
                loadingStatus.textContent = "正在重试所有失败的下载项...";
            }
        });
    });

    // 10. 初始加载时请求 Service Worker 发送当前列表状态
    chrome.runtime.sendMessage({ action: "getQueueStatus" }, (response) => {
        if (response && response.queue) {
            // 假设 Service Worker 返回了当前队列状态，但 Content Script 才是列表的权威来源
            // 更好的做法是让 Content Script 在 Popup 打开时主动发送列表
            // 这里先触发一次 Content Script 的解析
            parseListButton.click();
        } else {
             parseListButton.click();
        }
    });
});
