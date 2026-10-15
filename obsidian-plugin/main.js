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
    ws.onopen = () => { this.retry = 1000; };
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
    const toScene = (px, py) => [
      (px / dpr - r.left) / zoom - st.scrollX,
      (py / dpr - r.top) / zoom - st.scrollY,
    ];

    let pts = data.pts.map((p) => { const s = toScene(p[0], p[1]); return [s[0], s[1], p[2]]; });

    const now = Date.now();
    const bb = bbox(pts);
    const pad = 40 / zoom;
    const els = api.getSceneElements();
    const cands = els.filter((e) =>
      e.type === "freedraw" && !e.isDeleted && !String(e.id).startsWith("ox_") &&
      now - (e.updated || 0) < 3000);

    // calibration: constant offset (CSS px) between Onyx and webview coords
    let dx = 0, dy = 0;
    const med = this.median();
    if (med) { dx = med[0]; dy = med[1]; }
    const near = cands.filter((e) => overlaps(elBox(e), grow(shift(bb, dx / zoom, dy / zoom), pad + 60 / zoom)));
    const best = near.sort((a, b) => b.points.length - a.points.length)[0];
    if (best && best.points.length >= 4) {
      const ux = best.x + best.points[0][0], uy = best.y + best.points[0][1];
      this.deltas.push([(ux - pts[0][0]) * zoom, (uy - pts[0][1]) * zoom]);
      if (this.deltas.length > 9) this.deltas.shift();
      const m = this.median(); dx = m[0]; dy = m[1];
    }
    pts = pts.map((p) => [p[0] + dx / zoom, p[1] + dy / zoom, p[2]]);
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

    if (kill.length) this.stats.swapped++; else this.stats.noMatch++;
    this.stats.log.push({ n: data.pts.length, killed: kill.length, cands: cands.length, dx: Math.round(dx), dy: Math.round(dy) });
    if (this.stats.log.length > 20) this.stats.log.shift();
  }

  median() {
    if (!this.deltas.length) return null;
    const m = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return [m(this.deltas.map((d) => d[0])), m(this.deltas.map((d) => d[1]))];
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

module.exports = InkOnyxBridgePlugin;
