(async function () {
  const loading = document.getElementById("loading");
  const loadingText = document.getElementById("loadingText");
  const statsText = document.getElementById("statsText");

  const viewMap = document.getElementById("view-map");
  const viewAlbum = document.getElementById("view-album");
  const viewTimeline = document.getElementById("view-timeline");
  const viewJourney = document.getElementById("view-journey");
  const viewPlaces = document.getElementById("view-places");
  const viewSlideshow = document.getElementById("view-slideshow");
  const albumGrid = document.getElementById("albumGrid");
  const albumEmpty = document.getElementById("albumEmpty");
  const timelineScroll = document.getElementById("timelineScroll");
  const timelineEmpty = document.getElementById("timelineEmpty");
  const journeySide = document.getElementById("journeySide");
  const journeyStrip = document.getElementById("journeyStrip");
  const placesSide = document.getElementById("placesSide");
  const placesGrid = document.getElementById("placesGrid");
  const placesEmpty = document.getElementById("placesEmpty");
  const placesHead = document.getElementById("placesHead");
  const placesBack = document.getElementById("placesBack");
  const placesTitle = document.getElementById("placesTitle");
  const placesCount = document.getElementById("placesCount");

  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbStage = document.getElementById("lbStage");
  const lbCaption = document.getElementById("lbCaption");
  const lbClose = document.getElementById("lbClose");
  const lbPrev = document.getElementById("lbPrev");
  const lbNext = document.getElementById("lbNext");
  const lbStrip = document.getElementById("lbStrip");

  const ssBg = document.getElementById("ssBg");
  const ssImgA = document.getElementById("ssImgA");
  const ssImgB = document.getElementById("ssImgB");
  const ssLayers = [ssImgA, ssImgB];
  let ssFront = 0;
  let ssSlideGen = 0;
  const ssPrev = document.getElementById("ssPrev");
  const ssNext = document.getElementById("ssNext");
  const ssToggle = document.getElementById("ssToggle");
  const ssCounter = document.getElementById("ssCounter");
  const ssCaption = document.getElementById("ssCaption");

  const FALLBACK_CENTER = [29.38, 111.26];
  const SLIDE_MS = 5000;
  const SLIDE_FADE_MS = 500; // 交叉淡入时长
  const PRELOAD_RADIUS = 3;
  /** @type {Map<string, HTMLImageElement>} */
  const preloaded = new Map();

  const loadedShards = new Set();
  const placedPhotos = new Set();
  /** @type {Array<{path:string,thumb?:string,lat?:number,lng?:number,takenAt?:string}>} */
  let allPhotos = [];
  const photoKey = (p) => p.path;

  let map = null;
  let cluster = null;
  let manifest = null;
  let photoCount = 0;
  let mode = "map";
  let albumBuilt = false;
  let timelineBuilt = false;
  let placesBuilt = false;
  let reflowHud = () => {};

  /** @type {Array<{key:string,label:string,photos:any[]}>} */
  let journeyDays = [];
  let journeyDayIndex = 0;
  let journeyMap = null;
  let journeyLayer = null;
  let journeyMarkers = [];
  let journeyAnim = 0;
  /** @type {Array<{marker:any,phase:number}>} */
  let journeyArrows = [];
  /** @type {any[]} */
  let journeyFlyLines = [];
  /** @type {Array<[number,number]>|null} */
  let journeyRouteLatLngs = null;

  /** @type {Array<{key:string,label:string,photos:any[],cover:any}>} */
  let placeAlbums = [];
  let activePlaceKey = null;

  let lbIndex = 0;
  let lbStripBuilt = false;

  let ssIndex = 0;
  let ssPlaying = false;
  let ssTimer = null;

  function hideLoading() {
    loading.classList.add("hidden");
    setTimeout(() => {
      loading.style.display = "none";
    }, 280);
  }

  function formatTakenAt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function photoLabel(photo) {
    return [photo.path.replace(/^photos\//, ""), formatTakenAt(photo.takenAt)]
      .filter(Boolean)
      .join(" · ");
  }

  function preloadAround(centerIndex) {
    const n = allPhotos.length;
    if (!n) return;
    const keep = new Set();
    for (let d = -PRELOAD_RADIUS; d <= PRELOAD_RADIUS; d++) {
      const i = ((centerIndex + d) % n + n) % n;
      const url = allPhotos[i].path;
      keep.add(url);
      if (preloaded.has(url)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      preloaded.set(url, img);
    }
    for (const url of [...preloaded.keys()]) {
      if (!keep.has(url)) preloaded.delete(url);
    }
  }

  async function ensureDecoded(url) {
    let img = preloaded.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = url;
      preloaded.set(url, img);
    }
    if (!img.complete) {
      await new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }
    if (typeof img.decode === "function") {
      try {
        await img.decode();
      } catch (_) {}
    }
    return img;
  }

  function setStats() {
    if (!manifest) return;
    const n = allPhotos.length;
    if (mode === "map") {
      statsText.textContent =
        `地图 ${photoCount} 张 · 共 ${manifest.withGps} 张有定位` +
        (manifest.withoutGps ? ` · ${manifest.withoutGps} 张无 GPS` : "");
    } else if (mode === "album") {
      statsText.textContent = `相册 ${n} 张`;
    } else if (mode === "timeline") {
      statsText.textContent = `时间线 ${n} 张`;
    } else if (mode === "journey") {
      statsText.textContent = `旅程 ${journeyDays.length} 天 · ${n} 张`;
    } else if (mode === "places") {
      statsText.textContent = `地点 ${placeAlbums.length} 个 · ${n} 张`;
    } else {
      statsText.textContent = ssPlaying ? `幻灯片播放中 · ${n} 张` : `幻灯片已暂停 · ${n} 张`;
    }
    reflowHud();
  }

  function sortPhotos(list) {
    return list.slice().sort((a, b) => {
      const ta = a.takenAt || "";
      const tb = b.takenAt || "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  }

  function mergePhotos(photos) {
    const mapByKey = new Map(allPhotos.map((p) => [photoKey(p), p]));
    let added = 0;
    for (const photo of photos) {
      const key = photoKey(photo);
      if (mapByKey.has(key)) continue;
      mapByKey.set(key, photo);
      added += 1;
    }
    if (added) {
      allPhotos = sortPhotos([...mapByKey.values()]);
      albumBuilt = false;
      timelineBuilt = false;
      placesBuilt = false;
      lbStripBuilt = false;
    }
  }

  // ---- Lightbox (album / map) ----------------------------------------------
  function buildLbStrip() {
    lbStrip.innerHTML = "";
    allPhotos.forEach((photo, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lb-thumb";
      btn.style.backgroundImage = `url("${photo.thumb || photo.path}")`;
      btn.title = photo.path.replace(/^photos\//, "");
      btn.addEventListener("click", () => showLightbox(i));
      lbStrip.appendChild(btn);
    });
    lbStripBuilt = true;
  }

  function showLightbox(index) {
    if (!allPhotos.length) return;
    lbIndex = ((index % allPhotos.length) + allPhotos.length) % allPhotos.length;
    const photo = allPhotos[lbIndex];
    if (!lbStripBuilt) buildLbStrip();

    lbImg.src = photo.path;
    lbCaption.textContent = `${lbIndex + 1} / ${allPhotos.length} · ${photoLabel(photo)}`;
    lightbox.hidden = false;
    preloadAround(lbIndex);

    const thumbs = lbStrip.children;
    for (let i = 0; i < thumbs.length; i++) {
      thumbs[i].classList.toggle("active", i === lbIndex);
    }
    const active = thumbs[lbIndex];
    if (active) {
      active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lbImg.removeAttribute("src");
  }

  function lbStep(delta) {
    showLightbox(lbIndex + delta);
  }

  lbClose.addEventListener("click", closeLightbox);
  lbPrev.addEventListener("click", () => lbStep(-1));
  lbNext.addEventListener("click", () => lbStep(1));
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox || e.target === lbStage) closeLightbox();
  });

  // swipe on lightbox stage
  let touchX = null;
  lbStage.addEventListener(
    "touchstart",
    (e) => {
      touchX = e.changedTouches[0].clientX;
    },
    { passive: true }
  );
  lbStage.addEventListener(
    "touchend",
    (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) < 50) return;
      lbStep(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );

  // ---- Album ---------------------------------------------------------------
  function buildAlbum() {
    albumGrid.innerHTML = "";
    if (!allPhotos.length) {
      albumEmpty.hidden = false;
      albumBuilt = true;
      return;
    }
    albumEmpty.hidden = true;
    const frag = document.createDocumentFragment();
    allPhotos.forEach((photo, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "album-item";
      btn.style.backgroundImage = `url("${photo.thumb || photo.path}")`;
      btn.title = photoLabel(photo);
      btn.addEventListener("click", () => showLightbox(i));
      frag.appendChild(btn);
    });
    albumGrid.appendChild(frag);
    albumBuilt = true;
  }

  function openPhotoLightbox(photo) {
    const idx = allPhotos.findIndex((p) => photoKey(p) === photoKey(photo));
    if (idx >= 0) showLightbox(idx);
  }

  function dayKey(iso) {
    if (!iso) return "未知日期";
    return iso.slice(0, 10);
  }

  function formatDayTitle(key) {
    if (key === "未知日期") return key;
    const [y, m, d] = key.split("-");
    return `${y}年${Number(m)}月${Number(d)}日`;
  }

  function weekdayLabel(key) {
    if (key === "未知日期") return "";
    const d = new Date(`${key}T12:00:00`);
    if (Number.isNaN(d.getTime())) return "";
    return ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  }

  // ---- Timeline ------------------------------------------------------------
  function buildTimeline() {
    timelineScroll.innerHTML = "";
    if (!allPhotos.length) {
      timelineEmpty.hidden = false;
      timelineBuilt = true;
      return;
    }
    timelineEmpty.hidden = true;

    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const photo of allPhotos) {
      const k = dayKey(photo.takenAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(photo);
    }
    const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const frag = document.createDocumentFragment();
    for (const key of days) {
      const photos = byDay.get(key);
      const section = document.createElement("section");
      section.className = "tl-day";
      const head = document.createElement("div");
      head.className = "tl-day-head";
      const wd = weekdayLabel(key);
      head.innerHTML = `<span class="tl-date">${formatDayTitle(key)}${wd ? ` · 周${wd}` : ""}</span><span class="tl-meta">${photos.length} 张</span>`;
      const row = document.createElement("div");
      row.className = "tl-row";
      photos.forEach((photo) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tl-item";
        btn.style.backgroundImage = `url("${photo.thumb || photo.path}")`;
        btn.title = photoLabel(photo);
        btn.addEventListener("click", () => openPhotoLightbox(photo));
        row.appendChild(btn);
      });
      section.appendChild(head);
      section.appendChild(row);
      frag.appendChild(section);
    }
    timelineScroll.appendChild(frag);
    timelineBuilt = true;
  }

  // ---- Journey -------------------------------------------------------------
  function buildJourneyDays() {
    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const photo of allPhotos) {
      if (photo.lat == null || photo.lng == null) continue;
      const k = dayKey(photo.takenAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(photo);
    }
    journeyDays = [...byDay.entries()]
      .map(([key, photos]) => ({
        key,
        label: formatDayTitle(key),
        photos: sortPhotos(photos),
      }))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }

  function ensureJourneyMap() {
    if (journeyMap) return;
    journeyMap = L.map("journeyMap", {
      zoomControl: true,
      attributionControl: true,
    }).setView(FALLBACK_CENTER, 11);
    L.tileLayer(
      "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      {
        subdomains: ["1", "2", "3", "4"],
        maxZoom: 18,
        attribution: "&copy; 高德地图",
      }
    ).addTo(journeyMap);
    journeyLayer = L.layerGroup().addTo(journeyMap);
    journeyMap.on("zoomend", () => {
      if (mode === "journey" && journeyRouteLatLngs?.length >= 2) {
        rebuildJourneyFlyLinesOnly();
      }
    });
  }

  function renderJourneySide() {
    journeySide.innerHTML = "";
    const title = document.createElement("div");
    title.className = "jn-side-title";
    title.textContent = "按日旅程";
    journeySide.appendChild(title);
    if (!journeyDays.length) {
      const empty = document.createElement("p");
      empty.className = "jn-empty";
      empty.textContent = "暂无带定位的日程";
      journeySide.appendChild(empty);
      return;
    }
    journeyDays.forEach((day, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "jn-day" + (i === journeyDayIndex ? " active" : "");
      const cover = day.photos[0];
      btn.innerHTML = `<span class="jn-day-cover" style="background-image:url('${cover.thumb || cover.path}')"></span><span class="jn-day-text"><strong>${day.label}</strong><span>${day.photos.length} 张 · 周${weekdayLabel(day.key) || "—"}</span></span>`;
      btn.addEventListener("click", () => selectJourneyDay(i));
      journeySide.appendChild(btn);
    });
  }

  function selectJourneyDay(index) {
    if (!journeyDays.length) return;
    journeyDayIndex = Math.max(0, Math.min(journeyDays.length - 1, index));
    renderJourneySide();
    renderJourneyMap();
    renderJourneyStrip();
    setStats();
  }

  function clearJourneyFlow() {
    if (journeyAnim) {
      cancelAnimationFrame(journeyAnim);
      journeyAnim = 0;
    }
    journeyArrows.forEach((a) => {
      try {
        journeyLayer?.removeLayer(a.marker);
      } catch (_) {}
    });
    journeyArrows = [];
    journeyFlyLines.forEach((line) => {
      try {
        journeyLayer?.removeLayer(line);
      } catch (_) {}
    });
    journeyFlyLines = [];
  }

  function journeyBearing(a, b) {
    const toRad = Math.PI / 180;
    const lat1 = a.lat * toRad;
    const lat2 = b.lat * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** 屏幕空间二次贝塞尔飞线（迁徙图弧度） */
  function journeyArcPoints(aLL, bLL, segments = 36) {
    const a = L.latLng(aLL);
    const b = L.latLng(bLL);
    const p1 = journeyMap.latLngToLayerPoint(a);
    const p2 = journeyMap.latLngToLayerPoint(b);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    // 弧高：短距也有弧，长距有上限，接近高德飞线
    const bulge = Math.max(18, Math.min(120, len * 0.28));
    const cx = mx - (dy / len) * bulge;
    const cy = my + (dx / len) * bulge;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = 1 - t;
      const x = u * u * p1.x + 2 * u * t * cx + t * t * p2.x;
      const y = u * u * p1.y + 2 * u * t * cy + t * t * p2.y;
      pts.push(journeyMap.layerPointToLatLng(L.point(x, y)));
    }
    return pts;
  }

  function buildJourneyCurvedPath(stops) {
    /** @type {L.LatLng[]} */
    const curved = [];
    for (let i = 1; i < stops.length; i++) {
      const arc = journeyArcPoints(stops[i - 1], stops[i], 40);
      if (i > 1) arc.shift(); // 去重接点
      curved.push(...arc);
    }
    return curved;
  }

  function journeyPathLength(latlngs) {
    let total = 0;
    for (let i = 1; i < latlngs.length; i++) {
      total += L.latLng(latlngs[i - 1]).distanceTo(L.latLng(latlngs[i]));
    }
    return total;
  }

  function journeyPointAlong(latlngs, distM) {
    let left = distM;
    for (let i = 1; i < latlngs.length; i++) {
      const a = L.latLng(latlngs[i - 1]);
      const b = L.latLng(latlngs[i]);
      const seg = a.distanceTo(b);
      if (left <= seg || i === latlngs.length - 1) {
        const t = seg > 0 ? Math.min(1, left / seg) : 0;
        return {
          latlng: L.latLng(
            a.lat + (b.lat - a.lat) * t,
            a.lng + (b.lng - a.lng) * t
          ),
          bearing: journeyBearing(a, b),
        };
      }
      left -= seg;
    }
    const last = L.latLng(latlngs[latlngs.length - 1]);
    const prev = L.latLng(latlngs[latlngs.length - 2] || latlngs[0]);
    return { latlng: last, bearing: journeyBearing(prev, last) };
  }

  function rebuildJourneyFlyLinesOnly() {
    if (!journeyRouteLatLngs || journeyRouteLatLngs.length < 2 || !journeyMap) return;
    // 只重建飞线与箭头，保留照片 marker
    journeyFlyLines.forEach((line) => {
      try {
        journeyLayer.removeLayer(line);
      } catch (_) {}
    });
    journeyFlyLines = [];
    journeyArrows.forEach((a) => {
      try {
        journeyLayer.removeLayer(a.marker);
      } catch (_) {}
    });
    journeyArrows = [];
    if (journeyAnim) {
      cancelAnimationFrame(journeyAnim);
      journeyAnim = 0;
    }
    startJourneyFlyLines(journeyRouteLatLngs);
  }

  function startJourneyFlyLines(stops) {
    if (!journeyMap || stops.length < 2) return;
    journeyRouteLatLngs = stops.map((p) => [p[0], p[1]]);
    const curved = buildJourneyCurvedPath(journeyRouteLatLngs);
    if (curved.length < 2) return;

    // 2px 飞线，颜色与箭头一致（青蓝），带轻柔光
    const arrowColor = "#7aecff";
    const n = curved.length - 1;
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      const aLine = 0.95 * (1 - t * 0.35);
      const aGlow = 0.35 * (1 - t * 0.45);

      const glow = L.polyline([curved[i], curved[i + 1]], {
        color: arrowColor,
        weight: 4,
        opacity: Math.max(0.08, aGlow),
        className: "jn-fly-glow",
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(journeyLayer);

      const core = L.polyline([curved[i], curved[i + 1]], {
        color: arrowColor,
        weight: 2,
        opacity: Math.max(0.45, aLine),
        className: "jn-fly-core",
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(journeyLayer);

      journeyFlyLines.push(glow, core);
    }

    const total = journeyPathLength(curved);
    if (total < 1) return;

    const count = Math.max(3, Math.min(12, Math.round(total / 500) + 2));
    for (let i = 0; i < count; i++) {
      const icon = L.divIcon({
        className: "jn-arrow",
        html: '<div class="jn-arrow-inner"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><polyline points="3,2 9,6 3,10" fill="none" stroke="#e8ffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const marker = L.marker(curved[0], {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 400,
      }).addTo(journeyLayer);
      journeyArrows.push({ marker, phase: i / count });
    }

    for (let i = 0; i < Math.min(5, count); i++) {
      const icon = L.divIcon({
        className: "jn-spark",
        html: '<div class="jn-spark-inner"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      });
      const marker = L.marker(curved[0], {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 350,
      }).addTo(journeyLayer);
      journeyArrows.push({ marker, phase: (i + 0.35) / count, spark: true });
    }

    const t0 = performance.now();
    const speed = 0.035;
    function frame(now) {
      const t = ((now - t0) / 1000) * speed;
      journeyArrows.forEach((a) => {
        const u = (a.phase + t) % 1;
        const pt = journeyPointAlong(curved, u * total);
        a.marker.setLatLng(pt.latlng);
        if (!a.spark) {
          const el = a.marker.getElement()?.querySelector(".jn-arrow-inner");
          if (el) el.style.transform = `rotate(${pt.bearing - 90}deg)`;
        }
      });
      journeyAnim = requestAnimationFrame(frame);
    }
    journeyAnim = requestAnimationFrame(frame);
  }

  function renderJourneyMap() {
    ensureJourneyMap();
    clearJourneyFlow();
    journeyLayer.clearLayers();
    journeyMarkers = [];
    journeyRouteLatLngs = null;
    const day = journeyDays[journeyDayIndex];
    if (!day) return;
    const latlngs = day.photos.map((p) => [p.lat, p.lng]);
    if (latlngs.length >= 2) {
      startJourneyFlyLines(latlngs);
    }
    day.photos.forEach((photo, i) => {
      const icon = L.divIcon({
        className: "jn-pin",
        html: `<div class="jn-pin-ring"></div><div class="jn-pin-core" style="background-image:url('${photo.thumb || photo.path}')"></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
      const marker = L.marker([photo.lat, photo.lng], { icon });
      marker.on("click", () => {
        openPhotoLightbox(photo);
        highlightJourneyStrip(i);
      });
      marker.addTo(journeyLayer);
      journeyMarkers.push(marker);
    });
    if (latlngs.length === 1) {
      journeyMap.setView(latlngs[0], 14);
    } else if (latlngs.length > 1) {
      journeyMap.fitBounds(latlngs, { padding: [48, 48], maxZoom: 15 });
    }
    setTimeout(() => {
      journeyMap.invalidateSize();
      if (latlngs.length >= 2) rebuildJourneyFlyLinesOnly();
    }, 80);
  }

  function highlightJourneyStrip(index) {
    journeyStrip.querySelectorAll(".jn-strip-item").forEach((el, i) => {
      el.classList.toggle("active", i === index);
    });
  }

  function renderJourneyStrip() {
    journeyStrip.innerHTML = "";
    const day = journeyDays[journeyDayIndex];
    if (!day) return;
    day.photos.forEach((photo, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "jn-strip-item";
      btn.style.backgroundImage = `url("${photo.thumb || photo.path}")`;
      btn.title = photoLabel(photo);
      btn.addEventListener("click", () => {
        openPhotoLightbox(photo);
        highlightJourneyStrip(i);
        if (journeyMarkers[i]) {
          journeyMap.panTo(journeyMarkers[i].getLatLng());
        }
      });
      journeyStrip.appendChild(btn);
    });
  }

  function buildJourney() {
    buildJourneyDays();
    ensureJourneyMap();
    journeyDayIndex = 0;
    renderJourneySide();
    selectJourneyDay(0);
  }

  // ---- Places --------------------------------------------------------------
  let placeResolveGen = 0;

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function placeCellKey(photo) {
    const lat = Math.round(Number(photo.lat) * 20) / 20; // ~5.5km
    const lng = Math.round(Number(photo.lng) * 20) / 20;
    return `${lat.toFixed(2)},${lng.toFixed(2)}`;
  }

  function placeMetaLine(album) {
    const bits = [];
    if (album.address && album.address !== album.label) bits.push(album.address);
    bits.push(`${album.photos.length} 张`);
    return bits.join(" · ");
  }

  function buildPlaceAlbums() {
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const photo of allPhotos) {
      if (photo.lat == null || photo.lng == null) continue;
      const k = placeCellKey(photo);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(photo);
    }
    placeAlbums = [...groups.entries()]
      .map(([key, photos]) => {
        const sorted = sortPhotos(photos);
        const [lat, lng] = key.split(",").map(Number);
        return {
          key,
          lat,
          lng,
          label: `地点 ${lat.toFixed(2)}°, ${lng.toFixed(2)}°`,
          address: "",
          resolved: false,
          photos: sorted,
          cover: sorted[Math.floor(sorted.length / 2)] || sorted[0],
        };
      })
      .sort((a, b) => b.photos.length - a.photos.length);
  }

  function refreshPlacesLabels() {
    if (!placesBuilt) return;
    renderPlacesList();
    if (activePlaceKey) {
      const album = placeAlbums.find((a) => a.key === activePlaceKey);
      if (album) {
        placesTitle.textContent = album.label;
        placesCount.textContent = placeMetaLine(album);
      }
    } else {
      placesGrid.querySelectorAll(".album-item[data-place-key]").forEach((el) => {
        const album = placeAlbums.find((a) => a.key === el.dataset.placeKey);
        if (album) el.title = `${album.label} · ${placeMetaLine(album)}`;
      });
    }
  }

  async function resolvePlaceLabels() {
    const gen = ++placeResolveGen;
    for (const album of placeAlbums) {
      if (gen !== placeResolveGen) return;
      if (album.resolved) continue;
      try {
        const res = await fetch(
          `/api/geocode/reverse?lat=${encodeURIComponent(album.lat)}&lng=${encodeURIComponent(album.lng)}`
        );
        if (!res.ok) continue;
        const data = await res.json();
        if (gen !== placeResolveGen) return;
        if (data.label) album.label = data.label;
        if (data.address) album.address = data.address;
        album.resolved = Boolean(data.ok || data.label);
        refreshPlacesLabels();
      } catch {
        /* 保持坐标占位 */
      }
    }
  }

  function renderPlacesList() {
    placesSide.innerHTML = "";
    const title = document.createElement("div");
    title.className = "pl-side-title";
    title.textContent = "地点相册";
    placesSide.appendChild(title);
    if (!placeAlbums.length) {
      placesEmpty.hidden = false;
      placesGrid.innerHTML = "";
      placesHead.hidden = true;
      return;
    }
    placesEmpty.hidden = true;
    placeAlbums.forEach((album) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pl-card" + (album.key === activePlaceKey ? " active" : "");
      btn.innerHTML = `<span class="pl-card-cover" style="background-image:url('${album.cover.thumb || album.cover.path}')"></span><span class="pl-card-text"><strong>${escapeHtml(album.label)}</strong><span>${escapeHtml(placeMetaLine(album))}</span></span>`;
      btn.addEventListener("click", () => openPlaceAlbum(album.key));
      placesSide.appendChild(btn);
    });
  }

  function openPlaceAlbum(key) {
    const album = placeAlbums.find((a) => a.key === key);
    if (!album) return;
    activePlaceKey = key;
    renderPlacesList();
    placesHead.hidden = false;
    placesTitle.textContent = album.label;
    placesCount.textContent = placeMetaLine(album);
    placesGrid.innerHTML = "";
    const frag = document.createDocumentFragment();
    album.photos.forEach((photo) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "album-item";
      btn.style.backgroundImage = `url("${photo.thumb || photo.path}")`;
      btn.title = photoLabel(photo);
      btn.addEventListener("click", () => openPhotoLightbox(photo));
      frag.appendChild(btn);
    });
    placesGrid.appendChild(frag);
    placesEmpty.hidden = true;
  }

  function showPlacesOverview() {
    activePlaceKey = null;
    placesHead.hidden = true;
    placesGrid.innerHTML = "";
    renderPlacesList();
    if (!placeAlbums.length) {
      placesEmpty.hidden = false;
      placesEmpty.textContent = "暂无地点相册";
    } else {
      placesEmpty.hidden = true;
      const frag = document.createDocumentFragment();
      placeAlbums.forEach((album) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "album-item";
        btn.dataset.placeKey = album.key;
        btn.style.backgroundImage = `url("${album.cover.thumb || album.cover.path}")`;
        btn.title = `${album.label} · ${placeMetaLine(album)}`;
        btn.addEventListener("click", () => openPlaceAlbum(album.key));
        frag.appendChild(btn);
      });
      placesGrid.appendChild(frag);
    }
  }

  function buildPlaces() {
    buildPlaceAlbums();
    showPlacesOverview();
    placesBuilt = true;
    resolvePlaceLabels();
  }

  placesBack?.addEventListener("click", () => showPlacesOverview());

  // ---- Slideshow -----------------------------------------------------------
  function clearSsTimer() {
    if (ssTimer) {
      clearInterval(ssTimer);
      ssTimer = null;
    }
  }

  async function showSlide(index, { animate = true } = {}) {
    if (!allPhotos.length) {
      ssLayers.forEach((el) => {
        el.removeAttribute("src");
        el.classList.remove("is-shown");
        el.style.opacity = "0";
      });
      ssBg.style.backgroundImage = "";
      ssCounter.textContent = "0 / 0";
      ssCaption.textContent = "";
      return;
    }

    ssIndex = ((index % allPhotos.length) + allPhotos.length) % allPhotos.length;
    const photo = allPhotos[ssIndex];
    const url = photo.path;
    const gen = ++ssSlideGen;
    preloadAround(ssIndex);

    ssCounter.textContent = `${ssIndex + 1} / ${allPhotos.length}`;
    ssCaption.textContent = photoLabel(photo);

    await ensureDecoded(url);
    if (gen !== ssSlideGen) return;

    const next = 1 - ssFront;
    const incoming = ssLayers[next];
    const outgoing = ssLayers[ssFront];
    const hasOutgoing = !!(outgoing && outgoing.getAttribute("src"));

    // 背景用缩略图，避免再解一次大图造成卡顿
    ssBg.style.backgroundImage = `url("${photo.thumb || url}")`;

    if (!animate || !hasOutgoing) {
      incoming.style.transition = "none";
      incoming.src = url;
      incoming.classList.add("is-shown");
      incoming.style.opacity = "1";
      outgoing.classList.remove("is-shown");
      outgoing.style.opacity = "0";
      void incoming.offsetWidth;
      incoming.style.transition = "";
      ssFront = next;
      return;
    }

    // 双缓冲交叉淡入：新图从 0.1 → 1，旧图 1 → 0
    incoming.style.transition = "none";
    incoming.src = url;
    incoming.classList.add("is-shown");
    incoming.style.opacity = "0.1";
    void incoming.offsetWidth;
    incoming.style.transition = "";

    requestAnimationFrame(() => {
      if (gen !== ssSlideGen) return;
      incoming.style.opacity = "1";
      outgoing.style.opacity = "0";
    });

    ssFront = next;
    setTimeout(() => {
      if (gen !== ssSlideGen) return;
      outgoing.classList.remove("is-shown");
      // 清掉隐藏层 src 可省一点显存；保留也没关系，这里清掉避免叠太多解码图
      // outgoing.removeAttribute("src");
    }, SLIDE_FADE_MS + 40);
  }

  function ssStep(delta) {
    showSlide(ssIndex + delta);
    if (ssPlaying) restartSsTimer();
  }

  function restartSsTimer() {
    clearSsTimer();
    ssTimer = setInterval(() => {
      showSlide(ssIndex + 1);
    }, SLIDE_MS);
  }

  function setSsPlaying(on) {
    ssPlaying = on;
    ssToggle.textContent = on ? "暂停" : "播放";
    if (on) restartSsTimer();
    else clearSsTimer();
    // 暂停/继续幻灯片时同步音乐（用户手动关过音乐则不自动开）
    if (on) {
      if (!musicUserPaused) setMusicPlaying(true);
    } else {
      setMusicPlaying(false);
    }
    setStats();
  }

  function startSlideshow() {
    if (!allPhotos.length) return;
    showSlide(ssIndex, { animate: false });
    setSsPlaying(true);
  }

  function stopSlideshow() {
    setSsPlaying(false);
  }

  ssPrev.addEventListener("click", () => ssStep(-1));
  ssNext.addEventListener("click", () => ssStep(1));
  ssToggle.addEventListener("click", () => setSsPlaying(!ssPlaying));

  // ---- 黑胶 + 音频视觉特效（光晕/粒子/呼吸/波形） ---------------------------
  const ssPlayer = document.getElementById("ssPlayer");
  const ssAudio = document.getElementById("ssAudio");
  const ssAura = document.getElementById("ssAura");
  const ssFxPanel = document.getElementById("ssFxPanel");
  let musicOn = false;
  let musicUserPaused = false;

  const FX_KEY = "geo-photos-ss-fx-v2";
  const fxEnabled = { aura: true, particles: false, breathe: false, wave: false };
  try {
    const saved = JSON.parse(localStorage.getItem(FX_KEY) || "null");
    if (saved && typeof saved === "object") Object.assign(fxEnabled, saved);
  } catch (_) {}

  let audioCtx = null;
  let audioAnalyser = null;
  let audioFreq = null;
  let audioWave = null;
  let auraRaf = 0;
  let auraSmooth = { bass: 0, mid: 0, treble: 0, energy: 0 };
  let auraT = 0;
  let prevBass = 0;
  /** @type {Array<any>} */
  let particles = [];
  let particleCounts = { orbit: 0, ember: 0, burst: 0 };
  const PARTICLE_MAX = 520;
  const ORBIT_WANT = 52;
  /** @type {HTMLCanvasElement | null} */
  let breatheOff = null;

  function clearParticles() {
    particles.length = 0;
    particleCounts = { orbit: 0, ember: 0, burst: 0 };
  }

  function syncFxButtons() {
    ssFxPanel?.querySelectorAll(".ss-fx-btn").forEach((btn) => {
      const key = btn.dataset.fx;
      btn.classList.toggle("active", !!fxEnabled[key]);
    });
  }
  syncFxButtons();

  ssFxPanel?.addEventListener("click", (e) => {
    const btn = e.target.closest(".ss-fx-btn");
    if (!btn) return;
    e.stopPropagation();
    const key = btn.dataset.fx;
    if (!(key in fxEnabled)) return;
    fxEnabled[key] = !fxEnabled[key];
    try {
      localStorage.setItem(FX_KEY, JSON.stringify(fxEnabled));
    } catch (_) {}
    syncFxButtons();
    if (!fxEnabled.particles) clearParticles();
  });

  function ensureAudioGraph() {
    if (!ssAudio || audioAnalyser) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    const src = audioCtx.createMediaElementSource(ssAudio);
    audioAnalyser = audioCtx.createAnalyser();
    audioAnalyser.fftSize = 1024;
    audioAnalyser.smoothingTimeConstant = 0.78;
    src.connect(audioAnalyser);
    audioAnalyser.connect(audioCtx.destination);
    audioFreq = new Uint8Array(audioAnalyser.frequencyBinCount);
    audioWave = new Uint8Array(audioAnalyser.fftSize);
  }

  function resizeAuraCanvas() {
    if (!ssAura) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = ssAura.clientWidth;
    const h = ssAura.clientHeight;
    if (!w || !h) return;
    const tw = Math.floor(w * dpr);
    const th = Math.floor(h * dpr);
    if (ssAura.width !== tw || ssAura.height !== th) {
      ssAura.width = tw;
      ssAura.height = th;
    }
    return { w, h, dpr };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 沿矩形周长取点；pad>0 外扩，pad<0 内缩。带外法线/切线 */
  function pointOnRectRim(rect, t, pad = 6) {
    const pw = rect.w + pad * 2;
    const ph = rect.h + pad * 2;
    const ox = rect.x - pad;
    const oy = rect.y - pad;
    if (pw <= 0 || ph <= 0) {
      return { x: rect.cx || rect.x, y: rect.cy || rect.y, nx: 0, ny: -1, tx: 1, ty: 0 };
    }
    const peri = 2 * (pw + ph);
    let d = (((t % 1) + 1) % 1) * peri;
    if (d < pw) return { x: ox + d, y: oy, nx: 0, ny: -1, tx: 1, ty: 0 };
    d -= pw;
    if (d < ph) return { x: ox + pw, y: oy + d, nx: 1, ny: 0, tx: 0, ty: 1 };
    d -= ph;
    if (d < pw) return { x: ox + pw - d, y: oy + ph, nx: 0, ny: 1, tx: -1, ty: 0 };
    d -= pw;
    return { x: ox, y: oy + ph - d, nx: -1, ny: 0, tx: 0, ty: -1 };
  }

  function spawnRimBurst(rect, strength) {
    if (!rect) return;
    const room = PARTICLE_MAX - particles.length;
    if (room <= 0) return;
    const count = Math.min(room, Math.floor(28 + strength * 56));
    for (let i = 0; i < count; i++) {
      const inset = 4 + Math.random() * 16;
      const rim = pointOnRectRim(rect, Math.random(), -inset);
      const sp = 2.8 + Math.random() * 7.5 * (0.45 + strength);
      const spread = (Math.random() - 0.5) * 0.9;
      const ox = -rim.nx;
      const oy = -rim.ny;
      const nx = ox * Math.cos(spread) + rim.tx * Math.sin(spread);
      const ny = oy * Math.cos(spread) + rim.ty * Math.sin(spread);
      particles.push({
        kind: "burst",
        x: rim.x,
        y: rim.y,
        px: rim.x,
        py: rim.y,
        vx: nx * sp,
        vy: ny * sp,
        life: 1,
        max: 0.5 + Math.random() * 0.45,
        hue: (auraT * 60 + Math.random() * 200) | 0,
        size: 1.6 + Math.random() * 3.2 * (0.55 + strength),
      });
      particleCounts.burst++;
    }
  }

  function ensureOrbitSwarm() {
    while (particleCounts.orbit < ORBIT_WANT && particles.length < PARTICLE_MAX) {
      particles.push({
        kind: "orbit",
        t: Math.random(),
        speed: 0.00028 + Math.random() * 0.00048,
        inset: 8 + Math.random() * 26,
        wobble: Math.random() * Math.PI * 2,
        hue: (180 + Math.random() * 160) | 0,
        size: 1.3 + Math.random() * 2.1,
      });
      particleCounts.orbit++;
    }
  }

  function spawnEmbers(rect) {
    if (!rect || auraSmooth.energy < 0.12) return;
    if (particleCounts.ember >= 48 || particles.length >= PARTICLE_MAX) return;
    if (Math.random() > 0.35 + auraSmooth.mid * 0.4) return;
    const room = Math.min(
      1 + ((auraSmooth.energy * 3) | 0),
      PARTICLE_MAX - particles.length
    );
    for (let i = 0; i < room; i++) {
      const t =
        Math.random() < 0.65 ? 0.35 + Math.random() * 0.3 : Math.random();
      const edge = pointOnRectRim(rect, t, -(6 + Math.random() * 14));
      particles.push({
        kind: "ember",
        x: edge.x,
        y: edge.y,
        px: edge.x,
        py: edge.y,
        vx: (Math.random() - 0.5) * 0.7,
        vy: -0.7 - Math.random() * 1.5 - auraSmooth.bass * 0.8,
        life: 1,
        max: 1.0 + Math.random() * 1.0,
        hue: (40 + Math.random() * 80 + auraT * 40) | 0,
        size: 1 + Math.random() * 2,
      });
      particleCounts.ember++;
    }
  }

  function removeParticleAt(i) {
    const p = particles[i];
    if (p.kind === "orbit") particleCounts.orbit--;
    else if (p.kind === "ember") particleCounts.ember--;
    else particleCounts.burst--;
    const last = particles.pop();
    if (i < particles.length) particles[i] = last;
  }

  function drawParticles(ctx, _w, _h, rect) {
    if (!rect) return;
    ensureOrbitSwarm();
    spawnEmbers(rect);

    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = 0;
    ctx.lineCap = "round";

    const energyA = 0.4 + auraSmooth.energy * 0.45;
    const bassBoost = auraSmooth.bass;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];

      if (p.kind === "orbit") {
        p.t += p.speed * (0.7 + auraSmooth.energy * 1.8);
        p.wobble += 0.04;
        const inset =
          p.inset + Math.sin(p.wobble) * 4 + bassBoost * 8;
        const rim = pointOnRectRim(rect, p.t, -Math.max(4, inset));
        let x = rim.x;
        let y = rim.y;
        if (bassBoost > 0.45) {
          x -= rim.nx * bassBoost * 8;
          y -= rim.ny * bassBoost * 8;
        }
        p.hue = (p.hue + 0.35 + auraSmooth.treble * 1.2) % 360;
        const r = p.size * (0.75 + bassBoost * 0.45);
        ctx.fillStyle = `hsla(${p.hue | 0}, 95%, 72%, ${energyA})`;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        continue;
      }

      p.px = p.x;
      p.py = p.y;
      p.x += p.vx;
      p.y += p.vy;
      if (p.kind === "ember") {
        p.vx *= 0.99;
        p.vy *= 0.995;
        p.vy -= 0.012;
      } else {
        p.vx *= 0.978;
        p.vy *= 0.978;
      }
      p.life -= 0.016 / p.max;
      if (p.life <= 0) {
        removeParticleAt(i);
        continue;
      }

      const alpha = p.life * 0.95;
      const r = p.size * (0.55 + p.life * 0.7);
      // 短拖尾：一条线，不做多段 path
      ctx.strokeStyle = `hsla(${p.hue}, 95%, 68%, ${alpha * 0.4})`;
      ctx.lineWidth = Math.max(1, r * 0.9);
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = `hsla(${p.hue}, 95%, 72%, ${alpha})`;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }

  function drawAuraEdges(ctx, w, h, colors) {
    const energy = auraSmooth.energy;
    const bass = auraSmooth.bass;
    const mid = auraSmooth.mid;
    const maxH = 60;
    const rise = Math.min(maxH, 28 + bass * 22 + energy * 14);
    const amp = Math.min(10, 3 + energy * 5 + auraSmooth.treble * 3);

    function ridgeY(t, phase) {
      return (
        h -
        6 -
        Math.sin(t * Math.PI) * rise * 0.35 -
        Math.sin(t * Math.PI * 2.2 + auraT * 1.8 + phase) * amp -
        Math.sin(t * Math.PI * 5.5 + auraT * 2.6 + phase * 1.3) * amp * 0.35 -
        bass * 4
      );
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = 0;

    // 1) 底部大面积柔光底（纵向淡出 + 横向色相渐变）
    const baseGrad = ctx.createLinearGradient(0, h - rise * 1.15, 0, h);
    baseGrad.addColorStop(0, "rgba(0,0,0,0)");
    baseGrad.addColorStop(
      0.45,
      colors[1].replace("alpha", String(0.08 + energy * 0.12))
    );
    baseGrad.addColorStop(
      0.78,
      colors[2].replace("alpha", String(0.16 + bass * 0.22))
    );
    baseGrad.addColorStop(
      1,
      colors[0].replace("alpha", String(0.1 + mid * 0.12))
    );

    const hueFlow = ctx.createLinearGradient(0, 0, w, 0);
    const shift = (auraT * 0.08) % 1;
    const hueStops = [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
      const c = colors[i % colors.length];
      return [(t + shift) % 1, c];
    });
    hueStops.sort((a, b) => a[0] - b[0]);
    if (hueStops[0][0] > 0) {
      hueFlow.addColorStop(0, hueStops[hueStops.length - 1][1].replace("alpha", "0.2"));
    }
    hueStops.forEach(([t, c]) => {
      hueFlow.addColorStop(
        Math.min(0.999, Math.max(0, t)),
        c.replace("alpha", String(0.18 + energy * 0.25))
      );
    });
    hueFlow.addColorStop(1, hueStops[0][1].replace("alpha", "0.2"));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, h + 2);
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = t * w;
      const y = ridgeY(t, 0);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h + 2);
    ctx.closePath();
    ctx.clip();

    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, h - rise * 1.2, w, rise * 1.3);

    ctx.globalAlpha = 0.55 + energy * 0.25;
    ctx.fillStyle = hueFlow;
    ctx.fillRect(0, h - rise * 0.95, w, rise);
    ctx.globalAlpha = 1;

    // 2) 多层极光绸带：上下透明渐变，随音乐起伏
    function drawRibbon(phase, yLift, height, alphaScale, hueIdx) {
      const top = [];
      const bot = [];
      const thickMax = Math.min(28, Math.max(8, height));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = t * w;
        const y = ridgeY(t, phase) - yLift;
        const thick =
          thickMax *
          (0.5 + 0.5 * Math.sin(t * Math.PI)) *
          (0.75 + bass * 0.45);
        top.push([x, y - thick * 0.55]);
        bot.push([x, y + thick * 0.55]);
      }

      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
      for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
      ctx.closePath();

      const midY = ridgeY(0.5, phase) - yLift;
      const rg = ctx.createLinearGradient(0, midY - thickMax, 0, midY + thickMax);
      const cA = colors[hueIdx % colors.length];
      const cB = colors[(hueIdx + 1) % colors.length];
      const cC = colors[(hueIdx + 2) % colors.length];
      const a = (0.16 + energy * 0.28) * alphaScale;
      rg.addColorStop(0, "rgba(0,0,0,0)");
      rg.addColorStop(0.28, cA.replace("alpha", String(a * 0.45)));
      rg.addColorStop(0.5, cB.replace("alpha", String(a)));
      rg.addColorStop(0.72, cC.replace("alpha", String(a * 0.5)));
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.fill();

      // 横向流色，增强绸带感（重新建路径再 clip）
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
      for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
      ctx.closePath();
      const hg = ctx.createLinearGradient(0, 0, w, 0);
      hg.addColorStop(0, cA.replace("alpha", String(a * 0.2)));
      hg.addColorStop(0.35, cB.replace("alpha", String(a * 0.45)));
      hg.addColorStop(0.7, cC.replace("alpha", String(a * 0.4)));
      hg.addColorStop(1, cA.replace("alpha", String(a * 0.2)));
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = hg;
      ctx.fillRect(0, midY - thickMax - 8, w, thickMax * 2 + 16);
      ctx.restore();
    }

    drawRibbon(0.2, 2, 11 + bass * 7, 1.0, 0);
    drawRibbon(1.1, 6, 9 + mid * 6, 0.8, 2);
    drawRibbon(2.0, -2, 8 + energy * 5, 0.65, 1);
    // 再加 3 条起伏渐变绸带
    drawRibbon(2.7, 14, 14 + bass * 9, 1.0, 3);
    drawRibbon(3.5, -8, 12 + mid * 8, 0.9, 1);
    drawRibbon(4.3, 20, 11 + energy * 7, 0.8, 2);

    // 3) 底部脉冲柔光团（鼓点呼吸）
    const blobs = [
      [0.2, colors[0]],
      [0.5, colors[1]],
      [0.78, colors[2]],
    ];
    blobs.forEach(([tx, col], i) => {
      const x = w * tx + Math.sin(auraT * 1.4 + i * 2) * 18;
      const y = h - 4;
      const r = Math.min(maxH, 28 + bass * 28 + Math.sin(auraT * 2.2 + i) * 6 + energy * 12);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(
        0,
        col.replace("alpha", String(0.22 + bass * 0.35))
      );
      g.addColorStop(
        0.45,
        col.replace("alpha", String(0.08 + energy * 0.12))
      );
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  function drawWaveform(ctx, w, h) {
    if (!audioWave || !audioAnalyser) return;
    audioAnalyser.getByteTimeDomainData(audioWave);

    const span = w * 0.5; // 50vw
    const left = (w - span) / 2;
    const maxBh = 50;
    // 振幅到底：最大时下尖贴屏幕底（距底 0px）
    const midY = h - maxBh;
    const amp = Math.min(maxBh, 18 + auraSmooth.energy * 32);

    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = 0;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 色块区：相对波浪线两端各内缩 5px，避免端头竖条
    const barPad = 5;
    const barSpan = Math.max(0, span - barPad * 2);
    const barLeft = left + barPad;
    const barPx = 2;
    const bars = Math.max(1, Math.floor(barSpan / barPx));
    const hw = barPx / 2;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * audioFreq.length * 0.7);
      const v = (audioFreq[idx] || 0) / 255;
      const bh = Math.max(4, Math.min(maxBh, v * maxBh));
      const cx = barLeft + i * barPx + hw;
      const hue = (i / bars) * 360;
      const g = ctx.createLinearGradient(cx, midY - bh, cx, midY + bh);
      g.addColorStop(0, `hsla(${hue}, 95%, 70%, 0)`);
      g.addColorStop(0.22, `hsla(${hue}, 95%, 68%, ${0.18 + v * 0.28})`);
      g.addColorStop(0.5, `hsla(${(hue + 30) % 360}, 92%, 72%, ${0.42 + v * 0.45})`);
      g.addColorStop(0.78, `hsla(${hue}, 95%, 68%, ${0.18 + v * 0.28})`);
      g.addColorStop(1, `hsla(${hue}, 90%, 70%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx, midY - bh);
      ctx.lineTo(cx + hw, midY);
      ctx.lineTo(cx, midY + bh);
      ctx.lineTo(cx - hw, midY);
      ctx.closePath();
      ctx.fill();
    }

    function strokeWave(alpha, width) {
      ctx.beginPath();
      for (let i = 0; i < audioWave.length; i++) {
        const t = i / (audioWave.length - 1);
        const x = left + t * span;
        const v = (audioWave[i] - 128) / 128;
        const y = midY + v * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `hsla(${(auraT * 40) % 360}, 90%, 78%, ${alpha})`;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    strokeWave(0.5, 1.6);
    strokeWave(0.2, 3.5);
  }

  function drawBreatheRim(ctx, w, h) {
    if (!fxEnabled.breathe || !musicOn) return;

    const pulse = auraSmooth.bass * 0.7 + auraSmooth.energy * 0.3;
    const cycle = 0.5 + 0.5 * Math.sin(auraT * 1.55);
    // 向中心「吸气」推进的厚度（保持原效果的 30% 宽度）
    const depth = (26 + cycle * 34 + pulse * 42) * 0.3;
    const alpha = (0.5 + pulse * 0.4 + cycle * 0.12) * 0.5;
    const hueShift = auraT * 55;

    if (!breatheOff || breatheOff.width !== Math.ceil(w) || breatheOff.height !== Math.ceil(h)) {
      breatheOff = document.createElement("canvas");
      breatheOff.width = Math.max(1, Math.ceil(w));
      breatheOff.height = Math.max(1, Math.ceil(h));
    }
    const o = breatheOff.getContext("2d");
    if (!o) return;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.hypot(cx, cy) + 2;

    // 整屏锥形七彩（高饱和），后续挖空中心 → 无四角接缝
    const wedges = 64;
    for (let i = 0; i < wedges; i++) {
      const a0 = (i / wedges) * Math.PI * 2 - Math.PI * 0.5;
      const a1 = ((i + 1.05) / wedges) * Math.PI * 2 - Math.PI * 0.5;
      const hue = (i / wedges) * 360 + hueShift;
      o.fillStyle = `hsla(${hue % 360}, 98%, 56%, 1)`;
      o.beginPath();
      o.moveTo(cx, cy);
      o.arc(cx, cy, R, a0, a1);
      o.closePath();
      o.fill();
    }

    // 柔边挖空中心：只留屏幕四周光环，角自然一体
    o.globalCompositeOperation = "destination-out";
    const blur = Math.max(2, depth * 0.45);
    o.filter = `blur(${blur}px)`;
    o.fillStyle = "#000";
    const inset = Math.max(2, depth * 0.75);
    const rr = Math.min(12, inset * 0.6);
    o.beginPath();
    if (typeof o.roundRect === "function") {
      o.roundRect(inset, inset, w - inset * 2, h - inset * 2, rr);
    } else {
      o.rect(inset, inset, w - inset * 2, h - inset * 2);
    }
    o.fill();
    o.filter = "none";
    o.globalCompositeOperation = "source-over";

    // 叠到主画布：轻微再模糊 + 呼吸透明度
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    ctx.filter = `blur(${2 + pulse * 4}px)`;
    ctx.drawImage(breatheOff, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFxFrame() {
    if (!ssAura) return;
    const size = resizeAuraCanvas();
    if (!size) return;
    const { w, h, dpr } = size;
    const ctx = ssAura.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!musicOn || !audioAnalyser || !audioFreq) {
      return;
    }

    audioAnalyser.getByteFrequencyData(audioFreq);
    const n = audioFreq.length;
    let bass = 0;
    let mid = 0;
    let treble = 0;
    const bEnd = Math.floor(n * 0.12);
    const mEnd = Math.floor(n * 0.45);
    for (let i = 0; i < n; i++) {
      const v = audioFreq[i] / 255;
      if (i < bEnd) bass += v;
      else if (i < mEnd) mid += v;
      else treble += v;
    }
    bass /= Math.max(1, bEnd);
    mid /= Math.max(1, mEnd - bEnd);
    treble /= Math.max(1, n - mEnd);
    const energy = bass * 0.5 + mid * 0.32 + treble * 0.18;

    auraSmooth.bass = lerp(auraSmooth.bass, bass, 0.18);
    auraSmooth.mid = lerp(auraSmooth.mid, mid, 0.16);
    auraSmooth.treble = lerp(auraSmooth.treble, treble, 0.14);
    auraSmooth.energy = lerp(auraSmooth.energy, energy, 0.15);
    auraT += 0.016 + auraSmooth.energy * 0.04;

    // 鼓点 → 屏幕四边向内炸开
    const spike = bass - prevBass;
    const screenRect = { x: 0, y: 0, w, h, cx: w / 2, cy: h / 2 };
    if (fxEnabled.particles && spike > 0.11 && bass > 0.32) {
      spawnRimBurst(screenRect, Math.min(1, bass + spike));
    }
    prevBass = bass;

    const hueShift = auraT * 40 + auraSmooth.treble * 80;
    const colors = [
      `hsla(${(195 + hueShift) % 360}, 95%, 65%, alpha)`,
      `hsla(${(280 + hueShift * 0.7) % 360}, 90%, 68%, alpha)`,
      `hsla(${(330 + hueShift * 0.5) % 360}, 95%, 70%, alpha)`,
      `hsla(${(160 + hueShift * 0.3) % 360}, 85%, 60%, alpha)`,
    ];

    if (fxEnabled.aura) drawAuraEdges(ctx, w, h, colors);
    if (fxEnabled.breathe) drawBreatheRim(ctx, w, h);
    if (fxEnabled.wave) drawWaveform(ctx, w, h);
    if (fxEnabled.particles) drawParticles(ctx, w, h, screenRect);

    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
  }

  function fxLoop() {
    auraRaf = requestAnimationFrame(fxLoop);
    drawFxFrame();
  }

  function startAura() {
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    ssAura?.classList.add("is-on");
    if (!auraRaf) fxLoop();
  }

  function stopAura() {
    ssAura?.classList.remove("is-on");
    if (auraRaf) {
      cancelAnimationFrame(auraRaf);
      auraRaf = 0;
    }
    if (ssAura) {
      const ctx = ssAura.getContext("2d");
      ctx && ctx.clearRect(0, 0, ssAura.width, ssAura.height);
    }
    clearParticles();
    prevBass = 0;
    auraSmooth = { bass: 0, mid: 0, treble: 0, energy: 0 };
  }

  function setMusicPlaying(on) {
    musicOn = !!on;
    ssPlayer?.classList.toggle("is-playing", musicOn);
    if (!ssAudio) return;
    if (musicOn) {
      ensureAudioGraph();
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      const p = ssAudio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          console.warn("无法播放 static/music/1.mp3，请放入背景音乐文件");
        });
      }
      startAura();
    } else {
      ssAudio.pause();
      stopAura();
    }
  }

  ssPlayer?.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !musicOn;
    musicUserPaused = !next;
    setMusicPlaying(next);
  });

  window.addEventListener("resize", () => {
    if (musicOn) resizeAuraCanvas();
  });

  // ---- Map -----------------------------------------------------------------
  function photoIcon(photo) {
    const src = photo.thumb || photo.path;
    const safe = String(src).replace(/'/g, "%27").replace(/"/g, "%22");
    return L.divIcon({
      className: "photo-marker",
      html: `<div class="photo-pin" style="background-image:url('${safe}')"></div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -22],
    });
  }

  function clusterIcon(clusterGroup) {
    const n = clusterGroup.getChildCount();
    let size = "small";
    if (n >= 100) size = "large";
    else if (n >= 10) size = "";
    return L.divIcon({
      html: `<div class="cluster-bubble ${size}">${n}</div>`,
      className: "marker-cluster-custom",
      iconSize: L.point(48, 48),
    });
  }

  function ensureMap(center, zoom) {
    if (map) return;
    map = L.map("map", {
      zoomControl: true,
      attributionControl: true,
    }).setView(center, zoom);

    L.tileLayer(
      "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      {
        subdomains: ["1", "2", "3", "4"],
        maxZoom: 18,
        attribution: "&copy; 高德地图",
      }
    ).addTo(map);

    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 56,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(cluster);

    map.on("moveend", () => {
      loadVisibleShards().catch((err) => console.warn("加载分片失败", err));
    });
  }

  function boundsIntersect(a, b) {
    return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
  }

  function mapBoundsPad() {
    const b = map.getBounds().pad(0.35);
    return {
      south: b.getSouth(),
      north: b.getNorth(),
      west: b.getWest(),
      east: b.getEast(),
    };
  }

  function addMapMarkers(photos) {
    if (!cluster) return;
    const markers = [];
    for (const photo of photos) {
      if (photo.lat == null || photo.lng == null) continue;
      const key = photoKey(photo);
      if (placedPhotos.has(key)) continue;
      placedPhotos.add(key);

      const marker = L.marker([photo.lat, photo.lng], {
        icon: photoIcon(photo),
        keyboard: false,
      });
      marker.on("click", () => {
        const idx = allPhotos.findIndex((p) => photoKey(p) === key);
        showLightbox(idx >= 0 ? idx : 0);
      });
      markers.push(marker);
      photoCount += 1;
    }
    if (markers.length) cluster.addLayers(markers);
    setStats();
  }

  async function loadShard(shard) {
    if (loadedShards.has(shard.id)) return;
    loadedShards.add(shard.id);
    const resp = await fetch(`${shard.file}?_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`分片 ${shard.id} 加载失败 (${resp.status})`);
    const data = await resp.json();
    const photos = data.photos || [];
    mergePhotos(photos);
    addMapMarkers(photos);
  }

  async function loadVisibleShards() {
    if (!manifest?.shards?.length || !map) return;
    const view = mapBoundsPad();
    const needed = manifest.shards.filter((s) => boundsIntersect(view, s.bounds));
    const targets =
      manifest.shards.length <= 24 || needed.length === 0
        ? manifest.shards
        : needed;
    await Promise.all(
      targets.filter((s) => !loadedShards.has(s.id)).map((s) => loadShard(s))
    );
  }

  async function loadAllShards() {
    if (!manifest?.shards?.length) return;
    await Promise.all(
      manifest.shards.filter((s) => !loadedShards.has(s.id)).map((s) => loadShard(s))
    );
  }

  function fitToManifest() {
    const b = manifest.bounds;
    if (!b) {
      map.setView(FALLBACK_CENTER, 12);
      return;
    }
    map.fitBounds(
      [
        [b.south, b.west],
        [b.north, b.east],
      ],
      { padding: [40, 40], maxZoom: 14 }
    );
  }

  // ---- Mode switch ---------------------------------------------------------
  function setMode(next) {
    if (next === mode && document.body.classList.contains(`mode-${next}`)) {
      return;
    }
    const prev = mode;
    mode = next;

    document.body.classList.remove(
      "mode-map",
      "mode-album",
      "mode-timeline",
      "mode-journey",
      "mode-places",
      "mode-slideshow"
    );
    document.body.classList.add(`mode-${mode}`);

    viewMap.hidden = mode !== "map";
    viewAlbum.hidden = mode !== "album";
    viewTimeline.hidden = mode !== "timeline";
    viewJourney.hidden = mode !== "journey";
    viewPlaces.hidden = mode !== "places";
    viewSlideshow.hidden = mode !== "slideshow";

    document.querySelectorAll(".mode-btn").forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });

    if (prev === "slideshow" && mode !== "slideshow") stopSlideshow();
    if (prev === "journey" && mode !== "journey") clearJourneyFlow();
    if (mode === "slideshow") closeLightbox();

    if (mode === "map" && map) {
      setTimeout(() => map.invalidateSize(), 50);
    }
    if (mode === "album") {
      if (!albumBuilt) buildAlbum();
    }
    if (mode === "timeline") {
      if (!timelineBuilt) buildTimeline();
    }
    if (mode === "journey") {
      buildJourney();
    }
    if (mode === "places") {
      if (!placesBuilt) buildPlaces();
      else showPlacesOverview();
    }
    if (mode === "slideshow") {
      closeLightbox();
      startSlideshow();
    }

    setStats();
    reflowHud();
  }

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  // ---- HUD 拖拽 + 吸边收起 -----------------------------------------------
  (function enableHudDrag() {
    const hud = document.getElementById("hud");
    const hudTab = document.getElementById("hudTab");
    if (!hud) return;

    const MARGIN = 14;
    const SNAP = 36;
    const DOCK_GAP = 0;
    const STORE_KEY = "geo-photos-hud-pos-v3";

    /** @type {'left'|'right'} */
    let xAnchor = "right";
    /** @type {'top'|'bottom'} */
    let yAnchor = "top";
    let edgeX = MARGIN;
    let edgeY = MARGIN;
    let docked = false;
    /** @type {'left'|'right'|'top'|'bottom'|null} */
    let dockSide = null;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let suppressClick = false;
    let startedOnTab = false;

    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }

    function syncDockClass() {
      hud.classList.toggle("docked", docked);
      hud.classList.remove("dock-left", "dock-right", "dock-top", "dock-bottom");
      if (docked && dockSide) hud.classList.add(`dock-${dockSide}`);
    }

    function applyAnchored() {
      syncDockClass();

      const w = hud.offsetWidth;
      const h = hud.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (docked && dockSide) {
        if (dockSide === "right") {
          hud.style.left = "auto";
          hud.style.right = `${DOCK_GAP}px`;
          hud.style.bottom = "auto";
          const t = clamp(edgeY, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
          edgeY = t;
          yAnchor = "top";
          hud.style.top = `${Math.round(t)}px`;
          xAnchor = "right";
          edgeX = DOCK_GAP;
        } else if (dockSide === "left") {
          hud.style.right = "auto";
          hud.style.left = `${DOCK_GAP}px`;
          hud.style.bottom = "auto";
          const t = clamp(edgeY, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
          edgeY = t;
          yAnchor = "top";
          hud.style.top = `${Math.round(t)}px`;
          xAnchor = "left";
          edgeX = DOCK_GAP;
        } else if (dockSide === "top") {
          hud.style.bottom = "auto";
          hud.style.top = `${DOCK_GAP}px`;
          hud.style.right = "auto";
          const l = clamp(edgeX, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
          edgeX = l;
          xAnchor = "left";
          hud.style.left = `${Math.round(l)}px`;
          yAnchor = "top";
          edgeY = DOCK_GAP;
        } else if (dockSide === "bottom") {
          hud.style.top = "auto";
          hud.style.bottom = `${DOCK_GAP}px`;
          hud.style.right = "auto";
          const l = clamp(edgeX, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
          edgeX = l;
          xAnchor = "left";
          hud.style.left = `${Math.round(l)}px`;
          yAnchor = "bottom";
          edgeY = DOCK_GAP;
        }
        return;
      }

      const maxRight = Math.max(MARGIN, vw - w - MARGIN);
      const maxBottom = Math.max(MARGIN, vh - h - MARGIN);

      if (xAnchor === "right") {
        const r = clamp(edgeX, MARGIN, maxRight);
        edgeX = r;
        hud.style.left = "auto";
        hud.style.right = `${Math.round(r)}px`;
      } else {
        const l = clamp(edgeX, MARGIN, maxRight);
        edgeX = l;
        hud.style.right = "auto";
        hud.style.left = `${Math.round(l)}px`;
      }

      if (yAnchor === "bottom") {
        const b = clamp(edgeY, MARGIN, maxBottom);
        edgeY = b;
        hud.style.top = "auto";
        hud.style.bottom = `${Math.round(b)}px`;
      } else {
        const t = clamp(edgeY, MARGIN, maxBottom);
        edgeY = t;
        hud.style.bottom = "auto";
        hud.style.top = `${Math.round(t)}px`;
      }
    }

    function expandFromDock() {
      if (!docked) return;
      const side = dockSide;
      docked = false;
      dockSide = null;
      if (side === "right") {
        xAnchor = "right";
        edgeX = MARGIN;
        yAnchor = "top";
      } else if (side === "left") {
        xAnchor = "left";
        edgeX = MARGIN;
        yAnchor = "top";
      } else if (side === "top") {
        yAnchor = "top";
        edgeY = MARGIN;
      } else if (side === "bottom") {
        yAnchor = "bottom";
        edgeY = MARGIN;
      }
      applyAnchored();
      savePos();
    }

    function placeByLeftTop(left, top, { snap = false } = {}) {
      const w = hud.offsetWidth;
      const h = hud.offsetHeight;
      const maxL = window.innerWidth - w - MARGIN;
      const maxT = window.innerHeight - h - MARGIN;
      let l = clamp(left, 0, Math.max(0, window.innerWidth - w));
      let t = clamp(top, 0, Math.max(0, window.innerHeight - h));

      if (!snap) {
        hud.style.left = `${Math.round(l)}px`;
        hud.style.top = `${Math.round(t)}px`;
        hud.style.right = "auto";
        hud.style.bottom = "auto";
        return;
      }

      // 贴边距离（贴到 0）
      const dL = l;
      const dR = window.innerWidth - (l + w);
      const dT = t;
      const dB = window.innerHeight - (t + h);
      const nearest = Math.min(dL, dR, dT, dB);

      if (nearest <= SNAP) {
        docked = true;
        if (nearest === dR) {
          dockSide = "right";
          edgeY = t;
        } else if (nearest === dL) {
          dockSide = "left";
          edgeY = t;
        } else if (nearest === dT) {
          dockSide = "top";
          edgeX = l;
        } else {
          dockSide = "bottom";
          edgeX = l;
        }
        // 先切到 docked 尺寸再定位
        syncDockClass();
        requestAnimationFrame(() => {
          applyAnchored();
          savePos();
        });
        return;
      }

      docked = false;
      dockSide = null;
      l = clamp(l, MARGIN, Math.max(MARGIN, maxL));
      t = clamp(t, MARGIN, Math.max(MARGIN, maxT));
      const distL = l - MARGIN;
      const distR = Math.max(MARGIN, maxL) - l;
      xAnchor = distR <= distL ? "right" : "left";
      edgeX = xAnchor === "right" ? distR + MARGIN : l;
      const distT = t - MARGIN;
      const distB = Math.max(MARGIN, maxT) - t;
      yAnchor = distB < distT ? "bottom" : "top";
      edgeY = yAnchor === "bottom" ? distB + MARGIN : t;
      applyAnchored();
    }

    function savePos() {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({ xAnchor, yAnchor, edgeX, edgeY, docked, dockSide })
        );
      } catch (_) {}
    }

    function restorePos() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) {
          xAnchor = "right";
          yAnchor = "top";
          edgeX = MARGIN;
          edgeY = MARGIN;
          docked = false;
          dockSide = null;
          applyAnchored();
          return;
        }
        const pos = JSON.parse(raw);
        if (pos?.xAnchor === "left" || pos?.xAnchor === "right") xAnchor = pos.xAnchor;
        if (pos?.yAnchor === "top" || pos?.yAnchor === "bottom") yAnchor = pos.yAnchor;
        if (Number.isFinite(pos.edgeX)) edgeX = pos.edgeX;
        if (Number.isFinite(pos.edgeY)) edgeY = pos.edgeY;
        docked = !!pos.docked;
        dockSide = ["left", "right", "top", "bottom"].includes(pos.dockSide)
          ? pos.dockSide
          : null;
        if (docked && !dockSide) docked = false;
        applyAnchored();
      } catch (_) {
        applyAnchored();
      }
    }

    function onPointerDown(e) {
      if (e.button != null && e.button !== 0) return;
      startedOnTab = !!e.target.closest(".hud-tab");
      // 展开态：链接 / 模式按钮不拖
      if (!docked && e.target.closest("a, .mode-btn")) return;

      const rect = hud.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      hud.classList.add("dragging");

      // 从吸边拖出时先展开成完整面板再拖
      if (docked) {
        docked = false;
        dockSide = null;
        syncDockClass();
        const r2 = hud.getBoundingClientRect();
        origLeft = r2.left;
        origTop = r2.top;
      }

      hud.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && dx * dx + dy * dy > 9) moved = true;
      placeByLeftTop(origLeft + dx, origTop + dy, { snap: false });
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      hud.classList.remove("dragging");
      try {
        hud.releasePointerCapture?.(e.pointerId);
      } catch (_) {}

      if (moved) {
        const rect = hud.getBoundingClientRect();
        placeByLeftTop(rect.left, rect.top, { snap: true });
        savePos();
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
      } else if (startedOnTab) {
        // 单击吸边触发条 → 展开
        expandFromDock();
      }
    }

    hud.addEventListener("pointerdown", onPointerDown);
    hud.addEventListener("pointermove", onPointerMove);
    hud.addEventListener("pointerup", onPointerUp);
    hud.addEventListener("pointercancel", onPointerUp);
    hud.addEventListener(
      "click",
      (e) => {
        if (suppressClick) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    window.addEventListener("resize", () => {
      applyAnchored();
      savePos();
    });

    reflowHud = () => {
      requestAnimationFrame(applyAnchored);
    };

    restorePos();
  })();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!lightbox.hidden) {
        closeLightbox();
        return;
      }
    }

    if (!lightbox.hidden) {
      if (e.key === "ArrowLeft") lbStep(-1);
      if (e.key === "ArrowRight") lbStep(1);
      return;
    }

    if (mode === "slideshow") {
      if (e.key === "ArrowLeft") ssStep(-1);
      if (e.key === "ArrowRight") ssStep(1);
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        setSsPlaying(!ssPlaying);
      }
    }
  });

  // ---- Boot ----------------------------------------------------------------
  async function main() {
    try {
      loadingText.textContent = "正在加载索引…";
      const resp = await fetch(`data/manifest.json?_=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) {
        throw new Error(
          "找不到 data/manifest.json。请先运行扫描：打开 /scan.html"
        );
      }
      manifest = await resp.json();

      const b = manifest.bounds;
      const center = b
        ? [(b.south + b.north) / 2, (b.west + b.east) / 2]
        : FALLBACK_CENTER;
      ensureMap(center, 11);
      fitToManifest();

      loadingText.textContent = "正在加载照片…";
      await loadAllShards();
      setStats();

      if (!manifest.withGps) {
        statsText.textContent = "索引中没有带 GPS 的照片";
      }
    } catch (err) {
      console.error(err);
      loadingText.textContent = err.message || String(err);
      statsText.textContent = "加载失败";
      return;
    }
    hideLoading();
  }

  main();
})();
