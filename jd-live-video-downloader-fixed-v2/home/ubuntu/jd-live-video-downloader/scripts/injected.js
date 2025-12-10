// scripts/injected.js

// 注入脚本用于拦截网络请求，以捕获视频的真实下载地址
// 由于 Content Script 无法直接访问页面的 window 对象，需要注入脚本
(function() {
    console.log("JD Live Video Downloader: Injected script loaded.");

    // 尝试劫持 fetch
    const originalFetch = window.fetch;
    window.fetch = function() {
        const fetchPromise = originalFetch.apply(this, arguments);
        
        // 假设视频地址请求包含特定的关键词，例如 'video' 或 'download'
        // 并且返回的是一个 .mp4 或 .m3u8 链接
        const url = arguments[0].toString();
        
        if (url.includes('video') || url.includes('download') || url.includes('media')) {
            console.log("JD Live Video Downloader: Intercepted potential video request:", url);
            
            fetchPromise.then(response => {
                // 克隆响应，以便原始调用者也能使用
                const clonedResponse = response.clone();
                
                // 检查响应类型，如果是 JSON，尝试解析
                const contentType = clonedResponse.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    clonedResponse.json().then(data => {
                        // 假设视频 URL 在响应的某个字段中
                        // 这是一个通用尝试，需要根据实际情况调整
                        const videoUrl = findVideoUrlInObject(data);
                        if (videoUrl) {
                            console.log("JD Live Video Downloader: Found video URL in JSON response:", videoUrl);
                            window.postMessage({
                                type: "JD_LIVE_VIDEO_URL_CAPTURED",
                                url: videoUrl,
                                sourceUrl: url
                            }, "*");
                        }
                    }).catch(e => console.error("JD Live Video Downloader: Error parsing JSON response:", e));
                } else if (url.endsWith('.mp4') || url.includes('.m3u8')) {
                     // 如果请求本身就是视频文件，直接发送
                     window.postMessage({
                        type: "JD_LIVE_VIDEO_URL_CAPTURED",
                        url: url,
                        sourceUrl: url
                    }, "*");
                }
                
                return response;
            }).catch(e => console.error("JD Live Video Downloader: Error in intercepted fetch:", e));
        }
        
        return fetchPromise;
    };

    // 尝试劫持 XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        if (this._url && (this._url.includes('video') || this._url.includes('download') || this._url.includes('media'))) {
            this.addEventListener('load', function() {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        const response = JSON.parse(this.responseText);
                        const videoUrl = findVideoUrlInObject(response);
                        if (videoUrl) {
                            console.log("JD Live Video Downloader: Found video URL in XHR response:", videoUrl);
                            window.postMessage({
                                type: "JD_LIVE_VIDEO_URL_CAPTURED",
                                url: videoUrl,
                                sourceUrl: this._url
                            }, "*");
                        }
                    } catch (e) {
                        // 可能是非 JSON 响应，忽略
                    }
                }
            });
        }
        return originalSend.apply(this, arguments);
    };

    // 递归查找对象中的视频 URL
    function findVideoUrlInObject(obj) {
        if (typeof obj !== 'object' || obj === null) {
            return null;
        }

        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                if (typeof value === 'string' && (value.includes('.mp4') || value.includes('.m3u8') || value.includes('video.jd.com'))) {
                    return value;
                }
                // 递归查找
                const result = findVideoUrlInObject(value);
                if (result) {
                    return result;
                }
            }
        }
        return null;
    }
})();
