/* Le Mans Ultimate native telemetry reader (.duckdb files from UserData\Telemetry).

   The file is a DuckDB database with one table per channel:
     continuous channel : column `value` (or value1..value4 per wheel, FL FR RL RR),
                          no timestamps - row position implies time
     event channel      : columns `ts`, `value` (or value1..4), written on change
   plus `channelsList`, `eventsList` and a key/value `metadata` table whose
   `CarSetup` entry is a JSON copy of the setup that was on the car.

   `GPS Time` is a 100 Hz clock on the same time axis as the event `ts` column,
   so it is used to give every continuous row a real timestamp. That keeps the
   channels aligned even when a channel's true rate differs from its declared
   rate or the game stalls for a moment.

   This module only needs a tiny database interface so it can be driven by
   duckdb-wasm in the browser or anything else in tests:
     db.rows(sql) -> Promise<Array<object>>
     db.cols(sql) -> Promise<{ [column]: TypedArray }>            */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

  const CONTINUOUS = ['Ground Speed', 'GPS Speed', 'Throttle Pos', 'Throttle Pos Unfiltered', 'Brake Pos', 'Clutch Pos', 'Steering Pos', 'Engine RPM',
    'G Force Lat', 'G Force Long', 'G Force Vert', 'GPS Latitude', 'GPS Longitude', 'Lap Dist', 'Path Lateral', 'Track Edge',
    'Fuel Level', 'Virtual Energy', 'SoC', 'FrontRideHeight', 'RearRideHeight', 'Front3rdDeflection', 'Rear3rdDeflection',
    'TC', 'Track Temperature', 'Ambient Temperature'];
  const WHEEL = ['Wheel Speed', 'TyresPressure', 'TyresTempLeft', 'TyresTempCentre', 'TyresTempRight', 'TyresCarcassTemp',
    'Tyres Wear', 'Brakes Temp', 'RideHeights', 'Susp Pos'];
  const EVENTS = ['Lap', 'Lap Time', 'Last Sector1', 'Last Sector2', 'Gear', 'In Pits', 'ABS', 'Engine Max RPM',
    'Brake Bias Rear', 'TCLevel', 'ABSLevel', 'Speed Limiter'];

  async function read(db, opts) {
    opts = opts || {};
    const progress = opts.onProgress || function () {};
    const tableRows = await db.rows("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = current_database()");
    const tables = new Set(tableRows.map((r) => String(r.name)));
    if (!tables.has('metadata') || !tables.has('GPS Time')) {
      throw new Error('This DuckDB file does not look like a Le Mans Ultimate telemetry recording (no metadata / GPS Time table).');
    }

    const meta = {};
    for (const r of await db.rows('SELECT key, value FROM metadata')) meta[String(r.key)] = r.value == null ? '' : String(r.value);

    const units = {};
    if (tables.has('channelsList')) {
      for (const r of await db.rows('SELECT * FROM channelsList')) {
        const name = r.channelName != null ? r.channelName : r.name;
        units[String(name)] = { unit: r.unit || '', freq: Number(r.frequency) || 0 };
      }
    }

    const gps = (await db.cols('SELECT CAST(value AS DOUBLE) AS v FROM ' + q('GPS Time'))).v;
    if (!gps || gps.length < 10) throw new Error('The recording is empty (no GPS Time samples).');
    const nGps = gps.length;

    /* Timestamp of row i in a channel that has n rows. */
    function rowTimes(n) {
      const t = new Float64Array(n);
      if (n === nGps) { t.set(gps); return t; }
      const k = n > 1 ? (nGps - 1) / (n - 1) : 0;
      for (let i = 0; i < n; i++) {
        const p = i * k, a = Math.floor(p), b = Math.min(nGps - 1, a + 1);
        t[i] = gps[a] + (gps[b] - gps[a]) * (p - a);
      }
      return t;
    }

    const out = { meta, units, tStart: gps[0], tEnd: gps[nGps - 1], gpsTime: gps, cont: {}, wheel: {}, events: {}, tables: Array.from(tables), warnings: [] };

    // Detect stalls: gaps in the 100 Hz clock well above its period.
    let gaps = 0, worst = 0;
    for (let i = 1; i < nGps; i++) { const d = gps[i] - gps[i - 1]; if (d > 0.25) { gaps++; if (d > worst) worst = d; } }
    if (gaps > 1) out.warnings.push(gaps + ' gaps in the recording clock (longest ' + worst.toFixed(2) + ' s). Channels were re-aligned to the clock, but data inside the gaps is interpolated.');

    const todo = CONTINUOUS.filter((c) => tables.has(c)).length + WHEEL.filter((c) => tables.has(c)).length + EVENTS.filter((c) => tables.has(c)).length;
    let done = 0;
    const tick = () => progress(++done / todo);

    for (const name of CONTINUOUS) {
      if (!tables.has(name)) continue;
      const c = await db.cols('SELECT CAST(value AS FLOAT) AS v FROM ' + q(name));
      out.cont[name] = { t: rowTimes(c.v.length), v: c.v };
      tick();
    }
    for (const name of WHEEL) {
      if (!tables.has(name)) continue;
      const c = await db.cols('SELECT CAST(value1 AS FLOAT) AS v1, CAST(value2 AS FLOAT) AS v2, CAST(value3 AS FLOAT) AS v3, CAST(value4 AS FLOAT) AS v4 FROM ' + q(name));
      out.wheel[name] = { t: rowTimes(c.v1.length), v: [c.v1, c.v2, c.v3, c.v4] };
      tick();
    }
    for (const name of EVENTS) {
      if (!tables.has(name)) continue;
      const c = await db.cols('SELECT CAST(ts AS DOUBLE) AS ts, CAST(value AS DOUBLE) AS v FROM ' + q(name) + ' ORDER BY ts');
      out.events[name] = { ts: c.ts, v: c.v };
      tick();
    }
    return out;
  }

  /* Read only what is needed to list a recording: metadata and the setup. */
  async function readMeta(db) {
    const meta = {};
    for (const r of await db.rows('SELECT key, value FROM metadata')) meta[String(r.key)] = r.value == null ? '' : String(r.value);
    return meta;
  }

  STA.lmu = { read, readMeta, CONTINUOUS, WHEEL, EVENTS };
})(typeof window !== 'undefined' ? window : globalThis);
