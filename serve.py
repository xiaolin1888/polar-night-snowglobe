#!/usr/bin/env python3
"""极夜雪境 · 本地静态服务

与 `python -m http.server` 的区别：
1. 所有响应带 `Cache-Control: no-store`，改完文件刷新即生效，不会读到旧脚本；
2. 显式声明 .glb / .gltf 的 MIME，避免部分浏览器对二进制模型处理异常；
3. 只监听 127.0.0.1，不触发防火墙提示。
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8930
    root = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = partial(Handler, directory=root)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {root} at http://127.0.0.1:{port}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
