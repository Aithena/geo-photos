#!/usr/bin/env python3
"""增量扫描照片：EXIF GPS → SQLite → 缩略图 → 分片 JSON。"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageOps, ExifTags

from geocode import load_geocode_cache, reverse_geocode

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INBOX = ROOT / "inbox"       # 新下载图片入口
DEFAULT_PHOTOS = ROOT / "photos"     # 有 GPS，供地图使用
DEFAULT_NO_GPS = ROOT / "no-gps"     # 无 GPS 归档
DEFAULT_DB = ROOT / "data" / "photos.db"
DEFAULT_THUMBS = ROOT / "thumbs"
DEFAULT_SHARDS = ROOT / "data" / "shards"
DEFAULT_MANIFEST = ROOT / "data" / "manifest.json"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
THUMB_MAX = 240
GEOHASH_PRECISION = 4  # ~39km cells；改图少时只重写相关分片

# Pillow Exif GPS tags
_GPS_TAGS = {v: k for k, v in ExifTags.GPSTAGS.items()} if hasattr(ExifTags, "GPSTAGS") else {}
_EXIF_TAGS = {v: k for k, v in ExifTags.TAGS.items()}
_EXIF_IFD = 0x8769  # Exif IFD
_GPS_IFD = 0x8825

# 库里保存的完整元数据列（地图分片仍只导出 path/thumb/lat/lng/takenAt）
_META_COLUMNS = [
    ("content_hash", "TEXT"),
    ("width", "INTEGER"),
    ("height", "INTEGER"),
    ("orientation", "INTEGER"),
    ("mime", "TEXT"),
    ("make", "TEXT"),
    ("model", "TEXT"),
    ("tz_offset", "TEXT"),
    ("taken_at_utc", "TEXT"),
    ("gps_date", "TEXT"),
    ("gps_time", "TEXT"),
    ("altitude", "REAL"),
    ("altitude_ref", "INTEGER"),
    ("heading", "REAL"),
    ("heading_ref", "TEXT"),
    ("gps_h_error", "REAL"),
    ("gps_dop", "REAL"),
    ("city", "TEXT"),
    ("district", "TEXT"),
    ("country", "TEXT"),
    ("road", "TEXT"),
    ("place_label", "TEXT"),
    ("place_address", "TEXT"),
    ("place_provider", "TEXT"),
    ("original_name", "TEXT"),
    ("file_ctime", "TEXT"),
    ("first_seen_at", "TEXT"),
]


def _ratio_to_float(x) -> float:
    if hasattr(x, "numerator") and hasattr(x, "denominator"):
        return float(x.numerator) / float(x.denominator) if x.denominator else 0.0
    if isinstance(x, tuple) and len(x) == 2:
        return float(x[0]) / float(x[1]) if x[1] else 0.0
    return float(x)


def _dms_to_deg(dms) -> float:
    d, m, s = dms
    return _ratio_to_float(d) + _ratio_to_float(m) / 60.0 + _ratio_to_float(s) / 3600.0


def _as_str(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace").strip("\x00").strip() or None
    s = str(v).strip()
    return s or None


def _as_int(v) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, bytes):
        v = v[0] if v else None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _as_float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return _ratio_to_float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _empty_to_none(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _exif_get(exif, extra_ifds, name):
    tid = _EXIF_TAGS.get(name)
    if tid is None:
        return None
    for src in (exif, *extra_ifds):
        if src is None:
            continue
        try:
            if tid in src:
                return src.get(tid)
        except Exception:
            continue
    return None


def _parse_datetime(raw) -> str | None:
    s = _as_str(raw)
    if not s or len(s) < 19:
        return None
    try:
        return datetime.strptime(s[:19], "%Y:%m:%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def _parse_offset(raw) -> str | None:
    s = _as_str(raw)
    if not s:
        return None
    s = s.replace(" ", "")
    if s[0] not in "+-" and len(s) >= 4:
        s = "+" + s
    return s


def _offset_tz(offset: str | None):
    if not offset:
        return None
    s = offset.strip()
    sign = -1 if s.startswith("-") else 1
    digits = s[1:] if s[:1] in "+-" else s
    digits = digits.replace(":", "")
    if len(digits) < 4:
        return None
    try:
        hours, minutes = int(digits[:2]), int(digits[2:4])
    except ValueError:
        return None
    return timezone(sign * timedelta(hours=hours, minutes=minutes))


def _gps_time_str(ts) -> str | None:
    if not ts or not isinstance(ts, (tuple, list)) or len(ts) < 3:
        return None
    try:
        h = _ratio_to_float(ts[0])
        m = _ratio_to_float(ts[1])
        sec = _ratio_to_float(ts[2])
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    whole = int(sec)
    frac = sec - whole
    if frac:
        return f"{int(h):02d}:{int(m):02d}:{whole:02d}{f'{frac:.3f}'[1:]}"
    return f"{int(h):02d}:{int(m):02d}:{whole:02d}"


def _compute_taken_at_utc(
    taken_at: str | None,
    tz_offset: str | None,
    gps_date: str | None,
    gps_time: str | None,
) -> str | None:
    if gps_date and gps_time:
        stamp = f"{gps_date} {gps_time[:8]}"
        try:
            dt = datetime.strptime(stamp, "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except ValueError:
            pass
    if taken_at:
        try:
            naive = datetime.fromisoformat(taken_at)
        except ValueError:
            return None
        tz = _offset_tz(tz_offset)
        if tz is not None:
            return naive.replace(tzinfo=tz).astimezone(timezone.utc).isoformat()
    return None


def _file_sha256(path: Path) -> str | None:
    h = hashlib.sha256()
    try:
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _ts_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def extract_exif(path: Path) -> dict:
    """读取文件与 EXIF：GPS、时间、机身、尺寸等。缺失字段为 None。"""
    out = {
        "lat": None,
        "lng": None,
        "taken_at": None,
        "width": None,
        "height": None,
        "orientation": None,
        "mime": None,
        "make": None,
        "model": None,
        "tz_offset": None,
        "taken_at_utc": None,
        "gps_date": None,
        "gps_time": None,
        "altitude": None,
        "altitude_ref": None,
        "heading": None,
        "heading_ref": None,
        "gps_h_error": None,
        "gps_dop": None,
    }
    try:
        with Image.open(path) as im:
            out["width"], out["height"] = im.size
            if hasattr(im, "get_format_mimetype"):
                out["mime"] = im.get_format_mimetype()
            elif im.format:
                out["mime"] = Image.MIME.get(im.format) or f"image/{im.format.lower()}"

            exif = im.getexif()
            if not exif:
                return out

            exif_ifd = None
            gps_ifd = None
            try:
                exif_ifd = exif.get_ifd(_EXIF_IFD)
            except Exception:
                exif_ifd = None
            try:
                gps_ifd = exif.get_ifd(_GPS_IFD)
            except Exception:
                gps_ifd = None

            extra = (exif_ifd,)
            out["make"] = _as_str(_exif_get(exif, extra, "Make"))
            out["model"] = _as_str(_exif_get(exif, extra, "Model"))
            out["orientation"] = _as_int(_exif_get(exif, extra, "Orientation"))

            for key in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
                parsed = _parse_datetime(_exif_get(exif, extra, key))
                if parsed:
                    out["taken_at"] = parsed
                    break
            for key in ("OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime"):
                off = _parse_offset(_exif_get(exif, extra, key))
                if off:
                    out["tz_offset"] = off
                    break

            if gps_ifd:
                def g(name):
                    tid = _GPS_TAGS.get(name)
                    return gps_ifd.get(tid) if tid is not None else None

                lat_v, lat_ref = g("GPSLatitude"), g("GPSLatitudeRef")
                lng_v, lng_ref = g("GPSLongitude"), g("GPSLongitudeRef")
                if lat_v and lng_v:
                    lat = _dms_to_deg(lat_v)
                    lng = _dms_to_deg(lng_v)
                    if _as_str(lat_ref) == "S":
                        lat = -lat
                    if _as_str(lng_ref) == "W":
                        lng = -lng
                    if -90 <= lat <= 90 and -180 <= lng <= 180:
                        out["lat"] = round(lat, 7)
                        out["lng"] = round(lng, 7)

                alt = _as_float(g("GPSAltitude"))
                alt_ref = _as_int(g("GPSAltitudeRef"))
                out["altitude_ref"] = alt_ref
                if alt is not None:
                    out["altitude"] = round(-alt if alt_ref == 1 else alt, 2)

                heading = _as_float(g("GPSImgDirection"))
                if heading is not None:
                    out["heading"] = round(heading % 360.0, 2)
                out["heading_ref"] = _as_str(g("GPSImgDirectionRef"))

                h_err = _as_float(g("GPSHPositioningError"))
                dop = _as_float(g("GPSDOP"))
                if h_err is not None:
                    out["gps_h_error"] = round(h_err, 2)
                if dop is not None:
                    out["gps_dop"] = round(dop, 2)

                out["gps_date"] = _as_str(g("GPSDateStamp"))
                out["gps_time"] = _gps_time_str(g("GPSTimeStamp"))

            out["taken_at_utc"] = _compute_taken_at_utc(
                out["taken_at"], out["tz_offset"], out["gps_date"], out["gps_time"]
            )
    except Exception as e:
        out["error"] = str(e)
    return out


# ---- geohash (base32) -------------------------------------------------------
_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash_encode(lat: float, lng: float, precision: int = GEOHASH_PRECISION) -> str:
    lat_min, lat_max = -90.0, 90.0
    lng_min, lng_max = -180.0, 180.0
    bits = []
    even = True
    while len(bits) < precision * 5:
        if even:
            mid = (lng_min + lng_max) / 2
            if lng >= mid:
                bits.append(1)
                lng_min = mid
            else:
                bits.append(0)
                lng_max = mid
        else:
            mid = (lat_min + lat_max) / 2
            if lat >= mid:
                bits.append(1)
                lat_min = mid
            else:
                bits.append(0)
                lat_max = mid
        even = not even
    chars = []
    for i in range(0, len(bits), 5):
        idx = 0
        for b in bits[i : i + 5]:
            idx = (idx << 1) | b
        chars.append(_BASE32[idx])
    return "".join(chars)


def geohash_bounds(gh: str) -> dict:
    lat_min, lat_max = -90.0, 90.0
    lng_min, lng_max = -180.0, 180.0
    even = True
    for ch in gh:
        idx = _BASE32.index(ch)
        for bit in [(idx >> 4) & 1, (idx >> 3) & 1, (idx >> 2) & 1, (idx >> 1) & 1, idx & 1]:
            if even:
                mid = (lng_min + lng_max) / 2
                if bit:
                    lng_min = mid
                else:
                    lng_max = mid
            else:
                mid = (lat_min + lat_max) / 2
                if bit:
                    lat_min = mid
                else:
                    lat_max = mid
            even = not even
    return {
        "south": lat_min,
        "north": lat_max,
        "west": lng_min,
        "east": lng_max,
    }


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY,
            rel_path TEXT NOT NULL UNIQUE,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            lat REAL,
            lng REAL,
            taken_at TEXT,
            has_gps INTEGER NOT NULL DEFAULT 0,
            thumb_path TEXT,
            geohash TEXT,
            error TEXT,
            indexed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(has_gps);
        CREATE INDEX IF NOT EXISTS idx_photos_geohash ON photos(geohash);
        CREATE INDEX IF NOT EXISTS idx_photos_mtime ON photos(mtime);
        """
    )
    existing = {row[1] for row in conn.execute("PRAGMA table_info(photos)")}
    for name, typ in _META_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE photos ADD COLUMN {name} {typ}")
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(content_hash);
        CREATE INDEX IF NOT EXISTS idx_photos_city ON photos(city);
        CREATE INDEX IF NOT EXISTS idx_photos_make ON photos(make);
        CREATE INDEX IF NOT EXISTS idx_photos_taken_utc ON photos(taken_at_utc);
        """
    )


def _row_get(row, key, default=None):
    try:
        val = row[key]
    except (IndexError, KeyError):
        return default
    return default if val is None else val


def needs_meta_backfill(row) -> bool:
    if row is None:
        return True
    return not _row_get(row, "content_hash") or _row_get(row, "width") is None


def lookup_place(lat: float, lng: float) -> dict:
    """扫描时写入地点字段；失败不阻断索引，也不写入占位文案。"""
    empty = {
        "city": None,
        "district": None,
        "country": None,
        "road": None,
        "place_label": None,
        "place_address": None,
        "place_provider": None,
    }
    try:
        place = reverse_geocode(lat, lng)
    except Exception:
        return empty
    if not place.get("ok"):
        return empty
    return {
        "city": _empty_to_none(place.get("city")),
        "district": _empty_to_none(place.get("district")),
        "country": _empty_to_none(place.get("country")),
        "road": _empty_to_none(place.get("road")),
        "place_label": _empty_to_none(place.get("label")),
        "place_address": _empty_to_none(place.get("address")),
        "place_provider": _empty_to_none(place.get("provider")),
    }


def upsert_photo(conn: sqlite3.Connection, rec: dict) -> None:
    cols = list(rec.keys())
    placeholders = ",".join("?" * len(cols))
    updates = ",".join(
        f"{c}=excluded.{c}" for c in cols if c not in ("rel_path", "first_seen_at")
    )
    updates += ", first_seen_at=COALESCE(photos.first_seen_at, excluded.first_seen_at)"
    conn.execute(
        f"""
        INSERT INTO photos ({",".join(cols)})
        VALUES ({placeholders})
        ON CONFLICT(rel_path) DO UPDATE SET {updates}
        """,
        tuple(rec[c] for c in cols),
    )


def make_thumb(src: Path, dest: Path, max_size: int = THUMB_MAX) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        im.save(dest, "JPEG", quality=82, optimize=True)


def thumb_rel_for(rel_path: str) -> str:
    # 用稳定 hash 避免深层路径 / 特殊字符
    h = hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]
    return f"thumbs/{h}.jpg"


def iter_images(photos_dir: Path):
    for p in photos_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            yield p


def list_images(photos_dir: Path) -> list[Path]:
    return sorted(iter_images(photos_dir), key=lambda p: p.as_posix().lower())


def move_by_filename(src: Path, dest_dir: Path) -> Path:
    """移动到目标目录，按文件名去重（同名直接覆盖）。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    src_res = src.resolve()
    dest_res = dest.resolve()
    if src_res == dest_res:
        return dest
    if dest.exists():
        dest.unlink()
    shutil.move(str(src), str(dest))
    return dest


def delete_thumb(thumb_rel: str | None) -> None:
    if not thumb_rel:
        return
    tp = ROOT / thumb_rel
    if tp.is_file():
        try:
            tp.unlink()
        except OSError:
            pass


def purge_db_row(conn: sqlite3.Connection, rel_path: str) -> None:
    row = conn.execute(
        "SELECT thumb_path FROM photos WHERE rel_path = ?", (rel_path,)
    ).fetchone()
    conn.execute("DELETE FROM photos WHERE rel_path = ?", (rel_path,))
    if row:
        delete_thumb(row["thumb_path"] if isinstance(row, sqlite3.Row) else row[0])


def sort_inbox(
    inbox_dir: Path,
    photos_dir: Path,
    no_gps_dir: Path,
    stats: dict,
    on_progress=None,
) -> None:
    """从 inbox 分流：有 GPS → photos，无 GPS → no-gps。"""
    inbox_dir.mkdir(parents=True, exist_ok=True)
    photos_dir.mkdir(parents=True, exist_ok=True)
    no_gps_dir.mkdir(parents=True, exist_ok=True)

    images = list_images(inbox_dir)
    total = len(images)
    if on_progress:
        on_progress(
            {
                "phase": "inbox",
                "message": f"处理入口目录 inbox/（{total} 张）…",
                "percent": 0,
                "total": total,
                "current": 0,
                "currentFile": "",
                "scanned": stats["scanned"],
                "skipped": stats["skipped"],
                "updated": stats["updated"],
                "removed": stats["removed"],
                "moved": stats["moved"],
                "inbox": stats.get("inbox", 0),
                "errors": stats["errors"],
                "elapsed_s": stats.get("elapsed_s", 0),
            }
        )

    for i, path in enumerate(images, start=1):
        stats["inbox"] = stats.get("inbox", 0) + 1
        name = path.name
        if on_progress:
            on_progress(
                {
                    "phase": "inbox",
                    "message": "分流 inbox…",
                    "percent": round(100.0 * i / total, 1) if total else 100,
                    "total": total,
                    "current": i,
                    "currentFile": name,
                    "scanned": stats["scanned"],
                    "skipped": stats["skipped"],
                    "updated": stats["updated"],
                    "removed": stats["removed"],
                    "moved": stats["moved"],
                    "inbox": stats["inbox"],
                    "errors": stats["errors"],
                }
            )

        try:
            meta = extract_exif(path)
            has_gps = meta["lat"] is not None and meta["lng"] is not None
            if has_gps:
                move_by_filename(path, photos_dir)
                stats["to_photos"] = stats.get("to_photos", 0) + 1
            else:
                move_by_filename(path, no_gps_dir)
                stats["moved"] += 1
        except Exception:
            stats["errors"] += 1


def index_photos(
    photos_dir: Path,
    db_path: Path,
    thumbs_dir: Path,
    shards_dir: Path,
    manifest_path: Path,
    force: bool = False,
    on_progress=None,
    inbox_dir: Path | None = None,
    no_gps_dir: Path | None = None,
    photos2_dir: Path | None = None,  # 兼容旧参数名
) -> dict:
    """
    1) 处理 inbox：有 GPS → photos，无 GPS → no-gps（文件名去重覆盖）
    2) 增量索引 photos（仅有 GPS 的进入地图）
    3) photos 里若仍有无 GPS，迁到 no-gps
    """

    def emit(**extra):
        if not on_progress:
            return
        payload = {
            "phase": "running",
            "total": total,
            "current": stats["scanned"],
            "currentFile": "",
            "scanned": stats["scanned"],
            "skipped": stats["skipped"],
            "updated": stats["updated"],
            "removed": stats["removed"],
            "moved": stats["moved"],
            "inbox": stats.get("inbox", 0),
            "errors": stats["errors"],
            "percent": round(100.0 * stats["scanned"] / total, 1) if total else 0,
            "elapsed_s": round(time.time() - t0, 2),
        }
        payload.update(extra)
        on_progress(payload)

    photos_dir = photos_dir.resolve()
    inbox_dir = (inbox_dir or DEFAULT_INBOX).resolve()
    no_gps_dir = (no_gps_dir or photos2_dir or DEFAULT_NO_GPS).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    shards_dir.mkdir(parents=True, exist_ok=True)
    photos_dir.mkdir(parents=True, exist_ok=True)
    inbox_dir.mkdir(parents=True, exist_ok=True)
    no_gps_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    stats = {
        "scanned": 0,
        "skipped": 0,
        "updated": 0,
        "removed": 0,
        "moved": 0,
        "inbox": 0,
        "to_photos": 0,
        "with_gps": 0,
        "errors": 0,
    }
    total = 0

    # —— 先分流 inbox ——
    sort_inbox(inbox_dir, photos_dir, no_gps_dir, stats, on_progress=on_progress)

    if on_progress:
        on_progress(
            {
                "phase": "counting",
                "message": "正在统计 photos/ …",
                "percent": 0,
                "total": 0,
                "current": 0,
                "currentFile": "",
                "scanned": 0,
                "skipped": 0,
                "updated": 0,
                "removed": 0,
                "moved": stats["moved"],
                "inbox": stats["inbox"],
                "errors": stats["errors"],
                "elapsed_s": round(time.time() - t0, 2),
            }
        )

    images = list_images(photos_dir)
    total = len(images)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    load_geocode_cache()

    existing = {
        row["rel_path"]: row
        for row in conn.execute("SELECT * FROM photos")
    }

    seen: set[str] = set()
    geocode_ok = True
    geocode_fail_streak = 0
    emit(phase="running", message=f"photos/ 共 {total} 张，开始索引…")

    def place_fields(lat: float, lng: float) -> dict:
        nonlocal geocode_ok, geocode_fail_streak
        empty = {
            "city": None,
            "district": None,
            "country": None,
            "road": None,
            "place_label": None,
            "place_address": None,
            "place_provider": None,
        }
        if not geocode_ok:
            return empty
        place = lookup_place(lat, lng)
        if place.get("place_label") or place.get("city"):
            geocode_fail_streak = 0
            return place
        geocode_fail_streak += 1
        if geocode_fail_streak >= 3:
            geocode_ok = False
        return place

    for path in images:
        stats["scanned"] += 1
        rel = path.relative_to(photos_dir).as_posix()
        st = path.stat()
        mtime, size = st.st_mtime, st.st_size

        emit(currentFile=rel, message="索引 photos…")

        prev = existing.get(rel)
        file_unchanged = (
            not force
            and prev is not None
            and prev["has_gps"]
            and prev["mtime"] == mtime
            and prev["size"] == size
            and prev["thumb_path"]
            and (ROOT / prev["thumb_path"]).is_file()
        )

        # 增量：有 GPS、文件未变、元数据已齐全 → 跳过
        if file_unchanged and not needs_meta_backfill(prev):
            stats["skipped"] += 1
            seen.add(rel)
            continue

        # 增量：已知无 GPS → 迁到 no-gps
        if (
            not force
            and prev is not None
            and not prev["has_gps"]
            and prev["mtime"] == mtime
            and prev["size"] == size
        ):
            try:
                move_by_filename(path, no_gps_dir)
                purge_db_row(conn, rel)
                stats["moved"] += 1
            except Exception as e:
                stats["errors"] += 1
                emit(message=f"移出失败: {e}")
            continue

        meta = extract_exif(path)
        has_gps = meta["lat"] is not None and meta["lng"] is not None

        if not has_gps:
            try:
                move_by_filename(path, no_gps_dir)
                if prev is not None:
                    purge_db_row(conn, rel)
                stats["moved"] += 1
            except Exception as e:
                stats["errors"] += 1
                meta["error"] = str(e)
            continue

        # 有 GPS：写入索引（库为完整真相源；分片 JSON 仍只导出地图所需字段）
        seen.add(rel)
        if file_unchanged:
            thumb_rel = prev["thumb_path"]
            emit(currentFile=rel, message="补全元数据…")
        else:
            thumb_rel = thumb_rel_for(rel)
            try:
                make_thumb(path, ROOT / thumb_rel)
            except Exception as e:
                meta["error"] = (meta.get("error") or "") + f"; thumb: {e}"
                thumb_rel = None
                stats["errors"] += 1

        now = datetime.now(timezone.utc).isoformat()
        birth = getattr(st, "st_birthtime", None)
        place = place_fields(meta["lat"], meta["lng"])
        upsert_photo(
            conn,
            {
                "rel_path": rel,
                "mtime": mtime,
                "size": size,
                "lat": meta["lat"],
                "lng": meta["lng"],
                "taken_at": meta["taken_at"],
                "has_gps": 1,
                "thumb_path": thumb_rel,
                "geohash": geohash_encode(meta["lat"], meta["lng"]),
                "error": meta.get("error"),
                "indexed_at": now,
                "content_hash": _file_sha256(path),
                "width": meta.get("width"),
                "height": meta.get("height"),
                "orientation": meta.get("orientation"),
                "mime": meta.get("mime"),
                "make": meta.get("make"),
                "model": meta.get("model"),
                "tz_offset": meta.get("tz_offset"),
                "taken_at_utc": meta.get("taken_at_utc"),
                "gps_date": meta.get("gps_date"),
                "gps_time": meta.get("gps_time"),
                "altitude": meta.get("altitude"),
                "altitude_ref": meta.get("altitude_ref"),
                "heading": meta.get("heading"),
                "heading_ref": meta.get("heading_ref"),
                "gps_h_error": meta.get("gps_h_error"),
                "gps_dop": meta.get("gps_dop"),
                "city": place["city"],
                "district": place["district"],
                "country": place["country"],
                "road": place["road"],
                "place_label": place["place_label"],
                "place_address": place["place_address"],
                "place_provider": place["place_provider"],
                "original_name": path.name,
                "file_ctime": _ts_iso(birth if birth is not None else st.st_ctime),
                "first_seen_at": now,
            },
        )
        stats["updated"] += 1

        if stats["updated"] % 50 == 0:
            conn.commit()
            print(
                f"  … 已更新 {stats['updated']}，跳过 {stats['skipped']}，移出 {stats['moved']}",
                flush=True,
            )

    # 删除磁盘上已不存在的记录；清理库里残留的无 GPS 记录
    emit(phase="cleanup", message="清理索引…", currentFile="")
    for rel, row in existing.items():
        if rel not in seen:
            conn.execute("DELETE FROM photos WHERE rel_path = ?", (rel,))
            stats["removed"] += 1
            delete_thumb(row["thumb_path"])

    leftover = conn.execute(
        "SELECT rel_path, thumb_path FROM photos WHERE has_gps = 0"
    ).fetchall()
    for row in leftover:
        conn.execute("DELETE FROM photos WHERE rel_path = ?", (row["rel_path"],))
        delete_thumb(row["thumb_path"])
        stats["removed"] += 1

    conn.commit()

    stats["with_gps"] = conn.execute(
        "SELECT COUNT(*) FROM photos WHERE has_gps = 1"
    ).fetchone()[0]
    stats["total"] = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    stats["no_gps"] = 0

    emit(phase="exporting", message="导出地图分片…", percent=99, currentFile="")
    export_shards(conn, shards_dir, manifest_path, photos_dir)
    conn.close()

    stats["elapsed_s"] = round(time.time() - t0, 2)
    emit(
        phase="done",
        message=(
            f"完成：inbox {stats.get('inbox', 0)} → "
            f"photos +{stats.get('to_photos', 0)} / no-gps +{stats['moved']}"
        ),
        percent=100,
        currentFile="",
        with_gps=stats["with_gps"],
        total_indexed=stats["total"],
        no_gps=0,
        moved=stats["moved"],
        inbox=stats.get("inbox", 0),
        elapsed_s=stats["elapsed_s"],
    )
    return stats


def export_shards(
    conn: sqlite3.Connection,
    shards_dir: Path,
    manifest_path: Path,
    photos_dir: Path,
) -> None:
    # 分片只给地图用：完整元数据留在 SQLite，后续按功能另开接口。
    # 清空旧分片，避免残留
    for old in shards_dir.glob("*.json"):
        old.unlink()

    rows = conn.execute(
        """
        SELECT rel_path, lat, lng, taken_at, thumb_path, geohash
        FROM photos
        WHERE has_gps = 1
        ORDER BY taken_at, rel_path
        """
    ).fetchall()

    by_hash: dict[str, list] = {}
    min_lat = min_lng = math.inf
    max_lat = max_lng = -math.inf

    for r in rows:
        lat, lng = float(r["lat"]), float(r["lng"])
        min_lat, max_lat = min(min_lat, lat), max(max_lat, lat)
        min_lng, max_lng = min(min_lng, lng), max(max_lng, lng)
        gh = r["geohash"] or geohash_encode(lat, lng)
        item = {
            "path": f"photos/{r['rel_path']}",
            "thumb": r["thumb_path"],
            "lat": lat,
            "lng": lng,
            "takenAt": r["taken_at"],
        }
        by_hash.setdefault(gh, []).append(item)

    shards_meta = []
    for gh, items in sorted(by_hash.items()):
        bounds = geohash_bounds(gh)
        fname = f"{gh}.json"
        (shards_dir / fname).write_text(
            json.dumps({"geohash": gh, "photos": items}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        shards_meta.append(
            {
                "id": gh,
                "file": f"data/shards/{fname}",
                "count": len(items),
                "bounds": bounds,
            }
        )

    no_gps = conn.execute("SELECT COUNT(*) FROM photos WHERE has_gps = 0").fetchone()[0]
    manifest = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "photosRoot": "photos",
        "total": conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
        "withGps": len(rows),
        "withoutGps": no_gps,
        "bounds": None
        if not rows
        else {
            "south": min_lat,
            "north": max_lat,
            "west": min_lng,
            "east": max_lng,
        },
        "shardPrecision": GEOHASH_PRECISION,
        "shards": shards_meta,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser(description="从 inbox 分流并增量索引有 GPS 的照片")
    ap.add_argument("--inbox", type=Path, default=DEFAULT_INBOX, help="新图入口目录")
    ap.add_argument("--photos", type=Path, default=DEFAULT_PHOTOS, help="有 GPS 照片目录")
    ap.add_argument(
        "--no-gps",
        type=Path,
        default=DEFAULT_NO_GPS,
        help="无 GPS 归档目录（按文件名去重覆盖）",
    )
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--thumbs", type=Path, default=DEFAULT_THUMBS)
    ap.add_argument("--shards", type=Path, default=DEFAULT_SHARDS)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--force", action="store_true", help="忽略 mtime/size，全量重扫")
    args = ap.parse_args()

    args.inbox.mkdir(parents=True, exist_ok=True)
    args.photos.mkdir(parents=True, exist_ok=True)
    args.no_gps.mkdir(parents=True, exist_ok=True)

    print(f"入口 inbox: {args.inbox}")
    print(f"有定位 photos: {args.photos}")
    print(f"无定位 no-gps: {args.no_gps}")
    stats = index_photos(
        photos_dir=args.photos,
        db_path=args.db,
        thumbs_dir=args.thumbs,
        shards_dir=args.shards,
        manifest_path=args.manifest,
        force=args.force,
        inbox_dir=args.inbox,
        no_gps_dir=args.no_gps,
    )
    print(
        f"完成: inbox {stats.get('inbox', 0)} | 入 photos {stats.get('to_photos', 0)} | "
        f"入 no-gps {stats['moved']} | 索引更新 {stats['updated']} | "
        f"跳过 {stats['skipped']} | 有GPS {stats['with_gps']} | {stats['elapsed_s']}s"
    )
    print(f"清单: {args.manifest}")


if __name__ == "__main__":
    main()
