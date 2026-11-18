/* Canvas drawing for the two visual components:
     TraceStack - telemetry traces against lap distance, one panel per channel,
                  all sharing one distance axis, cursor and zoom
     TrackMap   - the driven line(s) in plan view
   Colours come from CSS custom properties so light and dark themes share code. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

  function fitCanvas(canvas, w, h) {
    const dpr = root.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function niceStep(span, target) {
    const raw = span / Math.max(1, target), mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
  }

  /* ---------------- TraceStack ---------------- */

  function TraceStack(el, opts) {
    this.el = el; this.opts = opts || {}; this.panels = []; this.x = null; this.range = null; this.cursor = -1; this.drag = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(el);
    this._up = () => {
      if (!this.drag) return;
      const a = Math.min(this.drag.x0, this.drag.x1), b = Math.max(this.drag.x0, this.drag.x1);
      const [r0, r1] = this.xRange();
      this.drag = null;
      if (b - a > (r1 - r0) * 0.02) this.setRange([Math.max(this.x[0], a), Math.min(this.x[this.x.length - 1], b)]);
      else this.draw();
    };
    root.addEventListener('mouseup', this._up);
  }

  TraceStack.prototype.destroy = function () { this.ro.disconnect(); root.removeEventListener('mouseup', this._up); this.el.innerHTML = ''; };

  /* data = { x: distance array, panels: [{ key, label, unit, dec, height, min, max, zero, step,
              series: [{ name, colorVar, data }], delta: bool }], corners: [{ name, dApex }] } */
  TraceStack.prototype.setData = function (data) {
    this.x = data.x; this.corners = data.corners || []; this.range = this.range && this._len === data.x.length ? this.range : null;
    this._len = data.x.length;
    this.el.innerHTML = '';
    this.panels = data.panels.map((p, k) => {
      const wrap = document.createElement('div'); wrap.className = 'trace';
      const head = document.createElement('div'); head.className = 'trace-head';
      const name = document.createElement('span'); name.className = 'trace-name';
      name.textContent = p.label; if (p.unit) { const u = document.createElement('small'); u.textContent = p.unit; name.appendChild(u); }
      const vals = document.createElement('span'); vals.className = 'trace-vals';
      head.appendChild(name); head.appendChild(vals);
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', p.label + ' against lap distance for ' + p.series.map((s) => s.name).join(' and ') + '. The same numbers are in the Telemetry tables tab.');
      wrap.appendChild(head); wrap.appendChild(canvas); this.el.appendChild(wrap);
      const panel = Object.assign({}, p, { wrap, canvas, vals, last: k === data.panels.length - 1, first: k === 0 });
      this.bind(panel);
      return panel;
    });
    this.draw();
  };

  TraceStack.prototype.xRange = function () { return this.range || [this.x[0], this.x[this.x.length - 1]]; };

  TraceStack.prototype.bind = function (panel) {
    const c = panel.canvas, self = this;
    const xAt = (ev) => {
      const r = c.getBoundingClientRect(), [x0, x1] = self.xRange();
      return x0 + ((ev.clientX - r.left - panel.padL) / Math.max(1, panel.plotW)) * (x1 - x0);
    };
    const idxAt = (xv) => U.clamp(Math.round(((xv - self.x[0]) / (self.x[self.x.length - 1] - self.x[0])) * (self.x.length - 1)), 0, self.x.length - 1);
    c.addEventListener('mousemove', (ev) => {
      const xv = xAt(ev);
      if (self.drag) { self.drag.x1 = xv; self.draw(); }
      self.setCursor(idxAt(xv), true);
    });
    c.addEventListener('mouseleave', () => { if (!self.drag) self.setCursor(-1, true); });
    c.addEventListener('mousedown', (ev) => { self.drag = { x0: xAt(ev), x1: xAt(ev) }; ev.preventDefault(); });
    c.addEventListener('dblclick', () => self.setRange(null));
  };

  TraceStack.prototype.setRange = function (r) { this.range = r; this.draw(); if (this.opts.onRange) this.opts.onRange(r); };

  TraceStack.prototype.setCursor = function (i, fromUser) {
    if (i === this.cursor) return;
    this.cursor = i; this.draw();
    if (fromUser && this.opts.onCursor) this.opts.onCursor(i);
  };

  TraceStack.prototype.draw = function () {
    if (!this.x || !this.panels.length) return;
    const W = this.el.clientWidth; if (W < 50) return;
    const [x0, x1] = this.xRange(), x = this.x, n = x.length;
    const i0 = Math.max(0, Math.floor(((x0 - x[0]) / (x[n - 1] - x[0])) * (n - 1))), i1 = Math.min(n - 1, Math.ceil(((x1 - x[0]) / (x[n - 1] - x[0])) * (n - 1)));
    const ink2 = css('--ink-2'), muted = css('--muted'), grid = css('--grid'), axis = css('--axis'), surface = css('--surface');
    const fmtX = (v) => (x[n - 1] - x[0] > 3000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + ' km' : Math.round(v) + ' m');

    for (const p of this.panels) {
      const H = (p.height || 92) + (p.last ? 20 : 0) + (p.first ? 14 : 0);
      const ctx = fitCanvas(p.canvas, W, H);
      const padL = 44, padR = 8, padT = p.first ? 16 : 4, padB = p.last ? 22 : 4;
      const pw = W - padL - padR, ph = H - padT - padB;
      p.padL = padL; p.plotW = pw;
      ctx.clearRect(0, 0, W, H);

      let lo = Infinity, hi = -Infinity;
      for (const s of p.series) {
        if (!s.data) continue;
        for (let i = i0; i <= i1; i++) { const v = s.data[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (p.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      if (p.min != null) lo = p.min; if (p.max != null) hi = p.max;
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      if (p.min == null && p.max == null) { const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; }
      const X = (v) => padL + ((v - x0) / (x1 - x0)) * pw, Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;

      // grid and y labels
      ctx.font = '11px ' + css('--font-num'); ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
      const ys = niceStep(hi - lo, 3);
      for (let v = Math.ceil(lo / ys) * ys; v <= hi + 1e-9; v += ys) {
        const yy = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < 1e-9 && p.zero ? axis : grid; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
        ctx.fillStyle = muted; ctx.textAlign = 'right';
        ctx.fillText((Math.abs(ys) < 1 ? v.toFixed(Math.abs(ys) < 0.1 ? 2 : 1) : String(Math.round(v))).replace('-', '−'), padL - 6, yy);
      }
      // corner guides
      ctx.textAlign = 'center';
      let lastLabel = -Infinity;
      for (const c of this.corners) {
        if (c.dApex < x0 || c.dApex > x1) continue;
        const xx = Math.round(X(c.dApex)) + 0.5;
        ctx.strokeStyle = grid; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ph); ctx.stroke(); ctx.setLineDash([]);
        // skip a name that would run into the previous one
        if (p.first && xx - lastLabel > 26) { ctx.fillStyle = muted; ctx.textBaseline = 'alphabetic'; ctx.fillText(c.name, xx, 11); ctx.textBaseline = 'middle'; lastLabel = xx; }
      }
      // x axis on the last panel
      if (p.last) {
        const xs = niceStep(x1 - x0, Math.max(3, Math.floor(pw / 110)));
        ctx.fillStyle = muted; ctx.textBaseline = 'top';
        for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-6; v += xs) {
          const xx = X(v);
          ctx.textAlign = xx < padL + 20 ? 'left' : xx > W - padR - 20 ? 'right' : 'center';
          ctx.fillText(fmtX(v), xx, padT + ph + 6);
        }
        ctx.strokeStyle = axis; ctx.beginPath(); ctx.moveTo(padL, padT + ph + 0.5); ctx.lineTo(W - padR, padT + ph + 0.5); ctx.stroke();
        ctx.textBaseline = 'middle';
      }
      // series (later series drawn first so the first one sits on top)
      ctx.save(); ctx.beginPath(); ctx.rect(padL, padT - 2, pw, ph + 4); ctx.clip();
      const stride = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
      for (let si = p.series.length - 1; si >= 0; si--) {
        const s = p.series[si]; if (!s.data) continue;
        ctx.strokeStyle = css(s.colorVar); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
        let pen = false, py = 0;
        for (let i = i0; i <= i1; i += stride) {
          const v = s.data[i];
          if (v !== v) { pen = false; continue; }
          const xx = X(x[i]), yy = Y(v);
          if (!pen) { ctx.moveTo(xx, yy); pen = true; } else { if (p.step) ctx.lineTo(xx, py); ctx.lineTo(xx, yy); }
          py = yy;
        }
        ctx.stroke();
      }
      // drag-to-zoom band
      if (this.drag) {
        const a = X(Math.min(this.drag.x0, this.drag.x1)), b = X(Math.max(this.drag.x0, this.drag.x1));
        ctx.fillStyle = css('--select'); ctx.fillRect(a, padT, b - a, ph);
      }
      // cursor
      const ci = this.cursor;
      if (ci >= 0 && x[ci] >= x0 && x[ci] <= x1) {
        const xx = Math.round(X(x[ci])) + 0.5;
        ctx.strokeStyle = ink2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ph); ctx.stroke();
        for (const s of p.series) {
          if (!s.data || s.data[ci] !== s.data[ci]) continue;
          ctx.fillStyle = css(s.colorVar); ctx.strokeStyle = surface; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(xx, Y(s.data[ci]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();

      // live readout in the panel header (doubles as the legend)
      const dec = p.dec == null ? 1 : p.dec;
      let html = '';
      p.series.forEach((s) => {
        if (!s.data) return;
        const v = ci >= 0 ? s.data[ci] : null;
        html += '<span class="rv"><i class="sw" style="background:var(' + s.colorVar + ')"></i>' + U.esc(s.name) + (v != null && v === v ? ' <b>' + v.toFixed(dec).replace('-', '−') + '</b>' : '') + '</span>';
      });
      if (ci >= 0 && p.series.length === 2 && p.series[0].data && p.series[1].data && !p.noDiff) {
        const d = p.series[1].data[ci] - p.series[0].data[ci];
        if (d === d) html += '<span class="rv diff">B − A <b>' + U.fmtDelta(d, dec) + '</b></span>';
      }
      p.vals.innerHTML = html;
    }
    if (this.opts.onDraw) this.opts.onDraw();
  };

  /* ---------------- TrackMap ---------------- */

  function TrackMap(el, opts) {
    this.el = el; this.opts = opts || {}; this.view = null; this.cursor = -1; this.data = null;
    this.canvas = document.createElement('canvas'); el.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(el);
    const c = this.canvas, self = this;
    let pan = null;
    c.addEventListener('mousedown', (ev) => { pan = { x: ev.clientX, y: ev.clientY, ox: self.view.ox, oy: self.view.oy, moved: false }; });
    this._up = () => { pan = null; c.classList.remove('grabbing'); };
    root.addEventListener('mouseup', this._up);
    c.addEventListener('mousemove', (ev) => {
      if (!self.view) return;
      if (pan) {
        const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) { pan.moved = true; c.classList.add('grabbing'); }
        self.view.ox = pan.ox + dx; self.view.oy = pan.oy + dy; self.view.user = true; self.draw(); return;
      }
      const r = c.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const L = self.data && self.data.lines[0]; if (!L) return;
      let best = -1, bd = 40 * 40;
      for (let i = 0; i < L.x.length; i += 2) {
        if (L.x[i] !== L.x[i]) continue;
        const px = self.sx(L.x[i]) - mx, py = self.sy(L.y[i]) - my, d = px * px + py * py;
        if (d < bd) { bd = d; best = i; }
      }
      self.setCursor(best, true);
    });
    c.addEventListener('mouseleave', () => { if (!pan) self.setCursor(-1, true); });
    c.addEventListener('wheel', (ev) => {
      if (!self.view) return;
      ev.preventDefault();
      const r = c.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const k = Math.exp(-ev.deltaY * 0.0015), v = self.view;
      const ns = U.clamp(v.s * k, v.s0 * 0.8, v.s0 * 60);
      v.ox = mx - ((mx - v.ox) * ns) / v.s; v.oy = my - ((my - v.oy) * ns) / v.s; v.s = ns; v.user = true;
      self.draw();
    }, { passive: false });
    c.addEventListener('dblclick', () => { self.view = null; self.draw(); });
  }

  TrackMap.prototype.destroy = function () { this.ro.disconnect(); root.removeEventListener('mouseup', this._up); this.el.innerHTML = ''; };
  TrackMap.prototype.sx = function (x) { return this.view.ox + x * this.view.s; };
  TrackMap.prototype.sy = function (y) { return this.view.oy - y * this.view.s; };
  TrackMap.prototype.resetView = function () { this.view = null; this.draw(); };

  /* data = { lines: [{ name, colorVar, x, y, colors? }], corners: [{ name, i }], marks: [{ i, label }] }
     The first line is the one the cursor follows and the one that can be coloured per point. */
  TrackMap.prototype.setData = function (data, keepView) {
    this.data = data; if (!keepView) this.view = null; this.draw();
  };

  TrackMap.prototype.setCursor = function (i, fromUser) {
    if (i === this.cursor) return;
    this.cursor = i; this.draw();
    if (fromUser && this.opts.onCursor) this.opts.onCursor(i);
  };

  TrackMap.prototype.fit = function (W, H) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const L of this.data.lines) for (let i = 0; i < L.x.length; i++) {
      const x = L.x[i], y = L.y[i]; if (x !== x || y !== y) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0)) return null;
    const pad = 34, s = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, y1 - y0));
    return { s, s0: s, ox: W / 2 - ((x0 + x1) / 2) * s, oy: H / 2 + ((y0 + y1) / 2) * s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };

  TrackMap.prototype.draw = function () {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (W < 40 || H < 40) return;
    const ctx = fitCanvas(this.canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    if (!this.data || !this.data.lines.length) return;
    if (!this.view || (!this.view.user && (this.view.W !== W || this.view.H !== H))) { this.view = this.fit(W, H); if (this.view) { this.view.W = W; this.view.H = H; } }
    if (!this.view) return;
    const v = this.view, surface = css('--surface'), muted = css('--muted'), ink = css('--ink');
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // tarmac: a wide soft band under the first line so the laps read as lines on a track
    const base = this.data.lines[0];
    ctx.strokeStyle = css('--track'); ctx.lineWidth = Math.max(9, 13 * v.s);
    this.path(ctx, base, 0, base.x.length - 1); ctx.stroke();

    for (let li = this.data.lines.length - 1; li >= 0; li--) {
      const L = this.data.lines[li];
      ctx.lineWidth = L.width || 2;
      if (L.colors) {
        let start = 0;
        for (let i = 1; i <= L.x.length; i++) {
          if (i === L.x.length || L.colors[i] !== L.colors[start]) {
            ctx.strokeStyle = L.colors[start]; ctx.lineWidth = 3;
            this.path(ctx, L, Math.max(0, start - 1), Math.min(L.x.length - 1, i)); ctx.stroke();
            start = i;
          }
        }
      } else { ctx.strokeStyle = css(L.colorVar); this.path(ctx, L, 0, L.x.length - 1); ctx.stroke(); }
    }

    // start/finish and corner labels, pushed outward from the middle of the track
    ctx.font = '600 11px ' + css('--font-num'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = (i, text, strong) => {
      if (base.x[i] !== base.x[i]) return;
      const px = this.sx(base.x[i]), py = this.sy(base.y[i]);
      const mx = this.sx(v.cx), my = this.sy(v.cy);
      let dx = px - mx, dy = py - my; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      const lx = px + dx * 20, ly = py + dy * 20, w = ctx.measureText(text).width + 8;
      ctx.fillStyle = surface; ctx.globalAlpha = 0.85; ctx.fillRect(lx - w / 2, ly - 8, w, 16); ctx.globalAlpha = 1;
      ctx.fillStyle = strong ? ink : muted; ctx.fillText(text, lx, ly + 0.5);
    };
    for (const c of this.data.corners || []) label(c.i, c.name, false);
    if (base.x.length) {
      const px = this.sx(base.x[0]), py = this.sy(base.y[0]);
      if (px === px) { ctx.fillStyle = ink; ctx.fillRect(px - 2, py - 7, 4, 14); label(0, 'S/F', true); }
    }

    // scale bar
    const targetPx = 90, metres = niceStep(targetPx / v.s, 1), bw = metres * v.s;
    ctx.strokeStyle = muted; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(14.5, H - 18); ctx.lineTo(14.5, H - 13.5); ctx.lineTo(14.5 + bw, H - 13.5); ctx.lineTo(14.5 + bw, H - 18); ctx.stroke();
    ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.font = '11px ' + css('--font-num');
    ctx.fillText(metres >= 1000 ? metres / 1000 + ' km' : metres + ' m', 20 + bw, H - 15);

    // cursor dots (2px surface ring so overlapping dots stay distinct)
    if (this.cursor >= 0) {
      for (let li = this.data.lines.length - 1; li >= 0; li--) {
        const L = this.data.lines[li], i = Math.min(L.x.length - 1, Math.round((this.cursor / Math.max(1, base.x.length - 1)) * (L.x.length - 1)));
        if (L.x[i] !== L.x[i]) continue;
        ctx.fillStyle = css(L.colorVar); ctx.strokeStyle = surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(this.sx(L.x[i]), this.sy(L.y[i]), 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  };

  TrackMap.prototype.path = function (ctx, L, a, b) {
    ctx.beginPath(); let pen = false;
    for (let i = a; i <= b; i++) {
      const x = L.x[i], y = L.y[i];
      if (x !== x || y !== y) { pen = false; continue; }
      if (!pen) { ctx.moveTo(this.sx(x), this.sy(y)); pen = true; } else ctx.lineTo(this.sx(x), this.sy(y));
    }
  };

  STA.charts = { TraceStack, TrackMap, css };
})(typeof window !== 'undefined' ? window : globalThis);
