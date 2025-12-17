# JDVideo（直播视频下载器）AI 交接文档（Handoff）

> 目的：让后续 AI/开发者在不了解上下文的情况下，快速接管维护与迭代。
>
> 当前状态：已解决“多视频/多次弹窗/分页解析/下载目录不生效”等核心问题，并打包可分发 zip。

---

## 1. 插件目标与主要功能

- **自动解析**直播讲解页面的商品列表（SKU/标题/封面等）。
- **捕获真实视频地址**（mp4）并与 SKU 绑定（支持单 SKU 多段视频）。
- **批量下载**：并发控制、失败重试、日志可视化、后台管理页。
- **用户体验约束**：
  - 打开 popup **不自动解析/不自动下载**，仅点击按钮触发。
  - 解析列表时 **自动翻页解析全部分页**，合并去重。
  - 下载目录 **只提示一次**（并在 MV3 service worker 重启时仍能保持“一次性”）。

---

## 2. 代码结构（Manifest V3）

目录：`extension/`

- `manifest.json`
  - MV3 配置：`background.service_worker`、`permissions`、`host_permissions`、`action`（popup）、`web_accessible_resources`（inject/blank）。
- `content.js`
  - 负责：DOM 解析、注入 `inject.js`、跨页累计 items、与 popup 通讯。
- `inject.js`
  - 运行在页面上下文：hook fetch/XHR，捕获视频 URL；缓存接口响应；通过 `postMessage` 推送给 content。
- `background.js`
  - 下载队列：并发、重试、日志；目录选择/持久化；处理 `chrome.downloads` 事件（重要）。
- `popup.html` / `popup.js` / `popup.css`
  - popup UI：显示解析列表、触发解析/下载、展示目录状态（前置步骤）。
- `manager.html` / `manager.js` / `manager.css`
  - 后台管理：目录状态/清除、日志查看搜索过滤。
- `blank.txt`
  - 用于触发“选择下载目录”的占位下载（只弹一次对话框）。

---

## 3. 数据流与通信

### 3.1 注入层（`inject.js`）→ 内容脚本（`content.js`）

- `inject.js` 在捕获到接口（尤其 `live_pc_getPageSkuVideo`）响应后，会提取 `[{ sku, url }, ...]` 并主动：
  - `window.postMessage({ source:"jdvideo-inject", type:"SKU_VIDEOS_BULK", items:[...] })`
- `content.js` 监听 `window.message`：
  - 收到 `SKU_VIDEOS_BULK` 后将映射写入 `state.skuVideoMap` / `state.capturedUrls` / `state.allItemsBySku`
  - 解决“隔离世界下 window 共享不稳定导致漏捕获”的问题。

### 3.2 popup（`popup.js`）→ content（`content.js`）

- `PARSE_ITEMS`：触发 `parseAllPages()` 自动翻页解析全量 items（跨页累计/去重）。
- popup **不会**在打开时自动解析。

### 3.3 popup（`popup.js`）→ background（`background.js`）

- `PICK_DOWNLOAD_DIRECTORY`：强制前置步骤，触发一次 `saveAs` 对话框选择目录。
- `START_DOWNLOADS`：启动后台下载队列。
- `GET_DOWNLOAD_DIRECTORY` / `SET_DOWNLOAD_DIRECTORY`：读写目录状态（manager/popup 共用）。

---

## 4. 下载目录设计（重要：Chrome 限制）

### 4.1 结论（必须牢记）

Chrome/Edge 扩展的 `chrome.downloads.download({ filename })` **只能使用相对于浏览器默认下载目录的相对路径**，
无法稳定指定任意绝对路径（例如 `D:\xxx`）。

因此本项目采用：

- 用户选择目录后，提取并保存 **Downloads 下的子目录**（`downloadSubdir`，例如 `新建文件夹 (5)`）
- 后续下载使用：`filename = "新建文件夹 (5)/xxx.mp4"`
- 如果用户选择的目录不在 Downloads 下：会提示失败（无法固定保存位置）。

### 4.2 目录选择只弹一次（MV3 持久化）

- 通过占位下载 `blank.txt`（`saveAs: true`）触发一次对话框
- 通过 `chrome.downloads.onChanged` 的 `delta.filename.current` 获取最终路径并解析出 `downloadSubdir`
- 使用 `chrome.storage.local` 持久化：
  - `downloadDirectory`（绝对路径，仅用于展示/诊断）
  - `downloadSubdir`（真正用于下载的相对子目录）
  - `downloadDirectoryConfirmed`
  - `downloadDirectorySelectionInProgress` / `downloadDirectorySelectionDownloadId`

### 4.3 子目录不生效问题的最终根因与修复

根因：`background.js` 内部注册了 `chrome.downloads.onDeterminingFilename`，曾经错误调用
`suggest({ filename: downloadItem.filename })` 覆盖了我们传入的 `子目录/文件名`。

修复（已在 `v1.34.4`+）：
- 默认不覆盖 filename：`suggest()`
- 并在 `v1.34.5` 为插件自发下载建立 `downloadId -> desiredFilename` 映射，在需要时：
  - `suggest({ filename: desiredFilename })` 强制落到子目录
- 同时增加 `bg:download_final_path` 日志输出最终落盘路径，便于定位。

---

## 5. 解析列表与捕获（分页 / 多视频）

### 5.1 自动翻页解析

- `content.js`：`parseAllPages()` 会读取分页组件（`ant-pagination`），依次跳到 1..N 页解析。
- 跨页累计结构：
  - `state.allItemsBySku: Map<sku, item>`
  - `state.allSkuOrder: sku[]`
  - 切换讲解页（explainId）会清空累计。

### 5.2 单 SKU 多段视频

实现要点：
- `inject.js` 和 `content.js` 的数据结构支持同一 SKU 关联多个 URL（数组）。
- 下载命名：同 SKU 多段视频会追加 `_1/_2/...` 后缀，避免覆盖。

---

## 6. UI 约束与按钮行为

- popup 打开 **不自动解析/不自动下载**。
- “解析列表”会自动翻页解析并合并。
- “批量下载”前有强制前置步骤：必须已选择 Downloads 下的子目录（`downloadSubdir`）。
- `manager.html` 提供“清除目录设置”：
  - 清除 `downloadDirectory/downloadSubdir/downloadDirectoryConfirmed/...`，避免 UI 残留旧目录。

---

## 7. 日志与调试

### 7.1 后台管理页

- 页面：`chrome-extension://<ext_id>/manager.html`
- 推荐关键日志：
  - `bg:download_attempt`：每次尝试的 filename（期望）
  - `bg:download_attempt_failed`：失败原因
  - `bg:download_final_path`：最终落盘路径（最关键）
  - `bg:suggest_desired_filename`：是否对 downloadId 强制 suggest

### 7.2 页面端日志

在目标页面控制台：
- `[jdvideo-inject] ...`：inject 层日志（捕获接口 / 提取 URL / SKU_VIDEOS_BULK 推送）
- `[content] ...`：content 层解析日志

---

## 8. 版本与里程碑（简版）

- **v1.33.x**：解决“每个视频弹一次目录/同一 SKU 多段视频只下到一段/打开 popup 自动下载”等。
- **v1.34.4**：修复 `onDeterminingFilename` 覆盖 filename 导致子目录不生效。
- **v1.34.5（当前关键版本）**：
  - 强制对子目录下载进行 `suggest({filename: desired})`
  - 记录 `bg:download_final_path`，证明最终落盘到 `Downloads/<子目录>/...`
  - tag 注释已更新为：`v1.34.5 成功解决文件夹问题`
- **v1.34.6**：
  - 视频文件名格式改为：`SKU----标题.mp4`（保留原有非法字符清理、标题截断、多段视频 `_1/_2` 后缀、子目录逻辑不变）

---

## 9. 发布与打包

### 9.1 Git 标签

示例（已使用过）：删除远端旧 tag → 重建同名 annotated tag → 推送

```bash
git tag -d v1.34.5
git push origin :refs/tags/v1.34.5
git tag -a v1.34.5 <commit> -m "v1.34.5 成功解决文件夹问题"
git push --force origin v1.34.5
```

### 9.2 生成 zip（分发包）

已生成：`JDVideo_v1.34.6.zip`（仅包含安装必需文件，排除测试脚本/部分测试文档）

PowerShell 参考：

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path dist\JDVideo_v1.34.6 | Out-Null
Copy-Item -Recurse -Force -Path extension\* -Destination dist\JDVideo_v1.34.6 `
  -Exclude create_test_data.js,test_data.js,test_helper.js,'测试工具.md','测试指南.md','测试步骤.md','如何找到PAPI接口.md','调试日志查看指南.md'
Remove-Item -Force JDVideo_v1.34.6.zip -ErrorAction SilentlyContinue
Compress-Archive -Path dist\JDVideo_v1.34.6\* -DestinationPath JDVideo_v1.34.6.zip
```

---

## 10. 已知限制 / 下一步建议

- **不能稳定选择 Downloads 之外的盘符目录**（Chrome 扩展限制）。
  - 可选方案：修改浏览器默认下载目录到目标盘符，插件继续用子目录即可。
- 可优化：
  - 自动检测默认下载目录名称（不同系统/语言不一定叫 Downloads/下载）。
  - 更严格的文件名合法化（括号/特殊符号/极端长标题等）。
  - 下载完成后自动清理占位下载记录（当前已尽量 cancel/remove/erase）。

---

## 11. 快速定位问题 checklist（给 AI）

1. **目录相关**
   - manager 搜 `bg:download_final_path`：看 `finalPath` 是否在预期目录。
   - 看 `downloadSubdir` 是否存在、`downloadDirectoryConfirmed` 是否 true。
2. **解析/捕获**
   - inject 是否发出了 `SKU_VIDEOS_BULK`
   - content 是否收到 `content:sku_videos_bulk_received`
3. **下载失败**
   - `bg:download_attempt_failed` 的错误信息（invalid filename / forbidden / cancelled 等）


