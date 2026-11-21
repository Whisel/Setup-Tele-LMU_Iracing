'use strict';
/* Writes a ".lmulaps" file (the format of recorder/lmu-recorder.ps1) from a simulated run,
   so the app's reader can be tested without PowerShell or the game. */
const COLS = ['Ground Speed', 'Throttle Pos Unfiltered', 'Throttle Pos', 'Brake Pos', 'Clutch Pos', 'Steering Pos', 'Engine RPM', 'G Force Lat', 'G Force Long', 'G Force Vert',
  'Pos X', 'Pos Y', 'Local Vel Forward', 'Local Vel Lateral', 'Yaw Rate', 'Fuel Level', 'FrontRideHeight', 'RearRideHeight', 'Front3rdDeflection', 'Rear3rdDeflection', 'Gear', 'ABS', 'TC', 'Path Lateral'];
const WHEEL_COLS = ['Wheel Speed', 'TyresPressure', 'TyresTempLeft', 'TyresTempCentre', 'TyresTempRight', 'TyresCarcassTemp', 'Tyres Wear', 'Brakes Temp', 'RideHeights', 'Susp Pos'];

function makeLmuLaps(run, extra) {
  extra = extra || {};
  const n = run.n, G = 9.80665, t0 = 100; // the game's clock is well past zero when a run starts
  const col = {
    'Ground Speed': (j) => run.speed[j] * 3.6, 'Throttle Pos Unfiltered': (j) => run.thr[j] * 100, 'Throttle Pos': (j) => run.thr[j] * 100, 'Brake Pos': (j) => run.brk[j] * 100,
    'Steering Pos': (j) => run.steer[j] / 4, 'Engine RPM': (j) => run.rpm[j], 'G Force Lat': (j) => run.latG[j], 'G Force Long': (j) => run.longAccel[j] / G,
    'Pos X': (j) => run.x[j], 'Pos Y': (j) => run.y[j], 'Local Vel Forward': (j) => run.velX[j], 'Local Vel Lateral': (j) => run.velY[j], 'Yaw Rate': (j) => run.yawRate[j],
    'Fuel Level': (j) => 60 - run.t[j] * 0.01, FrontRideHeight: () => 0.05, RearRideHeight: () => 0.07, Gear: (j) => run.gear[j],
  };
  const wheel = { 'Wheel Speed': (j) => run.speed[j], TyresPressure: () => 165, TyresTempLeft: () => 80, TyresTempCentre: () => 85, TyresTempRight: () => 82, TyresCarcassTemp: () => 78,
    'Tyres Wear': () => 98, 'Brakes Temp': () => 400, RideHeights: () => 0.05, 'Susp Pos': () => 0.07 };
  // the setup block: an object is written as the game would send it; a string is written as it is (to test bad replies)
  const block = Buffer.from(extra.setup == null ? '' : typeof extra.setup === 'string' ? extra.setup : JSON.stringify(extra.setup), 'utf8');
  const ts = [], num = [], time = [];
  for (let j = 1; j < n; j++) if (run.lap[j] !== run.lap[j - 1]) { ts.push(t0 + run.t[j]); num.push(run.lap[j]); time.push(ts.length > 1 ? ts[ts.length - 1] - ts[ts.length - 2] : 0); }
  const head = Buffer.from(JSON.stringify({
    format: 'sta-lmu-live', version: 1, recorder: 'test', hz: run.hz, n, tStart: t0 + run.t[0], tEnd: t0 + run.t[n - 1], cols: COLS, wheelCols: WHEEL_COLS,
    meta: Object.assign({ TrackName: 'Test Ring', TrackLayout: 'Test Ring', CarName: 'Test GT3 #1', CarClass: 'GT3', DriverName: 'Tester', SessionType: 'Practice',
      RecordingTime: '2026-11-19T20_00_00Z', TrackLength: Math.round(run.length), MaxRpm: 9000 }, extra.meta || {}),
    laps: { ts, num, time, s1: time.map((x) => x * 0.3), s2: time.map((x) => x * 0.65) },
    setupLength: block.length, setupNote: extra.setupNote || '',
  }), 'utf8');
  const pad = (8 - ((12 + head.length + block.length) % 8)) % 8, blocks = COLS.length + WHEEL_COLS.length * 4;
  const out = Buffer.alloc(12 + head.length + block.length + pad + n * 8 + blocks * n * 4);
  out.write('STALMU01', 0, 'ascii'); out.writeInt32LE(head.length, 8); head.copy(out, 12); block.copy(out, 12 + head.length);
  let at = 12 + head.length + block.length + pad;
  for (let j = 0; j < n; j++) { out.writeDoubleLE(t0 + run.t[j], at); at += 8; }
  const put = (fn) => { for (let j = 0; j < n; j++) { out.writeFloatLE(fn ? fn(j) : 0, at); at += 4; } };
  for (const name of COLS) put(col[name]);
  for (const name of WHEEL_COLS) for (let k = 0; k < 4; k++) put(wheel[name]);
  return out;
}

module.exports = { makeLmuLaps, COLS, WHEEL_COLS };
