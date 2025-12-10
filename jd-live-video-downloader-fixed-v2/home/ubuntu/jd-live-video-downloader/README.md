# 京东直播商品视频下载器 Chrome 插件

## 1. 项目简介

本项目是根据用户需求文档（PRD）开发的 Chrome 浏览器扩展程序，旨在帮助直播运营、店铺管理员和素材整理人员在京东直播讲解页面（`https://jlive.jd.com/explain?id=*`）一键解析并批量下载商品视频。

插件基于 **Manifest V3** 规范开发，核心功能包括：

*   **商品列表解析**：自动识别页面中的商品列表，提取 SKU 和商品标题。
*   **视频地址捕获**：通过拦截网络请求，捕获商品视频的真实下载链接。
*   **批量下载管理**：在 Service Worker 中维护下载队列，支持并发控制和失败重试。
*   **双重交互界面**：提供浏览器工具栏弹窗（Popup）和页内浮层两种操作界面。
*   **自定义命名**：文件按 `SKUID_[标题名].mp4` 格式自动命名。

## 2. 功能特性

| 特性 | 描述 | 实现方式 |
| :--- | :--- | :--- |
| **适配页面** | `https://jlive.jd.com/explain?id=*` | `manifest.json` `content_scripts` |
| **解析内容** | 提取商品标题、SKU、视频下载地址 | `content.js` (DOM 解析) + `injected.js` (网络拦截) |
| **下载能力** | 批量/单个下载，支持并发控制和重试 | `background.js` (Service Worker) + `chrome.downloads.download` |
| **文件命名** | `SKUID_[标题名].mp4`，自动清洗非法字符 | `background.js` `generateFilename` 函数 |
| **交互界面** | 浏览器 Popup 弹窗和页内右下角浮层 | `popup.html`/`popup.js` 和 `content.js` (DOM 注入) |
| **配置项** | 并发上限（默认 3）、重试次数（默认 2）、命名模板 | `chrome.storage.sync` |
| **权限** | `activeTab`, `scripting`, `downloads`, `storage`, `host_permissions` | `manifest.json` |

## 3. 安装指南（开发者模式）

由于本项目是 Chrome 扩展程序，您需要通过开发者模式进行加载。

1.  **下载代码**：将本项目所有文件下载到本地文件夹，例如 `~/jd-live-video-downloader`。
2.  **打开扩展程序管理页面**：
    *   在 Chrome 浏览器地址栏输入 `chrome://extensions` 并回车。
3.  **开启开发者模式**：
    *   在扩展程序管理页面的右上角，打开 **“开发者模式”** 开关。
4.  **加载已解压的扩展程序**：
    *   点击左上角的 **“加载已解压的扩展程序”** 按钮。
    *   选择您下载的 `~/jd-live-video-downloader` 文件夹。
5.  **完成**：插件图标（蓝色方块）将出现在浏览器工具栏中。

## 4. 使用说明

### 4.1. 准备工作

1.  确保您已登录京东账号，并能正常访问目标直播讲解页面。
2.  导航到目标页面，例如 `https://jlive.jd.com/explain?id=34692963`。

### 4.2. 交互方式一：页内浮层（推荐）

1.  页面加载完成后，右下角会出现一个 **“京东视频下载器”** 的浮层。
2.  浮层会自动尝试解析页面中的商品列表。
3.  点击浮层头部的 **“▲”** 箭头可以展开列表，查看解析状态。
4.  点击 **“批量下载所有已解析视频”** 按钮，即可启动下载任务。下载状态会实时更新在列表中。

### 4.3. 交互方式二：浏览器 Popup

1.  点击浏览器工具栏中的插件图标。
2.  在弹出的窗口中，点击 **“解析列表”** 按钮，手动触发商品列表解析。
3.  列表加载后，您可以：
    *   点击 **“批量下载”** 启动所有视频的下载。
    *   点击列表项右侧的 **“下载”** 按钮，单独下载某个视频。
    *   在底部的 **“配置项”** 中修改并发数、重试次数和文件命名模板，然后点击 **“保存配置”**。

## 5. 核心技术要点与调试

由于开发环境无法登录京东，插件的 DOM 选择器和网络请求捕获逻辑是基于 PRD 提供的类名和通用经验编写的。如果插件无法正常工作，很可能是因为页面 DOM 结构发生了变化。

### 5.1. 关键 DOM 选择器

| 文件 | 目的 | 关键选择器 | 调试建议 |
| :--- | :--- | :--- | :--- |
| `scripts/content.js` | 商品信息节点 | `.antd-pro-pages-explain-components-table-list-goodsInfoContent` | 检查该类名是否仍存在于商品列表中。如果不存在，请使用开发者工具找到包含商品标题和 SKU 的最外层容器，并更新 `parseGoodsList` 函数中的选择器。 |
| `scripts/content.js` | SKU 提取 | `rowNode.textContent.match(/SKUID\s*[:：]\s*(\d+)/i)` | 检查 SKU 在页面上的显示格式是否仍为 `SKUID: 12345...`。如果格式变化，请修改正则表达式。 |

### 5.2. 视频 URL 捕获

视频地址的获取依赖于 `scripts/injected.js` 对页面 `fetch` 和 `XMLHttpRequest` 的拦截。

1.  **检查拦截是否生效**：打开目标页面，打开开发者工具（F12），切换到 **Console**（控制台）。如果看到类似 `JD Live Video Downloader: Intercepted potential video request:` 的输出，说明拦截成功。
2.  **手动触发捕获**：如果自动解析失败，请尝试在页面上**手动点击**某个商品的“下载”按钮。如果 `injected.js` 成功捕获到视频 URL，它会通过 `window.postMessage` 发送给 `content.js`。
3.  **调整捕获逻辑**：如果捕获失败，您可能需要修改 `scripts/injected.js` 中的关键词过滤逻辑（`url.includes('video') || url.includes('download') || url.includes('media')`），以匹配实际的视频请求 URL。

## 6. 文件结构

```
jd-live-video-downloader/
├── manifest.json             # 插件配置文件 (Manifest V3)
├── popup.html                # 浏览器工具栏弹窗 UI
├── scripts/
│   ├── background.js         # Service Worker，处理下载队列、配置存储
│   ├── content.js            # Content Script，处理 DOM 解析、UI 注入、通信
│   ├── injected.js           # 注入脚本，用于劫持页面网络请求以捕获视频 URL
│   └── popup.js              # 弹窗逻辑脚本
├── styles/
│   └── content.css           # 页内浮层样式
├── icons/
│   ├── icon16.png            # 插件图标
│   ├── icon48.png
│   └── icon128.png
└── README.md                 # 本文档
```
