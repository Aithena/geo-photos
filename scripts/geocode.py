#!/usr/bin/env python3
"""逆地理编码：多源回退 + 磁盘缓存。扫描写库与浏览 API 共用。"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEOCODE_CACHE_PATH = ROOT / "data" / "geocode-cache.json"

_geocode_lock = threading.Lock()
_geocode_cache: dict = {}
_geocode_last_fetch = 0.0


def load_geocode_cache() -> None:
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


def cache_key(lat: float, lng: float) -> str:
    # 与前端地点网格精度大致对齐
    return f"{round(lat, 2):.2f},{round(lng, 2):.2f}"


def _simplify_zh(text: str) -> str:
    if not text:
        return text
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
    country = (addr.get("country") or "").strip()

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
        address = display_name.replace(", 中国", "").replace(", China", "").strip()

    return {
        "label": _simplify_zh(label),
        "city": _simplify_zh(city or state),
        "district": _simplify_zh(district),
        "road": _simplify_zh(road),
        "country": _simplify_zh(country),
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
        "country": _simplify_zh(country),
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
        "country": props.get("country") or "",
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
    key = cache_key(lat, lng)
    with _geocode_lock:
        cached = _geocode_cache.get(key)
        # 旧缓存没有 country 时补拉一次，之后仍走磁盘缓存
        if cached and "country" in cached:
            return {"ok": True, "cached": True, "key": key, **cached}

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
            "country": "",
        }

    with _geocode_lock:
        _geocode_cache[key] = formatted
        _save_geocode_cache()
    return {"ok": True, "cached": False, "key": key, **formatted}
