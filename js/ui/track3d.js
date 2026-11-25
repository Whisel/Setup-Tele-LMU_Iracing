/* 3D view of one lap: the driven line in space, with a wall standing on it whose height is
   the pedal. Brake is drawn from the road up (red); throttle is stacked on top of it (green),
   so a braking peak is a tall red fin before a corner and mid-corner throttle is a green wall
   that starts at or after the apex.

   Drawn on the same 2D canvas as the other charts, with no 3D library: each point is
   projected with a perspective camera that orbits a point on the track, and the pieces of
   wall are painted from the farthest to the nearest.

     STA.view3d  the geometry: camera, projection, fitting the view. No drawing; tested in Node.
     STA.charts.Track3D  the canvas component. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  const NEAR = 1;                         // m in front of the camera; anything closer is not drawn
  const FOV = (50 * Math.PI) / 180;       // vertical field of view
  const PITCH_MIN = (4 * Math.PI) / 180, PITCH_MAX = (89.5 * Math.PI) / 180;

  /* ---------- geometry ---------- */

  // Moving average that ignores gaps (NaN) instead of counting them as zero.
  function smoothGaps(a, w) {
    const n = a.length, h = Math.max(0, (w | 0) >> 1), out = new Float64Array(n);
    const sum = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const ok = a[i] === a[i]; sum[i + 1] = sum[i] + (ok ? a[i] : 0); cnt[i + 1] = cnt[i] + (ok ? 1 : 0); }
    for (let i = 0; i < n; i++) {
      if (a[i] !== a[i]) { out[i] = NaN; continue; }
      const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
      out[i] = (sum[hi + 1] - sum[lo]) / (cnt[hi + 1] - cnt[lo]);
    }
    return out;
  }

  /* What the view needs from a lap grid: positions, smoothed height, pedals, and the size of it all. */
  function sceneOf(g) {
    if (!g || !g.x || !g.y) return null;
    const n = g.n, z = g.z ? smoothGaps(g.z, Math.max(1, Math.round(15 / g.step))) : null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const x = g.x[i], y = g.y[i];
      if (x !== x || y !== y) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z && z[i] === z[i]) { if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i]; }
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++;
    }
    if (!m) return null;
    // The direction the track is longest in, so the first view spreads it across the screen.
    const mx = sx / m, my = sy / m, cxx = sxx / m - mx * mx, cyy = syy / m - my * my, cxy = sxy / m - mx * my;
    const axis = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const zRange = isFinite(z0) ? z1 - z0 : 0;
    return {
      n, step: g.step, x: g.x, y: g.y, z: zRange >= 1 ? z : null, zMin: isFinite(z0) ? z0 : 0, zRange,
      brake: g.brake, throttle: g.throttle, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      radius: Math.max(20, Math.hypot(x1 - x0, y1 - y0) / 2), axis, sizeX: x1 - x0, sizeY: y1 - y0,
    };
  }

  /* Camera that orbits a target. view = { tx, ty, tz, yaw, pitch, dist }; yaw is the compass
     direction from the target to the camera, pitch the angle above the ground. */
  function camera(view, W, H) {
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch), cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    const C = [view.tx + view.dist * cp * cy, view.ty + view.dist * cp * sy, view.tz + view.dist * sp];
    const f = [-cp * cy, -cp * sy, -sp];
    const rl = Math.hypot(f[0], f[1]) || 1, r = [f[1] / rl, -f[0] / rl, 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { C, f, r, u, F: H / 2 / Math.tan(FOV / 2), W, H };
  }

  /* World point -> [screen x, screen y, depth]; false when it is behind or too close to the camera. */
  function project(cam, x, y, z, out) {
    const dx = x - cam.C[0], dy = y - cam.C[1], dz = z - cam.C[2];
    const depth = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
    if (!(depth >= NEAR)) return false;
    out[0] = cam.W / 2 + (cam.F * (dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2])) / depth;
    out[1] = cam.H / 2 - (cam.F * (dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2])) / depth;
    out[2] = depth;
    return true;
  }

  /* The first view: looking across the track's long side from 38° up, with the whole lap and its
     walls filling the screen. Perspective makes the near side bigger, so the distance and the
     centre are found by trying: measure what is drawn, then move and scale until it fits. */
  function fitView(sc, W, H, exag, wallH) {
    const view = { tx: sc.cx, ty: sc.cy, tz: (sc.zRange * exag) / 2, yaw: sc.axis - Math.PI / 2, pitch: (38 * Math.PI) / 180, dist: Math.max(60, sc.radius * 2.2) };
    const p = [0, 0, 0], top = wallH || 0, every = Math.max(1, Math.round(sc.n / 400));
    for (let round = 0; round < 40; round++) {
      const cam = camera(view, W, H);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
      for (let i = 0; i < sc.n && !behind; i += every) {
        if (sc.x[i] !== sc.x[i]) continue;
        const z = sc.z && sc.z[i] === sc.z[i] ? (sc.z[i] - sc.zMin) * exag : 0;
        for (const up of [0, top]) {
          if (!project(cam, sc.x[i], sc.y[i], z + up, p)) { behind = true; break; }
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
      }
      if (behind) { view.dist *= 1.6; continue; }
      const need = Math.max((x1 - x0) / (W * 0.92), (y1 - y0) / (H * 0.86));
      const offX = (x0 + x1) / 2 - W / 2, offY = (y0 + y1) / 2 - H / 2, k = view.dist / cam.F;
      if (need <= 1 && need > 0.97 && Math.abs(offX) < W * 0.01 && Math.abs(offY) < H * 0.01) break;
      // move the target so the picture is centred: sideways along the screen, and along the ground for up and down
      const back = (-offY * k) / Math.max(0.35, Math.sin(view.pitch));
      view.tx += offX * k * cam.r[0] + back * Math.cos(view.yaw + Math.PI); view.ty += offX * k * cam.r[1] + back * Math.sin(view.yaw + Math.PI);
      view.dist *= U.clamp(need, 0.75, 1.5);
    }
    return view;
  }

  // Full pedal = this many metres of wall, before the user's multiplier.
  function wallMetres(sc) { return U.clamp(0.06 * sc.radius, 12, 80); }

  STA.view3d = { sceneOf, camera, project, fitView, wallMetres, smoothGaps, NEAR, PITCH_MIN, PITCH_MAX };

  /* ---------- the canvas component ---------- */

  const css = (name) => STA.charts.css(name);

  // CSS colour -> [r, g, b], by letting the canvas normalise it.
  function rgbOf(ctx, colour) {
    ctx.fillStyle = '#000'; ctx.fillStyle = colour;
    const s = ctx.fillStyle;
    if (s[0] === '#') return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : [128, 128, 128];
  }
  const shadeOf = (rgb, k) => 'rgb(' + rgb.map((v) => Math.round(v * k)).join(',') + ')';
  const SHADES = [0.62, 0.74, 0.86, 1];

  /* opts = { onCursor(i), onView(view) }; data = { grid, corners: [{ name, i }], label } */
  function Track3D(el, opts) {
    this.el = el; this.opts = opts || {}; this.cursor = -1; this.sc = null; this.view = null;
    this.wallMul = 1; this.exag = 2; this.fast = false; this.picks = null; this._raf = 0;
    const c = (this.canvas = document.createElement('canvas'));
    c.tabIndex = 0; c.setAttribute('role', 'img'); c.style.touchAction = 'none';
    el.appendChild(c);
    this.ro = new ResizeObserver(() => this.queue()); this.ro.observe(el);
    const self = this;
    let drag = null, idle = 0;
    const settle = () => { clearTimeout(idle); idle = setTimeout(() => { self.fast = false; self.queue(); self.changed(); }, 140); };
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('pointerdown', (ev) => {
      if (!self.view) return;
      c.focus({ preventScroll: true });
      drag = { x: ev.clientX, y: ev.clientY, pan: ev.button !== 0 || ev.shiftKey, moved: false, id: ev.pointerId };
      try { c.setPointerCapture(ev.pointerId); } catch (e) { /* pointer capture is a nicety */ }
    });
    c.addEventListener('pointermove', (ev) => {
      if (!self.view) return;
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        drag.moved = true; drag.x = ev.clientX; drag.y = ev.clientY; c.classList.add('grabbing');
        if (drag.pan) self.pan(dx, dy); else self.turn(-dx * 0.006, dy * 0.006);
        self.fast = true; self.queue();
        return;
      }
      const r = c.getBoundingClientRect();
      self.setCursor(self.pick(ev.clientX - r.left, ev.clientY - r.top), true);
    });
    const up = (ev) => {
      if (!drag) return;
      const was = drag; drag = null; c.classList.remove('grabbing');
      try { c.releasePointerCapture(was.id); } catch (e) { /* see above */ }
      if (!was.moved) { // a click: centre the view on that point of the line
        const r = c.getBoundingClientRect(), i = self.pick(ev.clientX - r.left, ev.clientY - r.top);
        if (i >= 0) self.centreOn(i);
      }
      self.fast = false; self.queue(); self.changed();
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (!drag) self.setCursor(-1, true); });
    c.addEventListener('wheel', (ev) => {
      if (!self.view) return;
      ev.preventDefault();
      self.zoom(Math.exp(ev.deltaY * 0.0012)); self.fast = true; self.queue(); settle();
    }, { passive: false });
    c.addEventListener('dblclick', () => self.resetView());
    c.addEventListener('keydown', (ev) => {
      if (!self.view) return;
      const k = ev.key, step = ev.shiftKey ? 0.2 : 0.07;
      if (k === 'ArrowLeft') self.turn(step, 0); else if (k === 'ArrowRight') self.turn(-step, 0);
      else if (k === 'ArrowUp') self.turn(0, step); else if (k === 'ArrowDown') self.turn(0, -step);
      else if (k === '+' || k === '=') self.zoom(0.85); else if (k === '-' || k === '_') self.zoom(1 / 0.85);
      else if (k === 'Home' || k === '0') { self.resetView(); ev.preventDefault(); return; }
      else return;
      ev.preventDefault(); self.queue(); self.changed();
    });
  }

  Track3D.prototype.destroy = function () { this.ro.disconnect(); if (this._raf) cancelAnimationFrame(this._raf); this.el.innerHTML = ''; };
  Track3D.prototype.queue = function () { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); };
  Track3D.prototype.changed = function () { if (this.opts.onView && this.view) this.opts.onView(Object.assign({}, this.view)); };

  /* view: a saved camera to start from (or null for the fitted one). */
  Track3D.prototype.setData = function (data, view) {
    this.data = data; this.sc = sceneOf(data.grid); this.view = view && this.sc ? Object.assign({}, view) : null;
    this.canvas.setAttribute('aria-label', (data.label || 'Lap') + ' in 3D: the driven line with a wall for brake (red) and throttle (green). The same numbers are in the traces below and in the Telemetry tables tab.');
    this.queue();
  };
  Track3D.prototype.setOptions = function (o) {
    const exagWas = this.exag;
    if (o.wallMul != null) this.wallMul = o.wallMul;
    if (o.exag != null) this.exag = o.exag;
    if (this.view && this.exag !== exagWas && this.sc) this.view.tz *= this.exag / exagWas; // keep the target on the road
    this.queue();
  };
  Track3D.prototype.resetView = function () { this.view = null; this.queue(); this.changed(); };
  Track3D.prototype.topDown = function () { if (!this.view) return; this.view.pitch = PITCH_MAX; this.queue(); this.changed(); };
  Track3D.prototype.setCursor = function (i, fromUser) {
    if (i === this.cursor) return;
    this.cursor = i; this.queue();
    if (fromUser && this.opts.onCursor) this.opts.onCursor(i);
  };
  Track3D.prototype.turn = function (dYaw, dPitch) {
    const v = this.view; v.yaw += dYaw; v.pitch = U.clamp(v.pitch + dPitch, PITCH_MIN, PITCH_MAX);
  };
  Track3D.prototype.zoom = function (k) {
    const v = this.view, R = this.sc.radius; v.dist = U.clamp(v.dist * k, Math.max(15, R * 0.02), R * 8);
  };
  // Move the target over the ground, so the point under the pointer follows the pointer.
  Track3D.prototype.pan = function (dx, dy) {
    const v = this.view, cam = camera(v, this.el.clientWidth, this.el.clientHeight), k = v.dist / cam.F;
    const fx = Math.cos(v.yaw + Math.PI), fy = Math.sin(v.yaw + Math.PI), back = (dy * k) / Math.max(0.35, Math.sin(v.pitch));
    v.tx += -dx * k * cam.r[0] + back * fx; v.ty += -dx * k * cam.r[1] + back * fy;
  };
  Track3D.prototype.zAt = function (i) { const sc = this.sc; return sc.z && sc.z[i] === sc.z[i] ? (sc.z[i] - sc.zMin) * this.exag : 0; };
  Track3D.prototype.centreOn = function (i) {
    const sc = this.sc; if (!this.view || sc.x[i] !== sc.x[i]) return;
    this.view.tx = sc.x[i]; this.view.ty = sc.y[i]; this.view.tz = this.zAt(i);
  };

  // The grid index of the line point drawn nearest to (mx, my), within 26 px; -1 when none.
  Track3D.prototype.pick = function (mx, my) {
    const P = this.picks; if (!P) return -1;
    let best = -1, bd = 26 * 26;
    for (let k = 0; k < P.n; k++) {
      const dx = P.sx[k] - mx, dy = P.sy[k] - my, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = P.i[k]; }
    }
    return best;
  };

  Track3D.prototype.draw = function () {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (W < 40 || H < 40) return;
    const ctx = STA.charts.fitCanvas(this.canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    const sc = this.sc;
    if (!sc) return;
    const Hw = wallMetres(sc) * this.wallMul;
    if (!this.view) this.view = fitView(sc, W, H, sc.z ? this.exag : 0, Hw * 1.2);
    const cam = camera(this.view, W, H);
    const ink = css('--ink'), muted = css('--muted'), surface = css('--surface');
    const brk = rgbOf(ctx, css('--brk')), thr = rgbOf(ctx, css('--thr'));
    const brkS = SHADES.map((k) => shadeOf(brk, k)), thrS = SHADES.map((k) => shadeOf(thr, k));

    // Sample the lap every 2 m (5 m while the view is moving), and project each sample three
    // times: on the road, at the top of the brake wall, and at the top of the throttle wall.
    const every = Math.max(1, Math.round((this.fast ? 5 : 2) / sc.step));
    const idx = [];
    for (let i = 0; i < sc.n; i += every) idx.push(i);
    if (idx[idx.length - 1] !== sc.n - 1) idx.push(sc.n - 1);
    const m = idx.length;
    const G = new Float64Array(m * 3), B = new Float64Array(m * 3), T = new Float64Array(m * 3), ok = new Uint8Array(m);
    const hb = new Float64Array(m), ht = new Float64Array(m), p = [0, 0, 0];
    const picks = { n: 0, sx: new Float64Array(m), sy: new Float64Array(m), i: new Int32Array(m) };
    for (let k = 0; k < m; k++) {
      const i = idx[k], x = sc.x[i], y = sc.y[i];
      if (x !== x || y !== y) continue;
      const z = this.zAt(i);
      const b = U.clamp(sc.brake && sc.brake[i] === sc.brake[i] ? sc.brake[i] : 0, 0, 1), t = U.clamp(sc.throttle && sc.throttle[i] === sc.throttle[i] ? sc.throttle[i] : 0, 0, 1);
      hb[k] = b * Hw; ht[k] = t * Hw;
      if (!project(cam, x, y, z, p)) continue;
      G[k * 3] = p[0]; G[k * 3 + 1] = p[1]; G[k * 3 + 2] = p[2];
      if (!project(cam, x, y, z + hb[k], p)) continue;
      B[k * 3] = p[0]; B[k * 3 + 1] = p[1]; B[k * 3 + 2] = p[2];
      if (!project(cam, x, y, z + hb[k] + ht[k], p)) continue;
      T[k * 3] = p[0]; T[k * 3 + 1] = p[1]; T[k * 3 + 2] = p[2];
      ok[k] = 1;
      picks.sx[picks.n] = G[k * 3]; picks.sy[picks.n] = G[k * 3 + 1]; picks.i[picks.n] = i; picks.n++;
    }
    this.picks = picks;

    // The road: one wide band under everything, drawn first.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = css('--track'); ctx.lineWidth = 7; ctx.beginPath();
    let pen = false;
    for (let k = 0; k < m; k++) { if (!ok[k]) { pen = false; continue; } if (!pen) { ctx.moveTo(G[k * 3], G[k * 3 + 1]); pen = true; } else ctx.lineTo(G[k * 3], G[k * 3 + 1]); }
    ctx.stroke();

    // Pieces: per stretch between two samples, the line on the road, the brake wall, the
    // throttle wall on top of it. Each is shaded by how squarely it faces the camera.
    const MIN = Hw * 0.015, fx = cam.f[0], fy = cam.f[1], fl = Math.hypot(fx, fy) || 1;
    const kind = [], seg = [], shade = [], depth = [];
    for (let k = 0; k + 1 < m; k++) {
      if (!ok[k] || !ok[k + 1]) continue;
      const i0 = idx[k], i1 = idx[k + 1];
      const nx = sc.y[i1] - sc.y[i0], ny = -(sc.x[i1] - sc.x[i0]), nl = Math.hypot(nx, ny) || 1;
      const face = Math.abs((nx * fx + ny * fy) / (nl * fl)), sh = Math.min(SHADES.length - 1, Math.floor(face * SHADES.length));
      const d = (G[k * 3 + 2] + G[k * 3 + 5]) / 2;
      kind.push(0); seg.push(k); shade.push(0); depth.push(d + 0.002);
      if (hb[k] > MIN || hb[k + 1] > MIN) { kind.push(1); seg.push(k); shade.push(sh); depth.push(d + 0.001); }
      if (ht[k] > MIN || ht[k + 1] > MIN) { kind.push(2); seg.push(k); shade.push(sh); depth.push(d); }
    }
    const order = Array.from(depth.keys()).sort((a, b) => depth[b] - depth[a]);

    // Paint far to near, one path per run of pieces in the same colour.
    let style = -1, open = false;
    // Filled pieces are also outlined in their own colour, so no light seams show between neighbours.
    const flush = () => { if (!open) return; if (style === 0) ctx.stroke(); else { ctx.fill(); ctx.stroke(); } open = false; };
    for (const q of order) {
      const kd = kind[q], k = seg[q], st = kd === 0 ? 0 : kd * 10 + shade[q];
      if (st !== style) {
        flush(); style = st;
        if (kd === 0) { ctx.strokeStyle = muted; ctx.lineWidth = 2; } else { ctx.fillStyle = ctx.strokeStyle = kd === 1 ? brkS[shade[q]] : thrS[shade[q]]; ctx.lineWidth = 0.8; }
        ctx.beginPath(); open = true;
      }
      const a = k * 3, b = (k + 1) * 3;
      if (kd === 0) { ctx.moveTo(G[a], G[a + 1]); ctx.lineTo(G[b], G[b + 1]); continue; }
      const lo = kd === 1 ? G : B, hi = kd === 1 ? B : T;
      ctx.moveTo(lo[a], lo[a + 1]); ctx.lineTo(lo[b], lo[b + 1]); ctx.lineTo(hi[b], hi[b + 1]); ctx.lineTo(hi[a], hi[a + 1]); ctx.closePath();
    }
    flush();

    // Labels: corners and start/finish, above the wall.
    ctx.font = '600 11px ' + css('--font-num'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = (i, text, strong) => {
      if (sc.x[i] !== sc.x[i] || !project(cam, sc.x[i], sc.y[i], this.zAt(i) + Hw * 1.18, p)) return;
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = surface; ctx.globalAlpha = 0.85; ctx.fillRect(p[0] - w / 2, p[1] - 8, w, 16); ctx.globalAlpha = 1;
      ctx.fillStyle = strong ? ink : muted; ctx.fillText(text, p[0], p[1] + 0.5);
    };
    for (const c of (this.data && this.data.corners) || []) label(c.i, c.name, false);
    label(0, 'S/F', true);

    // Cursor: a post from the road to above the wall, with a dot on the road.
    const ci = this.cursor;
    if (ci >= 0 && ci < sc.n && sc.x[ci] === sc.x[ci]) {
      const z = this.zAt(ci), q = [0, 0, 0];
      const b = U.clamp(sc.brake ? sc.brake[ci] || 0 : 0, 0, 1), t = U.clamp(sc.throttle ? sc.throttle[ci] || 0 : 0, 0, 1);
      if (project(cam, sc.x[ci], sc.y[ci], z, p) && project(cam, sc.x[ci], sc.y[ci], z + Math.max(Hw * 1.05, (b + t) * Hw + Hw * 0.1), q)) {
        ctx.strokeStyle = surface; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.fillStyle = ink; ctx.strokeStyle = surface; ctx.lineWidth = 2;
        for (const at of [p, q]) { ctx.beginPath(); ctx.arc(at[0], at[1], at === p ? 5.5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      }
    }
  };

  (STA.charts = STA.charts || {}).Track3D = Track3D;
})(typeof window !== 'undefined' ? window : globalThis);
