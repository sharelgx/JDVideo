// scripts/content.js

// 1. 注入脚本
function injectScript(file_path, tag) {
    const node = document.getElementsByTagName(tag)[0];
    const script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', chrome.runtime.getURL(file_path));
    node.appendChild(script);
}
injectScript('scripts/injected.js', 'body');

// 存储解析结果
let parsedItems = [];
// 存储捕获到的视频 URL，key 为 sourceUrl (即触发下载的请求 URL)
let capturedVideoUrls = {};

// 2. 监听来自注入脚本的消息 (捕获到的视频 URL)
window.addEventListener("message", (event) => {
    if (event.source !== window) {
        return;
    }
    if (event.data.type && (event.data.type === "JD_LIVE_VIDEO_URL_CAPTURED")) {
        console.log("Content Script: Captured video URL:", event.data.url, "from source:", event.data.sourceUrl);
        // 存储捕获到的 URL，等待 DOM 解析完成进行匹配
        capturedVideoUrls[event.data.sourceUrl] = event.data.url;
        // 尝试匹配并更新 parsedItems
        matchVideoUrls();
    }
});

// 3. DOM 解析逻辑
function parseGoodsList() {
    console.log("Content Script: Starting DOM parsing...");
    const goodsNodes = document.querySelectorAll('.antd-pro-pages-explain-components-table-list-goodsInfoContent');
    
    if (goodsNodes.length === 0) {
        console.warn("Content Script: No goods list found with selector '.antd-pro-pages-explain-components-table-list-goodsInfoContent'.");
        return;
    }

    parsedItems = [];
    goodsNodes.forEach((node, index) => {
        try {
            // 假设商品标题在 node 内部的某个 div 或 p 标签中
            const titleNode = node.querySelector('div:first-child, p:first-child');
            const title = titleNode ? titleNode.textContent.trim() : `商品标题_${index}`;

            // 假设 SKU 在 node 的父级或兄弟节点中，或者在 node 内部的某个文本中
            // 尝试在整个商品行中查找 SKU
            const rowNode = node.closest('tr, .ant-table-row'); // 假设商品信息在一个表格行中
            let sku = '';
            let skuMatch = rowNode.textContent.match(/SKUID\s*[:：]\s*(\d+)/i);
            if (skuMatch && skuMatch[1]) {
                sku = skuMatch[1];
            } else {
                // 备用：如果找不到，使用一个临时 ID
                sku = `TEMP_SKU_${index}`;
            }

            // 寻找“下载”按钮，用于后续模拟点击或提取数据
            // 假设“下载”按钮是一个包含“下载”文本的元素
            const downloadButton = rowNode.querySelector('button, a, span, p');
            let downloadElement = null;
            if (downloadButton) {
                const buttons = rowNode.querySelectorAll('button, a, span, p');
                for (const btn of buttons) {
                    if (btn.textContent.includes('下载')) {
                        downloadElement = btn;
                        break;
                    }
                }
            }
            
            // 假设视频地址可能直接存储在下载按钮的某个 data 属性中
            let videoUrlFromAttr = downloadElement ? downloadElement.dataset.videoUrl : null;

            const item = {
                sku: sku,
                title: title,
                videoUrl: videoUrlFromAttr || '', // 优先使用 data 属性中的 URL
                status: videoUrlFromAttr ? "已解析" : "待解析/捕获",
                downloadElement: downloadElement, // 存储 DOM 元素，用于后续模拟点击
                sourceUrl: '' // 存储捕获到的请求 URL
            };
            parsedItems.push(item);

        } catch (e) {
            console.error("Content Script: Error parsing item:", e);
        }
    });

    console.log("Content Script: Parsed items:", parsedItems);
    // 尝试匹配已捕获的 URL
    matchVideoUrls();
    // 通知 Popup/浮层列表已更新
    sendMessageToBackground({ action: "updateList", data: parsedItems });
}

// 4. 匹配视频 URL
function matchVideoUrls() {
    parsedItems.forEach(item => {
        if (item.status === "待解析/捕获" && item.downloadElement) {
            // 模拟点击下载按钮，触发网络请求，以便 injected.js 捕获
            // 注意：直接模拟点击可能不会触发 fetch/XHR 拦截，但这是尝试获取 URL 的一种方式
            // 更好的方式是监听点击事件，然后提示用户手动点击
            // 这里我们先假设 injected.js 已经足够强大，能捕获到请求
            
            // 暂时不模拟点击，因为模拟点击可能导致页面跳转或下载文件，影响用户体验
            // 而是等待用户在 Popup 中点击“解析列表”或“批量下载”时再触发
            
            // 检查是否有匹配的捕获 URL (需要一个机制将捕获 URL 与 SKU 关联起来)
            // 由于没有 DOM 结构，无法确定如何关联，这里先留空，等待用户反馈
            // 暂时将所有捕获到的 URL 视为待匹配
            
            // 临时逻辑：如果捕获到 URL，就更新第一个待解析的项
            const capturedKeys = Object.keys(capturedVideoUrls);
            if (capturedKeys.length > 0) {
                const sourceUrl = capturedKeys[0];
                item.videoUrl = capturedVideoUrls[sourceUrl];
                item.sourceUrl = sourceUrl;
                item.status = "已捕获";
                delete capturedVideoUrls[sourceUrl]; // 匹配后移除
            }
        }
    });
    // 通知 Popup/浮层列表已更新
    sendMessageToBackground({ action: "updateList", data: parsedItems });
}

// 5. 监听来自 Service Worker 的消息 (状态更新)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateStatus") {
        const item = parsedItems.find(i => i.sku === request.sku);
        if (item) {
            item.status = request.status;
            // 触发 UI 更新 (如果浮层已注入)
            updateFloatingPanel(item.sku, item.status);
        }
        sendResponse({ status: "ok" });
    } else if (request.action === "triggerParse") {
        // 接收来自 Popup 的解析请求
        parseGoodsList();
        sendResponse({ status: "parsing_started" });
    }
});

// 6. 辅助函数：发送消息给 Service Worker
function sendMessageToBackground(message) {
    chrome.runtime.sendMessage(message).catch(e => console.error("Error sending message to background:", e));
}

// 7. 浮层 UI 注入
function injectFloatingPanel() {
    const floatContainer = document.createElement('div');
    floatContainer.id = 'jd-video-downloader-float';
    floatContainer.innerHTML = `
        <div id="jd-downloader-header">
            <h4>京东视频下载器</h4>
            <span id="jd-downloader-toggle">▲</span>
        </div>
        <div id="jd-downloader-content" class="hidden">
            <button id="jd-downloader-batch-btn">批量下载所有已解析视频</button>
            <ul class="jd-downloader-list" id="jd-downloader-list">
                <li style="text-align: center; color: #999;">等待解析...</li>
            </ul>
        </div>
    `;
    document.body.appendChild(floatContainer);

    const header = document.getElementById('jd-downloader-header');
    const content = document.getElementById('jd-downloader-content');
    const toggle = document.getElementById('jd-downloader-toggle');
    const batchBtn = document.getElementById('jd-downloader-batch-btn');
    const listUl = document.getElementById('jd-downloader-list');

    // 默认收起，toggle 初始显示为向下箭头
    // content.classList.add('hidden'); // 已经在 innerHTML 中添加
    toggle.textContent = '▲';

    header.addEventListener('click', () => {
        content.classList.toggle('hidden');
        toggle.textContent = content.classList.contains('hidden') ? '▲' : '▼';
    });

    batchBtn.addEventListener('click', () => {
        const itemsToDownload = parsedItems.filter(item => item.videoUrl);
        if (itemsToDownload.length === 0) {
            alert("没有找到可下载的视频链接。请先确保页面已加载完成。");
            return;
        }
        sendMessageToBackground({ action: "startDownload", data: itemsToDownload });
        batchBtn.textContent = `已启动 ${itemsToDownload.length} 个下载任务...`;
        batchBtn.disabled = true;
        setTimeout(() => {
            batchBtn.textContent = "批量下载所有已解析视频";
            batchBtn.disabled = false;
        }, 5000); // 避免重复点击
    });

    // 初始解析
    parseGoodsList();

    // 渲染列表
    function renderFloatingList(items) {
        listUl.innerHTML = '';
        if (items.length === 0) {
            listUl.innerHTML = '<li style="text-align: center; color: #999;">未解析到商品列表。</li>';
            return;
        }

        items.forEach(item => {
            const li = document.createElement('li');
            li.className = 'jd-downloader-item';
            li.dataset.sku = item.sku;
            li.innerHTML = `
                <div class="jd-item-info">
                    <div class="jd-item-title" title="${item.title}">${item.title}</div>
                    <div class="jd-item-sku">SKU: ${item.sku}</div>
                </div>
                <div class="jd-item-status ${item.status.includes('成功') ? 'success' : item.status.includes('失败') ? 'failed' : ''}">${item.status}</div>
            `;
            listUl.appendChild(li);
        });
    }

    // 状态更新函数
    globalThis.updateFloatingPanel = function(sku, status) {
        const statusDiv = document.querySelector(`#jd-downloader-list li[data-sku="${sku}"] .jd-item-status`);
        if (statusDiv) {
            statusDiv.textContent = status;
            statusDiv.className = `jd-item-status ${status.includes('成功') ? 'success' : status.includes('失败') ? 'failed' : ''}`;
        }
    }

    // 监听来自 Service Worker 的列表更新
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "updateList") {
            parsedItems = request.data; // 更新全局列表
            renderFloatingList(parsedItems);
            sendResponse({ status: "ok" });
        }
    });
}

// 页面加载完成后开始注入浮层和解析
if (document.readyState === 'complete') {
    injectFloatingPanel();
} else {
    window.addEventListener('load', injectFloatingPanel);
}
