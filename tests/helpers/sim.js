/* A small driving simulation used to build test recordings with known answers.

   The circuit is a closed loop of four right-hand corners (radii 40, 120, 60 and
   250 m) joined by straights. A point-mass car drives it at its grip limit, so
   lap length, lap times and where the corners are can all be computed exactly
   and compared with what the app reports. */
const G = 9.80665;

function buildTrack() {
  const r = [40, 120, 60, 250], a = 700, b = 300;
  const c = a + r[3] + r[0] - r[1] - r[2], d = b + r[0] + r[1] - r[2] - r[3];
  const segs = [['S', a / 2], ['R', r[0]], ['S', b], ['R', r[1]], ['S', c], ['R', r[2]], ['S', d], ['R', r[3]], ['S', a / 2]];
  const kappa = [];
  for (const [type, v] of segs) {
    const len = type === 'S' ? v : (Math.PI / 2) * v, n = Math.round(len * 2); // 0.5 m steps
    for (let i = 0; i < n; i++) kappa.push(type === 'S' ? 0 : -(len / (n * 0.5)) / v); // right turn = negative curvature
  }
  // ease curvature in and out over ~25 m so loads build up like a real corner
  const n = kappa.length, k2 = new Float64Array(n), w = 25;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -w; j <= w; j++) s += kappa[(i + j + n) % n]; k2[i] = s / (2 * w + 1); }
  return { ds: 0.5, n, kappa: k2, length: n * 0.5, radii: r };
}

/* Limit speed profile for one lap; grip scales cornering and braking.
   car.vTop: top speed (m/s). car.slowGrip / car.fastGrip scale cornering grip in the slow
   corners (under 28 m/s) and the fast ones (over 45 m/s): less wing is a higher vTop with a
   lower fastGrip; an understeering car is a lower slowGrip. */
function speedProfile(track, grip, car) {
  car = car || {};
  const { n, kappa, ds } = track, vTop = car.vTop || 78, aLat = 1.9 * G * grip, aBrk = 1.6 * G * grip;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(kappa[i]);
    if (k <= 1e-6) { v[i] = vTop; continue; }
    const v0 = Math.sqrt(aLat / k), scale = v0 < 28 ? (car.slowGrip || 1) : v0 > 45 ? (car.fastGrip || 1) : 1;
    v[i] = Math.min(vTop, Math.sqrt(aLat * scale / k));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) { const p = v[(i - 1 + n) % n], acc = 6.5 * (1 - p / (vTop + 17)); v[i] = Math.min(v[i], Math.sqrt(p * p + 2 * acc * ds)); }
    for (let i = n - 1; i >= 0; i--) { const q = v[(i + 1) % n]; v[i] = Math.min(v[i], Math.sqrt(q * q + 2 * aBrk * ds)); }
  }
  return v;
}

/* Drive `laps` complete laps plus a part lap before and after.
   opts.understeer adds extra steering near the limit in the slow corners.
   Returns samples at `hz` plus the true lap times. */
function drive(opts) {
  opts = Object.assign({ laps: 3, hz: 60, understeer: 0, grips: [1.0, 0.985, 1.01, 0.97, 1.0] }, opts);
  const track = buildTrack(), { n, ds, kappa, length } = track;
  // position of every track point
  const X = new Float64Array(n + 1), Y = new Float64Array(n + 1); let th = 0;
  for (let i = 0; i < n; i++) { th += kappa[i] * ds; X[i + 1] = X[i] + Math.cos(th) * ds; Y[i + 1] = Y[i] + Math.sin(th) * ds; }

  const startAt = Math.round(0.7 * n), totalPts = Math.round((opts.laps + 0.55) * n);
  const out = { t: [], dist: [], lap: [], v: [], kap: [], x: [], y: [], ax: [], lastLap: [] };
  const trueLaps = [], cross = [];
  let t = 0, nextSample = 0, lapNo = 0, lapStartT = null, lastLapTime = 0, lastLapShownAt = Infinity, shown = 0;
  let prof = speedProfile(track, opts.grips[0], opts);
  for (let p = 0; p < totalPts; p++) {
    const i = (startAt + p) % n, i2 = (i + 1) % n;
    if (i === 0 && p > 0) {
      if (lapStartT != null) { trueLaps.push(t - lapStartT); lastLapTime = t - lapStartT; lastLapShownAt = t + 1.2; }
      cross.push(t); lapStartT = t; lapNo++;
      prof = speedProfile(track, opts.grips[lapNo % opts.grips.length], opts);
    }
    const v0 = Math.max(5, prof[i]), v1 = Math.max(5, prof[i2]), dt = ds / ((v0 + v1) / 2);
    while (nextSample <= t + dt) {
      const f = (nextSample - t) / dt, v = v0 + (v1 - v0) * f;
      out.t.push(nextSample); out.dist.push(i * ds + f * ds); out.lap.push(lapNo); out.v.push(v);
      out.kap.push(kappa[i] + (kappa[i2] - kappa[i]) * f);
      out.x.push(X[i] + (X[i + 1] - X[i]) * f); out.y.push(Y[i] + (Y[i + 1] - Y[i]) * f);
      out.ax.push((v1 * v1 - v0 * v0) / (2 * ds));
      if (nextSample >= lastLapShownAt) shown = lastLapTime; // the sim posts the lap time a moment after the line
      out.lastLap.push(shown);
      nextSample += 1 / opts.hz;
    }
    t += dt;
  }
  const m = out.t.length, K = 2.7 * 14 * (180 / Math.PI), C = 6; // deg per (1/m), deg per g
  const steer = new Float64Array(m), latG = new Float64Array(m), thr = new Float64Array(m), brk = new Float64Array(m), gear = new Int32Array(m), rpm = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const a = (out.v[j] * out.v[j] * out.kap[j]) / G;
    latG[j] = a;
    let s = K * out.kap[j] + C * a;
    if (opts.understeer && out.v[j] < 28) s += Math.sign(a) * opts.understeer * 80 * Math.pow(Math.min(1, Math.abs(a) / 1.9), 4);
    steer[j] = s;
    thr[j] = out.ax[j] > 0.3 ? 1 : out.ax[j] > -0.5 ? 0.35 : 0;
    brk[j] = out.ax[j] < -1 ? Math.min(1, -out.ax[j] / (1.6 * G)) : 0;
    gear[j] = Math.max(1, Math.min(6, 1 + Math.floor(out.v[j] / 14)));
    rpm[j] = 3500 + ((out.v[j] % 14) / 14) * 4000;
  }
  return { track, hz: opts.hz, n: m, t: out.t, dist: out.dist, lap: out.lap, speed: out.v, x: out.x, y: out.y, longAccel: out.ax, latG, steer, thr, brk, gear, rpm,
    lastLap: out.lastLap, trueLaps, cross, length };
}

module.exports = { G, buildTrack, speedProfile, drive };
