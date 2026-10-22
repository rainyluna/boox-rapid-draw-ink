const { Plugin, Notice } = require("obsidian");

// ink-onyx-bridge v0.2: SAFE design.
// It never blocks pen input. Excalidraw draws its own (ugly) stroke as usual;
// when the Onyx stroke for the same pen-down arrives over ws://127.0.0.1:8765,
// the ugly freedraw element(s) are swapped for one built from Onyx points.
// If anything fails, you simply keep Excalidraw's normal stroke.

class InkOnyxBridgePlugin extends Plugin {
  onload() {
    this.enabled = true;
    this.ws = null;
    this.retry = 1000;
    this.deltas = [];
    this.stats = { rx: 0, swapped: 0, noMatch: 0, errors: 0, lastErr: null, log: [] };
    this.addCommand({
      id: "toggle",
      name: "Toggle Onyx pen bridge",
      callback: () => {
        this.enabled = !this.enabled;
        new Notice("Onyx bridge " + (this.enabled ? "ON" : "OFF"));
      },
    });
    this.connect();
    this.watchKeyboard();

    // Auto-reload active Excalidraw view if modified externally (e.g. by LiveSync from laptop/phone)
    this.registerEvent(this.app.vault.on("modify", async (file) => {
      const ex = this.app.plugins.plugins["obsidian-excalidraw-plugin"];
      const v = ex?.activeExcalidrawView;
      if (!v || v.file?.path !== file.path) return;
      if (Date.now() - (v.lastSaveTimestamp || 0) < 1500) return; // ignore our own saves
      try {
        const data = await this.app.vault.read(file);
        const ed = new (ex.excalidrawConfig?.ExcalidrawData || Object.getPrototypeOf(v.excalidrawData).constructor)(ex);
        await ed.loadData(data, file, 0);
        v.synchronizeWithData(ed);
        ed.destroy?.();
      } catch (err) {
        // fallback
        v.reload?.(true, file);
      }
    }));

    // Palm rejection: drop TOUCH pointers (never pen) on the Excalidraw canvas while the pen
    // is hovering/drawing or was used in the last PALM_MS, or when the contact is palm-sized.
    this.palmGuard = true;
    this.lastPen = 0;
    const PALM_MS = 1500;
    this.addCommand({
      id: "toggle-palm",
      name: "Toggle palm rejection",
      callback: () => { this.palmGuard = !this.palmGuard; new Notice("Palm rejection " + (this.palmGuard ? "ON" : "OFF")); },
    });
    const penSeen = (e) => { if (e.pointerType === "pen") this.lastPen = Date.now(); };
    for (const t of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"])
      this.registerDomEvent(window, t, penSeen, { capture: true, passive: true });
    const onCanvas = (e) => e.target && e.target.closest && e.target.closest(".excalidraw");
    const isPalm = (e) => {
      if (!this.palmGuard || e.pointerType !== "touch" || !onCanvas(e)) return false;
      const big = (e.width || 0) > 40 || (e.height || 0) > 40;
      return big || Date.now() - this.lastPen < PALM_MS;
    };
    const blockedIds = new Set();
    const guard = (e) => {
      try {
        if (e.type === "pointerdown" ? isPalm(e) : blockedIds.has(e.pointerId)) {
          if (e.type === "pointerdown") {
            blockedIds.add(e.pointerId);
            this.stats.palm = (this.stats.palm || 0) + 1;
            this.stats.lastPalm = { w: e.width, h: e.height, sincePen: Date.now() - this.lastPen };
          }
          if (e.type === "pointerup" || e.type === "pointercancel") blockedIds.delete(e.pointerId);
          e.stopImmediatePropagation();
          if (e.cancelable) e.preventDefault();
        }
      } catch (err) { this.stats.errors++; this.stats.lastErr = String(err); }
    };
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      this.registerDomEvent(window, t, guard, { capture: true });
    // Also stop palm touch* events (gesture/pinch handlers) while the pen is active.
    const touchGuard = (e) => {
      if (!this.palmGuard || !onCanvas(e)) return;
      // Never block stylus-derived touch events (Chrome fires them for the pen too).
      for (const t of e.changedTouches || []) if (t.touchType === "stylus") return;
      if (Date.now() - this.lastPen < PALM_MS) {
        this.stats.palmTouch = (this.stats.palmTouch || 0) + 1;
        e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault();
      }
    };
    for (const t of ["touchstart", "touchmove"])
      this.registerDomEvent(window, t, touchGuard, { capture: true, passive: false });

    // debug: record what switches Excalidraw to the eraser
    this.registerDomEvent(window, "pointerdown", (e) => {
      if (e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2))) {
        this.stats.eraserBtn = (this.stats.eraserBtn || 0) + 1;
        this.stats.lastEraserEvt = { button: e.button, buttons: e.buttons, t: Date.now() };
      }
    }, true);
  }

  onunload() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) {} }
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket("ws://127.0.0.1:8765"); } catch (e) { return this.later(); }
    this.ws = ws;
    ws.onopen = () => { this.retry = 1000; this.paused = undefined; if (this.kbUpdate) this.kbUpdate(); };
    ws.onmessage = (ev) => {
      if (!this.enabled) return;
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.type === "stroke" && Array.isArray(data.pts) && data.pts.length > 1) {
        this.stats.rx++;
        // let Excalidraw finish its own stroke (pointerup) first
        setTimeout(() => this.safe(() => this.onStroke(data)), 150);
      }
    };
    ws.onclose = () => { this.ws = null; this.later(); };
    ws.onerror = () => {};
  }

  later() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 15000);
  }

  safe(fn) {
    const t0 = performance.now();
    try { fn(); } catch (e) {
      this.stats.errors++; this.stats.lastErr = String((e && e.stack) || e).slice(0, 400);
      if (this.stats.errors > 20) { this.enabled = false; new Notice("Onyx bridge disabled after errors"); }
    }
    const dt = performance.now() - t0;
    if (dt > 250) { this.enabled = false; new Notice("Onyx bridge disabled (too slow: " + Math.round(dt) + " ms)"); }
  }

  excalidraw() {
    const ex = this.app.plugins.plugins["obsidian-excalidraw-plugin"];
    const view = ex && ex.activeExcalidrawView;
    const api = view && view.excalidrawAPI;
    if (!api) return null;
    const st = api.getAppState();
    if (!st || !st.activeTool || st.activeTool.type !== "freedraw") return null;
    return { view, api, st };
  }

  onStroke(data) {
    const ctx = this.excalidraw();
    if (!ctx) return;
    const { view, api, st } = ctx;
    const dpr = window.devicePixelRatio || 1;
    const canvas = view.contentEl.querySelector("canvas.excalidraw__canvas") || view.contentEl.querySelector("canvas");
    const r = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const zoom = (st.zoom && st.zoom.value) || 1;
    // Onyx points are in the overlay window's coords (physical px). Shift them by the
    // overlay's screen origin, then by where the webview sits on screen (status bar,
    // keyboard resize) so they land in viewport CSS px.
    const ox = (data.ox || 0) / dpr, oy = (data.oy || 0) / dpr;
    const wy = this.webviewTop();
    const toScene = (px, py) => [
      (px / dpr + ox - r.left) / zoom - st.scrollX,
      (py / dpr + oy - wy - r.top) / zoom - st.scrollY,
    ];

    let pts = data.pts.map((p) => { const s = toScene(p[0], p[1]); return [s[0], s[1], p[2]]; });

    const now = Date.now();
    const bb = bbox(pts);
    const pad = 40 / zoom;
    const els = api.getSceneElements();
    const cands = els.filter((e) =>
      e.type === "freedraw" && !e.isDeleted && !String(e.id).startsWith("ox_") &&
      now - (e.updated || 0) < 3000);

    // No auto-calibration: the exact transform (overlay origin + dpr + canvas rect)
    // already lands within ~1 px; matching-based calibration grabbed wrong strokes
    // and skewed good ones.
    const dx = 0, dy = 0;
    const fb = bbox(pts);
    const kill = cands.filter((e) => overlaps(elBox(e), grow(fb, pad)));

    const x0 = pts[0][0], y0 = pts[0][1];
    const local = pts.map((p) => [p[0] - x0, p[1] - y0]);
    const lb = bbox(local);
    const el = {
      type: "freedraw", id: "ox_" + Math.random().toString(36).slice(2, 11),
      x: x0, y: y0, width: Math.max(lb.x2 - lb.x1, 1), height: Math.max(lb.y2 - lb.y1, 1),
      angle: 0, strokeColor: st.currentItemStrokeColor || "#1e1e1e", backgroundColor: "transparent",
      fillStyle: "solid", strokeWidth: st.currentItemStrokeWidth || 1, strokeStyle: "solid",
      roughness: 0, opacity: st.currentItemOpacity || 100, groupIds: [], frameId: null, roundness: null,
      seed: Math.floor(Math.random() * 2 ** 31), version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31),
      isDeleted: false, boundElements: null, updated: now, link: null, locked: false,
      points: local,
      pressures: pts.map((p) => Math.max(0.05, Math.min(1, p[2] / 4096))),
      simulatePressure: false, lastCommittedPoint: null,
    };

    const killIds = new Set(kill.map((e) => e.id));
    const next = els.filter((e) => !killIds.has(e.id)).concat([el]);
    api.updateScene({ elements: next, captureUpdate: "IMMEDIATELY" });

    // Excalidraw's own (late, laggy) stroke can be committed AFTER ours. Remember
    // our stroke's box for a few seconds and sweep any late duplicates.
    this.recent = (this.recent || []).filter((r) => now - r.t < 4000);
    this.recent.push({ t: now, box: grow(fb, pad), ids: new Set([el.id]) });
    this.scheduleSweep(api);

    if (kill.length) this.stats.swapped++; else this.stats.noMatch++;
    this.stats.log.push({ n: data.pts.length, killed: kill.length, cands: cands.length, dx: Math.round(dx), dy: Math.round(dy) });
    if (this.stats.log.length > 20) this.stats.log.shift();
  }

  // Sweep late Excalidraw-native freedraw strokes that overlap one of our recent
  // Onyx strokes. Runs a few times over ~2.5 s after each Onyx stroke.
  scheduleSweep(api) {
    const run = (left) => this.safe(() => {
      const now = Date.now();
      this.recent = (this.recent || []).filter((r) => now - r.t < 4000);
      if (this.recent.length) {
        const els = api.getSceneElements();
        const dup = els.filter((e) => e.type === "freedraw" && !e.isDeleted &&
          !String(e.id).startsWith("ox_") && now - (e.updated || 0) < 4000 &&
          this.recent.some((r) => contains(r.box, elBox(e))));
        if (dup.length) {
          const ids = new Set(dup.map((e) => e.id));
          api.updateScene({ elements: els.filter((e) => !ids.has(e.id)), captureUpdate: "NEVER" });
          this.stats.late = (this.stats.late || 0) + dup.length;
        }
      }
      if (left > 0) setTimeout(() => run(left - 1), 500);
    });
    setTimeout(() => run(4), 300);
  }

  median() {
    if (!this.deltas.length) return null;
    const m = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return [m(this.deltas.map((d) => d[0])), m(this.deltas.map((d) => d[1]))];
  }

  // Where the webview's top edge is on the physical screen, in CSS px.
  // screen.height - innerHeight = status bar (+ nav bar / keyboard when shown);
  // the status bar is on top, so use the value measured while no keyboard is up.
  webviewTop() {
    // On this Boox, Obsidian is edge-to-edge (screen.height ≈ innerHeight), so the
    // webview starts at y=0. Only trust small gaps; a big gap means a keyboard resize.
    const gap = (window.screen.height - window.innerHeight);
    if (gap >= 0 && gap < 120) this.topGap = gap;
    return this.topGap != null ? this.topGap : 0;
  }

  // Pause Onyx raw drawing while the user types (keyboard / text editing),
  // so the IME and the pen-to-text keyboard get the pen; resume afterwards.
  watchKeyboard() {
    const send = (type) => { try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type })); } catch (e) {} };
    const isText = (el) => el && (el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit|color)$/i.test(el.type || "")));
    const update = () => {
      const typing = isText(document.activeElement);
      const vv = window.visualViewport;
      const kb = (window.screen.height - window.innerHeight > 120) ||
        (vv ? (window.innerHeight - vv.height > 120) : false);
      const pause = typing || kb;
      this.kbOpen = kb;
      if (pause !== this.paused) { this.paused = pause; send(pause ? "pause" : "resume"); }
    };
    this.registerDomEvent(document, "focusin", () => setTimeout(update, 50));
    this.registerDomEvent(document, "focusout", () => setTimeout(update, 50));
    if (window.visualViewport) this.registerDomEvent(window.visualViewport, "resize", update);
    this.registerInterval(window.setInterval(update, 1500));
    this.kbUpdate = update;
  }
}

function bbox(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) { if (p[0] < x1) x1 = p[0]; if (p[0] > x2) x2 = p[0]; if (p[1] < y1) y1 = p[1]; if (p[1] > y2) y2 = p[1]; }
  return { x1, y1, x2, y2 };
}
function elBox(e) {
  const b = bbox(e.points.length ? e.points : [[0, 0]]);
  return { x1: e.x + b.x1, y1: e.y + b.y1, x2: e.x + b.x2, y2: e.y + b.y2 };
}
function grow(b, d) { return { x1: b.x1 - d, y1: b.y1 - d, x2: b.x2 + d, y2: b.y2 + d }; }
function shift(b, dx, dy) { return { x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy }; }
function overlaps(a, b) { return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1; }
// b is mostly inside a (allow a small spill), so neighbouring letters aren't swept
function contains(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const area = Math.max(1, (b.x2 - b.x1) * (b.y2 - b.y1));
  return (ix * iy) / area > 0.7;
}

module.exports = InkOnyxBridgePlugin;
