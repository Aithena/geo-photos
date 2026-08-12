#!/usr/bin/env python3
"""本地静态站 + 索引进度 API（端口默认 18809）。"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

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
GEOCODE_CACHE_PATH = ROOT / "data" / "geocode-cache.json"
_geocode_lock = threading.Lock()
_geocode_cache: dict = {}
_geocode_last_fetch = 0.0


def _load_geocode_cache() -> None:
    global _geocode_cache
    if not GEOCODE_CACHE_PATH.is_file():
        _geocode_cache = {}
        return
    try:
        _geocode_cache = json.loads(GEOCODE_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        _geocode_cache = {}


def _save_geocode_cache() -> None:
    try:
        GEOCODE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        GEOCODE_CACHE_PATH.write_text(
            json.dumps(_geocode_cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _cache_key(lat: float, lng: float) -> str:
    # 与前端地点网格精度大致对齐
    return f"{round(lat, 2):.2f},{round(lng, 2):.2f}"


def _simplify_zh(text: str) -> str:
    if not text:
        return text
    # BigDataCloud 偶发繁体，做常见字替换即可
    out = text
    for a, b in (
        ("廣場", "广场"),
        ("區", "区"),
        ("國", "国"),
        ("縣", "县"),
        ("鄉", "乡"),
        ("鎮", "镇"),
        ("裡", "里"),
        ("門", "门"),
        ("東", "东"),
        ("廣", "广"),
        ("灣", "湾"),
        ("島", "岛"),
        ("濱", "滨"),
        ("橋", "桥"),
        ("場", "场"),
        ("學", "学"),
        ("園", "园"),
    ):
        out = out.replace(a, b)
    return out


def _format_place(addr: dict, display_name: str = "") -> dict:
    state = (addr.get("state") or "").strip()
    city = (
        addr.get("city")
        or addr.get("town")
        or addr.get("municipality")
        or addr.get("county")
        or ""
    ).strip()
    district = (
        addr.get("city_district")
        or addr.get("district")
        or addr.get("suburb")
        or addr.get("borough")
        or addr.get("quarter")
        or ""
    ).strip()
    road = (
        addr.get("road")
        or addr.get("pedestrian")
        or addr.get("footway")
        or addr.get("neighbourhood")
        or addr.get("village")
        or addr.get("hamlet")
        or ""
    ).strip()
    building = (addr.get("building") or addr.get("amenity") or addr.get("tourism") or "").strip()

    title_parts = []
    if city:
        title_parts.append(city)
    if district and district != city:
        title_parts.append(district)
    if not title_parts and state:
        title_parts.append(state)
    label = "".join(title_parts) if title_parts else (display_name.split(",")[0].strip() if display_name else "未知地点")

    detail_parts = []
    if road:
        detail_parts.append(road)
    if building and building not in detail_parts:
        detail_parts.append(building)
    address = "".join([state if state and state not in label else "", label, *detail_parts])
    if not detail_parts and display_name:
        # 回退：用 display_name 去掉国家等尾巴
        address = display_name.replace(", 中国", "").replace(", China", "").strip()

    return {
        "label": _simplify_zh(label),
        "city": _simplify_zh(city or state),
        "district": _simplify_zh(district),
        "road": _simplify_zh(road),
        "address": _simplify_zh(address or label),
        "displayName": _simplify_zh(display_name),
    }


def _http_json(url: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "geo-photos-local/1.0 (local photo album; reverse geocode cache)",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _from_bigdatacloud(lat: float, lng: float) -> dict | None:
    params = urllib.parse.urlencode(
        {
            "latitude": f"{lat:.6f}",
            "longitude": f"{lng:.6f}",
            "localityLanguage": "zh",
        }
    )
    raw = _http_json(f"https://api.bigdatacloud.net/data/reverse-geocode-client?{params}", 8)
    city = (
        raw.get("city")
        or raw.get("locality")
        or raw.get("principalSubdivision")
        or ""
    ).strip()
    locality_info = raw.get("localityInfo") or {}
    admin: list[tuple[int, str]] = []
    for bucket in ("administrative", "informative"):
        for item in locality_info.get(bucket) or []:
            name = (item.get("name") or "").strip()
            if name:
                admin.append((int(item.get("order") or 0), name))
    names = [n for _, n in sorted(admin, key=lambda x: x[0])]
    if not city and names:
        city = names[-2] if len(names) >= 2 else names[-1]
    sub = ""
    country = (raw.get("countryName") or "").strip()
    for n in reversed(names):
        if n != city and n != country:
            sub = n
            break
    label_parts = [p for p in (city, sub if sub != city else "") if p]
    label = "".join(label_parts) if label_parts else (raw.get("locality") or "").strip()
    if not label:
        return None
    address = "".join(
        p
        for p in [
            (raw.get("principalSubdivision") or "").strip(),
            city,
            sub if sub != city else "",
        ]
        if p
    )
    return {
        "label": _simplify_zh(label),
        "city": _simplify_zh(city),
        "district": _simplify_zh(sub if sub != city else ""),
        "road": "",
        "address": _simplify_zh(address or label),
        "displayName": _simplify_zh(address or label),
        "provider": "bigdatacloud",
    }


def _from_photon(lat: float, lng: float) -> dict | None:
    params = urllib.parse.urlencode({"lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "lang": "zh"})
    raw = _http_json(f"https://photon.komoot.io/reverse?{params}", 8)
    feats = raw.get("features") or []
    if not feats:
        return None
    props = feats[0].get("properties") or {}
    addr = {
        "state": props.get("state") or "",
        "city": props.get("city") or props.get("town") or props.get("county") or "",
        "district": props.get("district") or props.get("suburb") or "",
        "road": props.get("street") or props.get("name") or "",
    }
    formatted = _format_place(addr, props.get("name") or "")
    formatted["provider"] = "photon"
    return formatted


def _from_nominatim(lat: float, lng: float) -> dict | None:
    params = urllib.parse.urlencode(
        {
            "lat": f"{lat:.6f}",
            "lon": f"{lng:.6f}",
            "format": "json",
            "addressdetails": 1,
            "zoom": 16,
            "accept-language": "zh-CN",
        }
    )
    raw = _http_json(f"https://nominatim.openstreetmap.org/reverse?{params}", 10)
    addr = raw.get("address") or {}
    if not addr and not raw.get("display_name"):
        return None
    formatted = _format_place(addr, raw.get("display_name") or "")
    formatted["provider"] = "nominatim"
    return formatted


def reverse_geocode(lat: float, lng: float) -> dict:
    """逆地理编码：多源回退 + 磁盘缓存。"""
    global _geocode_last_fetch
    key = _cache_key(lat, lng)
    with _geocode_lock:
        if key in _geocode_cache:
            return {"ok": True, "cached": True, "key": key, **_geocode_cache[key]}

    with _geocode_lock:
        wait = 0.35 - (time.time() - _geocode_last_fetch)
    if wait > 0:
        time.sleep(wait)

    errors: list[str] = []
    formatted = None
    for name, fn in (
        ("bigdatacloud", _from_bigdatacloud),
        ("photon", _from_photon),
        ("nominatim", _from_nominatim),
    ):
        try:
            formatted = fn(lat, lng)
            if formatted and formatted.get("label"):
                break
            errors.append(f"{name}: empty")
            formatted = None
        except Exception as e:
            errors.append(f"{name}: {e}")
            formatted = None

    with _geocode_lock:
        _geocode_last_fetch = time.time()

    if not formatted:
        return {
            "ok": False,
            "key": key,
            "error": "; ".join(errors) or "geocode failed",
            "label": f"地点 {lat:.2f}°, {lng:.2f}°",
            "address": "",
            "city": "",
            "district": "",
            "road": "",
        }

    with _geocode_lock:
        _geocode_cache[key] = formatted
        _save_geocode_cache()
    return {"ok": True, "cached": False, "key": key, **formatted}

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

    _load_geocode_cache()

    handler = partial(Handler, directory=ROOT)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"Geo Photos → http://{args.bind}:{args.port}/")
    print(f"扫描界面 → http://{args.bind}:{args.port}/scan.html")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
