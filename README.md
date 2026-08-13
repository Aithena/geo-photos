# Geo Photos — 本地相册地图（类苹果相册地图视图）

纯前端静态站：用脚本增量扫描本地照片 EXIF GPS，写入 SQLite，导出分片 JSON + 缩略图，浏览器用 Leaflet 聚合展示。

## 快速开始

```bash
pip install -r requirements.txt
python scripts/serve.py --port 18809
```

或双击 `scan.bat`：启动服务并打开**扫描进度界面**，完成后可选择进入地图。

- 扫描页：http://127.0.0.1:18809/scan.html
- 地图：http://127.0.0.1:18809/

> 需要用 `scripts/serve.py`（不要用纯 `http.server`），扫描 API 才可用。

也可命令行直接索引（无界面）：

```bash
python scripts/index_photos.py
```
## 目录

| 路径 | 说明 |
|------|------|
| `inbox/` | **新图入口**：下载的图片先放这里 |
| `photos/` | 有 GPS，供地图 / 相册 / 幻灯片使用 |
| `no-gps/` | 无 GPS 归档（按文件名去重覆盖） |
| `scripts/index_photos.py` | 分流 + 增量索引 |
| `scripts/serve.py` | 静态站 + `/api/index/*` 扫描 API |
| `scan.html` | 扫描进度界面 |
| `data/photos.db` | SQLite 真相源（增量靠 mtime+size） |
| `data/manifest.json` | 前端入口清单 |
| `data/shards/*.json` | 按 geohash 分片的点位数据 |
| `thumbs/` | 地图用小缩略图 |
| `static/imgs/` | 幻灯片黑胶播放器素材 |
| `static/music/1.mp3` | 背景音乐（自行放入） |
| `index.html` / `app.js` | Leaflet + 高德瓦片 + 聚合 |

## 增量逻辑

新图放入 `inbox/`，再运行扫描：

1. **inbox/** 分流：有 GPS → `photos/`；无 GPS → `no-gps/`（文件名去重覆盖）
2. **photos/** 增量索引进地图（mtime+size 未变则跳过）
3. `photos/` 里若仍有无 GPS，也会迁到 `no-gps/`

全量强制重扫：

```bash
python scripts/index_photos.py --force
```
## 换云盘目录

```bash
python scripts/index_photos.py --photos "D:/你的云盘/相册"
```

导出的 `path` 仍以仓库内可访问的相对 URL 为准时，建议：

- 把云盘目录**同步/联接**到本仓库的 `photos/`，或
- 用目录联接（junction / symlink）指向云盘路径

这样前端仍能通过 `/photos/...` 加载原图。

## 地图

复用高德公共瓦片（与 `kys-therapist-map` 相同），无需单独 key。
