#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Journey 夹具服务器：静态服务 + 慢接口 + 挂起接口

用法:
    python3 server.py
    → http://127.0.0.1:8899/

端点:
    /slow-api?delay=2000   延迟 delay 毫秒后返回 JSON（默认 2000ms）
    /hang-api              永不返回（客户端 abort 后服务端感知并结束线程）
    其他路径                按静态文件服务（根 = 本文件所在目录）

注意: 必须用 ThreadingHTTPServer——挂起请求不能阻塞静态文件服务。
"""
import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8899


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path == '/slow-api':
            delay_ms = 2000
            for kv in query.split('&'):
                if kv.startswith('delay='):
                    try:
                        delay_ms = max(0, int(kv[6:]))
                    except ValueError:
                        pass
            time.sleep(delay_ms / 1000)
            self._json({'ok': True, 'data': 'slow-api 响应', 'costMs': delay_ms})
        elif path == '/hang-api':
            self._hang()
        else:
            super().do_GET()

    def do_POST(self):
        path, _, _query = self.path.partition('?')
        if path == '/echo-api':
            try:
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length).decode('utf-8', 'replace') if length else ''
            except Exception:
                raw = ''
            self._json({'ok': True, 'echo': raw[:200], 'path': path})
        else:
            self._json({'ok': False, 'error': 'unknown POST endpoint'})

    def _hang(self):
        # 永不完成响应；周期性写心跳，客户端 abort 后 BrokenPipe 退出线程
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        try:
            while True:
                self.wfile.write(b'{"ping":true}\n')
                self.wfile.flush()
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # 静音访问日志，避免刷屏


if __name__ == '__main__':
    print('Journey 夹具: http://127.0.0.1:%d/  (Ctrl+C 停止)' % PORT)
    ThreadingHTTPServer(('127.0.0.1', PORT), DemoHandler).serve_forever()
