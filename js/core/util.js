/* Shared helpers. Every file attaches to one global namespace (STA) so the app
   runs from a plain file:// page with classic <script> tags, and the same files
   can be require()d from Node for the tests. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});

  const U = {};

  U.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  U.lerp = (a, b, f) => a + (b - a) * f;
  U.isNum = (v) => typeof v === 'number' && isFinite(v);

  U.mean = function (a) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { s += v; n++; } }
    return n ? s / n : NaN;
  };

  U.minMax = function (a, i0, i1) {
    let lo = Infinity, hi = -Infinity;
    i0 = i0 || 0; i1 = i1 == null ? a.length : i1;
    for (let i = i0; i < i1; i++) { const v = a[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return [lo, hi];
  };

  U.percentile = function (a, p) {
    const s = Array.from(a).filter((v) => v === v).sort((x, y) => x - y);
    if (!s.length) return NaN;
    const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(s.length - 1, f + 1);
    return s[f] + (s[c] - s[f]) * (k - f);
  };
  U.median = (a) => U.percentile(a, 0.5);

  U.std = function (a) {
    const m = U.mean(a); let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { s += (v - m) * (v - m); n++; } }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  };

  /* Pearson correlation of two equal-length arrays, ignoring NaN pairs. */
  U.corr = function (a, b) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x === x && y === y) { n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
    }
    if (n < 3) return 0;
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
  };

  /* Centred moving average with a window of `w` samples (forced odd). */
  U.smooth = function (a, w) {
    w = Math.max(1, w | 0); if (w % 2 === 0) w++;
    if (w === 1) return Float64Array.from(a);
    const n = a.length, h = (w - 1) / 2, out = new Float64Array(n);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (a[i] === a[i] ? a[i] : 0);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  };

  /* Linear interpolation of ys(xs) at each value of xq. xs must be non-decreasing.
     mode 'step' holds the previous sample instead (for gears, flags). */
  U.interp = function (xs, ys, xq, mode, Out) {
    const n = xs.length, m = xq.length, out = new (Out || Float32Array)(m);
    if (!n) { out.fill(NaN); return out; }
    let j = 0;
    for (let k = 0; k < m; k++) {
      const x = xq[k];
      while (j < n - 2 && xs[j + 1] < x) j++;
      if (j > 0 && xs[j] > x) { j = 0; while (j < n - 2 && xs[j + 1] < x) j++; }
      if (n === 1 || x <= xs[0]) { out[k] = ys[0]; continue; }
      if (x >= xs[n - 1]) { out[k] = ys[n - 1]; continue; }
      const x0 = xs[j], x1 = xs[j + 1];
      if (mode === 'step') { out[k] = x >= x1 ? ys[j + 1] : ys[j]; continue; }
      const f = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
      out[k] = ys[j] + (ys[j + 1] - ys[j]) * f;
    }
    return out;
  };

  /* Evaluate a change-only event list (ts, values) on a time base. */
  U.stepEvents = function (ts, vals, tq, dflt, Out) {
    const out = new (Out || Float32Array)(tq.length);
    let j = -1;
    for (let k = 0; k < tq.length; k++) {
      while (j + 1 < ts.length && ts[j + 1] <= tq[k]) j++;
      out[k] = j >= 0 ? vals[j] : (dflt == null ? (vals.length ? vals[0] : 0) : dflt);
    }
    return out;
  };

  /* Least-squares slope of y = k·x through the origin. */
  U.slopeThroughOrigin = function (x, y) {
    let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; }
    return sxx > 0 ? sxy / sxx : NaN;
  };

  U.fmtLap = function (s) {
    if (!U.isNum(s) || s <= 0) return '–';
    const m = Math.floor(s / 60), r = s - m * 60;
    return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3);
  };
  U.fmtDelta = function (s, d) {
    if (!U.isNum(s)) return '–';
    const txt = Math.abs(s).toFixed(d == null ? 3 : d);
    return (parseFloat(txt) === 0 ? '' : s > 0 ? '+' : '−') + txt;
  };
  U.fmt = function (v, d) { return U.isNum(v) ? v.toFixed(d == null ? 1 : d) : '–'; };

  U.slug = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /* Small stable string hash (FNV-1a), used for setup fingerprints and ids. */
  U.hash = function (str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  };

  U.uid = function (prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  };

  U.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  U.csv = function (rows) {
    return rows.map((r) => r.map((c) => {
      const s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  };

  STA.util = U;
  STA.G = 9.80665;
  STA.WHEELS = ['FL', 'FR', 'RL', 'RR'];
  if (typeof module !== 'undefined' && module.exports) module.exports = STA;
})(typeof window !== 'undefined' ? window : globalThis);
