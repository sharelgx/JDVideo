"""
本地 Python 下载服务

功能：
- 接收扩展发送的 SKU/标题/视频 URL 列表，保存到指定目录。
- 支持子目录（扩展传 sub_dir）和目标根目录（target_dir，绝对路径）。
- 简单并发与重试，日志输出到控制台。

依赖：requests
安装：pip install requests

启动：python local_downloader.py --host 127.0.0.1 --port 3030 --root ./downloads --concurrency 3
"""

import argparse
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

import requests


def sanitize_part(text: str) -> str:
    return (text or "unknown").replace("\\", "_").replace("/", "_").replace(":", "_").replace("*", "_").replace("?", "_").replace('"', "_").replace("<", "_").replace(">", "_").replace("|", "_").strip()


def build_path(root_dir: str, sub_dir: str, sku: str, title: str) -> str:
    base = f"{sanitize_part(sku)}_{sanitize_part(title)}.mp4"
    parts = [root_dir]
    if sub_dir:
        parts.append(sub_dir.strip("\\/"))
    parts.append(base)
    return os.path.join(*parts)


def ensure_dir(path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def normalize_root(path: str, fallback_root: str) -> str:
    """规范化根目录，修正全角冒号/意外相对路径，确保为绝对路径。"""
    original_path = path
    if not path:
        return fallback_root
    
    # 去除所有不可见字符和特殊空白字符
    path = "".join(c for c in path if c.isprintable())
    
    # 修正全角冒号等情况（处理所有可能的全角字符）
    path = path.replace("：", ":")  # 全角冒号
    path = path.replace("　", " ")  # 全角空格
    path = path.replace("\u2009", ":")  # 其他可能的冒号变体
    
    # 统一路径分隔符
    path = path.replace("\\", "/")
    # 去除首尾空格和斜杠
    path = path.strip().strip("/")
    
    # 检测Windows驱动器路径（如 D:/xxx、D:\xxx、D:xxx）
    is_windows_path = False
    drive_letter = None
    if len(path) >= 2:
        # 检查是否是驱动器字母后跟冒号
        first_char = path[0].upper()
        second_char = path[1]
        
        if first_char.isalpha() and second_char == ":":
            is_windows_path = True
            drive_letter = first_char
            if len(path) == 2:
                path = "/"  # D: -> D:/
            else:
                path = path[2:].lstrip("/")
    
    # 日志记录（用于调试）
    import sys
    print(f"[normalize] original='{original_path}' -> path='{path}' is_windows={is_windows_path} drive={drive_letter} os.name={os.name}", file=sys.stderr)
    
    # 如果在WSL/Unix环境下检测到Windows路径，转换为/mnt/drive格式
    if is_windows_path and os.name != "nt":
        # WSL环境下：D:/JDDownloads -> /mnt/d/JDDownloads
        result = f"/mnt/{drive_letter.lower()}/{path}"
        final = os.path.abspath(result)
        print(f"[normalize] WSL conversion: {result} -> {final}", file=sys.stderr)
        return final
    
    # Windows环境下
    if os.name == "nt":
        if is_windows_path:
            # 还原完整Windows路径
            result = f"{drive_letter}:\\{path.replace('/', os.sep)}"
            final = os.path.abspath(result)
            print(f"[normalize] Windows path: {result} -> {final}", file=sys.stderr)
            return final
        elif not os.path.isabs(path):
            # 相对路径映射到fallback_root（这是问题所在！）
            result = os.path.join(fallback_root, path)
            final = os.path.abspath(result)
            print(f"[normalize] WARNING: Relative path detected! '{path}' -> '{result}' -> '{final}'", file=sys.stderr)
            print(f"[normalize] fallback_root='{fallback_root}'", file=sys.stderr)
            return final
        else:
            final = os.path.abspath(path)
            print(f"[normalize] Already absolute: {path} -> {final}", file=sys.stderr)
            return final
    
    # Unix环境下（非WSL，没有Windows驱动器）
    if not os.path.isabs(path):
        # 如果仍然不是绝对路径，使用fallback_root
        result = os.path.join(fallback_root, path)
        final = os.path.abspath(result)
        print(f"[normalize] Unix relative: {path} -> {result} -> {final}", file=sys.stderr)
        return final
    
    final = os.path.abspath(path)
    print(f"[normalize] Final: {path} -> {final}", file=sys.stderr)
    return final


def download_file(url: str, path: str, retry: int = 2, headers: Optional[dict] = None):
    attempt = 0
    while attempt <= retry:
        try:
            ensure_dir(path)
            req_headers = {}
            if headers:
                if headers.get("referer"):
                    req_headers["Referer"] = headers.get("referer")
                if headers.get("cookie"):
                    req_headers["Cookie"] = headers.get("cookie")
                if headers.get("ua"):
                    req_headers["User-Agent"] = headers.get("ua")
            with requests.get(url, stream=True, timeout=30, headers=req_headers) as r:
                r.raise_for_status()
                ctype = r.headers.get("content-type", "")
                if "text/html" in ctype:
                    raise Exception(f"content-type is html: {ctype}")
                with open(path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 512):
                        if chunk:
                            f.write(chunk)
            return True, None
        except Exception as e:
            attempt += 1
            if attempt > retry:
                return False, str(e)


def append_log(log_file: str, data: dict):
    try:
        ensure_dir(log_file)
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": __import__("time").time(), **data}, ensure_ascii=False) + "\n")
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "JDVideoLocalDownloader/0.1"

    def log_message(self, format, *args):
        # suppress default console noise; we log manually
        return

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # 健康检查或默认访问
        self._send_json(200, {"ok": True, "msg": "use POST /download"})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send_json(400, {"ok": False, "error": "invalid_json"})

        if parsed.path == "/log":
            append_log(self.server.log_file, payload)
            return self._send_json(200, {"ok": True})

        if parsed.path != "/download":
            return self._send_json(404, {"ok": False, "error": "not_found"})

        items = payload.get("items") or []
        target_dir = payload.get("target_dir") or self.server.root_dir
        sub_dir = payload.get("sub_dir") or ""

        # 记录原始输入用于调试
        import sys
        print(f"[download] received target_dir raw: {repr(target_dir)}", file=sys.stderr)
        target_dir = normalize_root(target_dir, self.server.root_dir)
        print(f"[download] normalized target_dir: {target_dir}", file=sys.stderr)

        results = []
        success = 0
        append_log(self.server.log_file, {"event": "server:recv", "count": len(items), "target": target_dir, "sub": sub_dir})

        with ThreadPoolExecutor(max_workers=self.server.concurrency) as pool:
            futures = {}
            for item in items:
                sku = item.get("sku") or "unknown"
                title = item.get("title") or "video"
                url = item.get("videoUrl")
                if not url:
                    results.append({"sku": sku, "title": title, "ok": False, "error": "missing_url"})
                    continue
                path = build_path(target_dir, sub_dir, sku, title)
                headers = item.get("headers") or {}
                fut = pool.submit(download_file, url, path, self.server.retry, headers)
                futures[fut] = (sku, title, path, url)

            for fut in as_completed(futures):
                sku, title, path, url = futures[fut]
                ok, err = fut.result()
                if ok:
                    success += 1
                    results.append({"sku": sku, "title": title, "ok": True, "path": path})
                    append_log(self.server.log_file, {"event": "ok", "sku": sku, "path": path})
                else:
                    results.append({"sku": sku, "title": title, "ok": False, "error": err, "url": url})
                    append_log(self.server.log_file, {"event": "fail", "sku": sku, "error": err, "url": url})

        return self._send_json(200, {"ok": True, "success": success, "total": len(items), "results": results})


def run_server(host: str, port: int, root_dir: str, concurrency: int, retry: int):
    server = HTTPServer((host, port), Handler)
    server.root_dir = root_dir
    server.concurrency = concurrency
    server.retry = retry
    server.log_file = os.path.join(root_dir, "logs", "jdvideo.log")
    print(f"[server] listening on http://{host}:{port}, root={root_dir}, concurrency={concurrency}, retry={retry}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("bye")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3030)
    parser.add_argument("--root", default="./downloads", help="默认保存根目录（可相对/绝对）")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--retry", type=int, default=2)
    args = parser.parse_args()

    root_abs = os.path.abspath(args.root)
    ensure_dir(os.path.join(root_abs, "dummy.txt"))
    run_server(args.host, args.port, root_abs, args.concurrency, args.retry)

