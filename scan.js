(function () {
  const title = document.getElementById("title");
  const subtitle = document.getElementById("subtitle");
  const fill = document.getElementById("fill");
  const pct = document.getElementById("pct");
  const fileText = document.getElementById("fileText");
  const btnStart = document.getElementById("btnStart");
  const btnForce = document.getElementById("btnForce");
  const btnMap = document.getElementById("btnMap");
  const hint = document.getElementById("hint");
  const panel = document.querySelector(".panel");

  const els = {
    scanned: document.getElementById("sScanned"),
    skipped: document.getElementById("sSkipped"),
    updated: document.getElementById("sUpdated"),
    moved: document.getElementById("sMoved"),
    removed: document.getElementById("sRemoved"),
    errors: document.getElementById("sErrors"),
    elapsed: document.getElementById("sElapsed"),
  };

  let pollTimer = null;

  const params = new URLSearchParams(location.search);
  const autoStart = params.get("auto") !== "0";
  const forceOnStart = params.get("force") === "1";

  function phaseLabel(phase, state) {
    if (state === "error") return "扫描失败";
    switch (phase) {
      case "inbox":
        return "① 分流 inbox";
      case "counting":
        return "② 统计 photos";
      case "running":
        return "② 索引 photos";
      case "cleanup":
        return "清理索引";
      case "exporting":
        return "导出地图数据";
      case "done":
        return "扫描完成";
      default:
        return state === "running" ? "正在扫描" : "准备扫描";
    }
  }

  function render(s) {
    const percent = Math.max(0, Math.min(100, Number(s.percent) || 0));
    fill.style.width = `${percent}%`;
    pct.textContent = `${percent.toFixed(percent >= 100 || percent === 0 ? 0 : 1)}%`;

    title.textContent = phaseLabel(s.phase, s.state);
    subtitle.textContent = s.message || "";

    if (s.currentFile) {
      fileText.textContent = s.currentFile;
    } else if (s.state === "done") {
      const gps = s.with_gps != null ? ` · 有定位 ${s.with_gps}` : "";
      const moved = s.moved ? ` · 移出无定位 ${s.moved}` : "";
      fileText.textContent = `完成${gps}${moved}`;
    } else if (s.state === "error") {
      fileText.textContent = s.error || s.message || "出错";
    } else {
      fileText.textContent =
        s.total > 0 ? `共 ${s.total} 张` : s.message || "等待开始…";
    }

    els.scanned.textContent = String(s.scanned ?? 0);
    els.skipped.textContent = String(s.skipped ?? 0);
    els.updated.textContent = String(s.updated ?? 0);
    if (els.moved) els.moved.textContent = String(s.moved ?? 0);
    els.removed.textContent = String(s.removed ?? 0);
    els.errors.textContent = String(s.errors ?? 0);
    els.elapsed.textContent = `${Number(s.elapsed_s || 0).toFixed(1)}s`;

    const running = s.state === "running";
    btnStart.disabled = running;
    btnForce.disabled = running;
    panel.classList.toggle("error", s.state === "error");

    if (s.state === "done") {
      hint.textContent = "扫描完成，点击「查看地图」进入。";
    } else if (s.state === "error") {
      hint.textContent = "扫描失败，可重试或检查 photos 目录与 Pillow 依赖。";
    }
  }

  async function fetchStatus() {
    const resp = await fetch("/api/index/status", { cache: "no-store" });
    if (!resp.ok) throw new Error("无法读取扫描状态（请确认使用 serve.py 启动）");
    return resp.json();
  }

  async function start(force) {
    hint.textContent = "扫描进行中，请勿关闭本页。";
    try {
      const resp = await fetch("/api/index/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 409) {
        render(data.status || (await fetchStatus()));
      } else if (!resp.ok) {
        throw new Error(data.error || `启动失败 (${resp.status})`);
      } else if (data.status) {
        render(data.status);
      }
      startPolling();
    } catch (err) {
      title.textContent = "无法启动扫描";
      subtitle.textContent = err.message || String(err);
      panel.classList.add("error");
      hint.innerHTML =
        "请用 <code>scan.bat</code> 或 <code>python scripts/serve.py</code> 启动，不要用纯 http.server。";
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const s = await fetchStatus();
        render(s);
        if (s.state === "done" || s.state === "error" || s.state === "idle") {
          // 保持轮询直到 done 后跳转；idle 且未跑也可以停
          if (s.state !== "running") {
            /* keep going until redirect for done */
          }
        }
      } catch (err) {
        subtitle.textContent = err.message || String(err);
      }
    }, 250);
  }

  const forceModal = document.getElementById("forceModal");
  const forceConfirm = document.getElementById("forceConfirm");
  const forceCancel = document.getElementById("forceCancel");

  function openForceModal() {
    forceModal.hidden = false;
    forceConfirm.focus();
  }

  function closeForceModal() {
    forceModal.hidden = true;
    btnForce.focus();
  }

  btnStart.addEventListener("click", () => start(false));
  btnForce.addEventListener("click", openForceModal);
  forceConfirm.addEventListener("click", () => {
    closeForceModal();
    start(true);
  });
  forceModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeForceModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !forceModal.hidden) closeForceModal();
  });

  (async function init() {
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const s = await fetchStatus();
        render(s);
        startPolling();
        if (s.state === "running") return;
        if (autoStart) {
          await start(forceOnStart);
        }
        return;
      } catch (err) {
        title.textContent = "连接服务中…";
        subtitle.textContent = `等待本地服务就绪（${i + 1}/${maxAttempts}）`;
        fileText.textContent = err.message || String(err);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    title.textContent = "服务未就绪";
    subtitle.textContent = "请用 scan.bat 或 python scripts/serve.py 启动";
    panel.classList.add("error");
    fileText.textContent = "";
    btnStart.disabled = true;
    btnForce.disabled = true;
  })();
})();
