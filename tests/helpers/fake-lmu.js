/* Presents a simulated run as the tables of an LMU .duckdb recording, answering
   the exact queries STA.lmu.read() sends. Rates and quirks mirror the real files:
   pedals at 50 Hz, GPS at 10 Hz, change-only event tables, a clock gap at the
   start, and lateral/longitudinal G stored under each other's names with the
   sign flipped. */
const { G } = require('./sim.js');

function fakeLmuDb(run, opts) {
  opts = opts || {};
  const hz = run.hz, t0 = 0.0825;
  const every = (step) => { const idx = []; for (let j = 0; j < run.n; j += step) idx.push(j); return idx; };
  const col = (step, fn) => Float32Array.from(every(step), fn);
  const R = 6371000, k = 180 / Math.PI;
  const tables = {
    'GPS Time': { v: Float64Array.from(every(1), (j) => (j === 0 ? t0 : t0 + 0.4 + run.t[j])) }, // gap after the first sample, like the game
    'Ground Speed': { v: col(1, (j) => run.speed[j] * 3.6) },
    'Engine RPM': { v: col(1, (j) => run.rpm[j]) },
    'Steering Pos': { v: col(1, (j) => run.steer[j] / 2.6) }, // percent of lock
    'Throttle Pos': { v: col(2, (j) => run.thr[j] * 100) },
    'Throttle Pos Unfiltered': { v: col(2, (j) => run.thr[j] * 100) },
    'Brake Pos': { v: col(2, (j) => run.brk[j] * 100) },
    'G Force Lat': { v: col(10, (j) => -run.longAccel[j] / G) },
    'G Force Long': { v: col(10, (j) => -run.latG[j]) },
    'GPS Latitude': { v: col(10, (j) => 60 + (run.y[j] / R) * k) },
    'GPS Longitude': { v: col(10, (j) => (run.x[j] / (R * Math.cos(60 / k))) * k) },
    'Lap Dist': { v: col(10, (j) => run.dist[j]) },
    'Wheel Speed': { w: [0, 1, 2, 3].map(() => col(1, (j) => run.speed[j])) },
    'TyresTempLeft': { w: [70, 82, 68, 80].map((v) => col(1, () => v)) },
    'TyresTempCentre': { w: [78, 78, 75, 75].map((v) => col(1, () => v)) },
    'TyresTempRight': { w: [82, 70, 80, 68].map((v) => col(1, () => v)) },
  };
  const clock = (j) => t0 + 0.4 + run.t[j];
  const gearTs = [t0], gearV = [run.gear[0]];
  for (let j = 1; j < run.n; j++) if (run.gear[j] !== run.gear[j - 1]) { gearTs.push(clock(j)); gearV.push(run.gear[j]); }
  const crossTs = run.cross.map((c) => t0 + 0.4 + c);
  const events = {
    Gear: { ts: gearTs, v: gearV },
    Lap: { ts: [t0].concat(crossTs), v: [0].concat(crossTs.map((_, i) => i + 1)) },
    'Lap Time': { ts: [t0].concat(crossTs), v: [0].concat(crossTs.map((_, i) => (i === 0 ? 77.7 : opts.invalidLap === i ? 0 : run.trueLaps[i - 1]))) },
    'Engine Max RPM': { ts: [t0], v: [7500] },
  };
  const setup = opts.carSetup || {
    VM_REAR_WING: { available: true, value: 9, minValue: 0, maxValue: 12, stringValue: '3.3 deg' },
    VM_FRONT_ANTISWAY: { available: true, value: 4, minValue: 0, maxValue: 11, stringValue: 'P4' },
    VM_REAR_ANTISWAY: { available: true, value: 1, minValue: 0, maxValue: 11, stringValue: 'P1 (soft)' },
    VM_BRAKE_BALANCE: { available: true, value: 22, minValue: 0, maxValue: 57, stringValue: '51.5:48.5' },
    VM_DIFF_PRELOAD: { available: true, value: 0, minValue: 0, maxValue: 1, stringValue: 'Non-adjustable' },
    'WM_CAMBER-W_FL': { available: true, value: 25, minValue: 0, maxValue: 41, stringValue: '-2.50 deg' },
    'WM_CAMBER-W_FR': { available: true, value: 25, minValue: 0, maxValue: 41, stringValue: '-2.50 deg' },
    'WM_PRESSURE-W_RL': { available: true, value: 0, minValue: 0, maxValue: 75, stringValue: '136 kPa' },
    'WM_PRESSURE-W_RR': { available: true, value: 0, minValue: 0, maxValue: 75, stringValue: '136 kPa' },
    VM_UNUSED: { available: false, value: 0, minValue: 0, maxValue: 1, stringValue: 'N/A' },
    available: true,
  };
  const metadata = { TrackName: 'Test Ring', TrackLayout: 'Test Ring', CarName: 'Team Test #1', CarClass: 'GT3', DriverName: 'Test Driver',
    SessionType: 'Practice', RecordingTime: '2026-07-15T18_42_49Z', CarSetup: JSON.stringify(setup) };
  const names = Object.keys(tables).concat(Object.keys(events), ['metadata', 'channelsList', 'eventsList']);
  const tableOf = (sql) => { const m = /FROM "((?:[^"]|"")+)"/.exec(sql); return m ? m[1] : null; };
  return {
    rows: async (sql) => {
      if (/information_schema/.test(sql)) return names.map((name) => ({ name }));
      if (/FROM metadata/.test(sql)) return Object.keys(metadata).map((key) => ({ key, value: metadata[key] }));
      if (/FROM channelsList/.test(sql)) return [{ channelName: 'Ground Speed', frequency: hz, unit: 'km/h' }];
      throw new Error('unexpected query: ' + sql);
    },
    cols: async (sql) => {
      const name = tableOf(sql);
      if (/CAST\(ts AS DOUBLE\)/.test(sql)) return { ts: Float64Array.from(events[name].ts), v: Float64Array.from(events[name].v) };
      if (/value1/.test(sql)) { const w = tables[name].w; return { v1: w[0], v2: w[1], v3: w[2], v4: w[3] }; }
      if (!tables[name]) throw new Error('unexpected table: ' + name);
      return { v: tables[name].v };
    },
  };
}

module.exports = { fakeLmuDb };
