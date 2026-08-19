#!/usr/bin/env python3
"""本地静态站 + 索引进度 API（端口默认 18809）。"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from geocode import load_geocode_cache, reverse_geocode  # noqa: E402
from index_photos import (  # noqa: E402
    DEFAULT_DB,
    DEFAULT_INBOX,
    DEFAULT_MANIFEST,
    DEFAULT_NO_GPS,
    DEFAULT_PHOTOS,
    DEFAULT_SHARDS,
    DEFAULT_THUMBS,
    index_photos,
)

PORT = 18809

_lock = threading.Lock()
_job = {
    "state": "idle",  # idle | running | done | error
    "phase": "idle",
    "message": "尚未开始扫描",
    "percent": 0,
    "total": 0,
    "current": 0,
    "currentFile": "",
    "scanned": 0,
    "skipped": 0,
    "updated": 0,
    "removed": 0,
    "moved": 0,
    "inbox": 0,
    "errors": 0,
    "with_gps": None,
    "no_gps": None,
    "elapsed_s": 0,
    "error": None,
}


def _snapshot() -> dict:
    with _lock:
        return dict(_job)


def _update(**kwargs) -> None:
    with _lock:
        _job.update(kwargs)


def _on_progress(payload: dict) -> None:
    with _lock:
        _job["state"] = "running" if payload.get("phase") != "done" else "done"
        for key in (
            "phase",
            "message",
            "percent",
            "total",
            "current",
            "currentFile",
            "scanned",
            "skipped",
            "updated",
            "removed",
            "moved",
            "inbox",
            "errors",
            "elapsed_s",
            "with_gps",
            "no_gps",
        ):
            if key in payload:
                _job[key] = payload[key]
        if payload.get("phase") == "done":
            _job["state"] = "done"
            _job["message"] = payload.get("message") or "扫描完成"
            _job["percent"] = 100


def _run_index(force: bool = False) -> None:
    try:
        _update(
            state="running",
            phase="counting",
            message="正在启动扫描…",
            percent=0,
            error=None,
            currentFile="",
            scanned=0,
            skipped=0,
            updated=0,
            removed=0,
            moved=0,
            inbox=0,
            errors=0,
            with_gps=None,
            no_gps=None,
            elapsed_s=0,
        )
        stats = index_photos(
            photos_dir=DEFAULT_PHOTOS,
            db_path=DEFAULT_DB,
            thumbs_dir=DEFAULT_THUMBS,
            shards_dir=DEFAULT_SHARDS,
            manifest_path=DEFAULT_MANIFEST,
            force=force,
            on_progress=_on_progress,
            inbox_dir=DEFAULT_INBOX,
            no_gps_dir=DEFAULT_NO_GPS,
        )
        _update(
            state="done",
            phase="done",
            message=(
                f"完成：inbox {stats.get('inbox', 0)} → "
                f"photos +{stats.get('to_photos', 0)} / "
                f"no-gps +{stats.get('moved', 0)}"
            ),
            percent=100,
            with_gps=stats.get("with_gps"),
            no_gps=stats.get("no_gps", 0),
            elapsed_s=stats.get("elapsed_s"),
            scanned=stats.get("scanned", 0),
            skipped=stats.get("skipped", 0),
            updated=stats.get("updated", 0),
            removed=stats.get("removed", 0),
            moved=stats.get("moved", 0),
            inbox=stats.get("inbox", 0),
            errors=stats.get("errors", 0),
            total=stats.get("total", stats.get("scanned", 0)),
            current=stats.get("scanned", 0),
        )
    except Exception as e:
        _update(
            state="error",
            phase="error",
            message=str(e),
            error=traceback.format_exc(),
        )


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(directory or ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # 减少刷屏；API 仍打印
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/index/status":
            self._json(200, _snapshot())
            return
        if path == "/api/geocode/reverse":
            qs = parse_qs(parsed.query or "")
            try:
                lat = float((qs.get("lat") or [""])[0])
                lng = float((qs.get("lng") or qs.get("lon") or [""])[0])
            except (TypeError, ValueError):
                self._json(400, {"ok": False, "error": "lat/lng 无效"})
                return
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                self._json(400, {"ok": False, "error": "lat/lng 超出范围"})
                return
            self._json(200, reverse_geocode(lat, lng))
            return
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/index/start":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}

        force = bool(body.get("force"))

        with _lock:
            if _job["state"] == "running":
                self._json(409, {"ok": False, "error": "已有扫描在进行中", "status": dict(_job)})
                return

        t = threading.Thread(target=_run_index, kwargs={"force": force}, daemon=True)
        t.start()
        self._json(202, {"ok": True, "status": _snapshot()})


def main():
    ap = argparse.ArgumentParser(description="Geo Photos 本地服务")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    if not DEFAULT_INBOX.is_dir():
        DEFAULT_INBOX.mkdir(parents=True, exist_ok=True)
    if not DEFAULT_PHOTOS.is_dir():
        print(f"警告: 照片目录不存在 {DEFAULT_PHOTOS}", file=sys.stderr)

    load_geocode_cache()

    handler = partial(Handler, directory=ROOT)
    try:
        httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    except OSError as e:
        print(f"无法监听 {args.bind}:{args.port}：{e}", flush=True)
        print("端口可能已被占用。可先打开已有服务：", flush=True)
        print(f"  http://{args.bind}:{args.port}/scan.html", flush=True)
        sys.exit(1)

    print(f"Geo Photos → http://{args.bind}:{args.port}/", flush=True)
    print(f"扫描界面 → http://{args.bind}:{args.port}/scan.html", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)


if __name__ == "__main__":
    main()
