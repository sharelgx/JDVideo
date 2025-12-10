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


def download_file(url: str, path: str, retry: int = 2, headers: dict | None = None):
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

        if not os.path.isabs(target_dir):
            target_dir = os.path.abspath(target_dir)

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

