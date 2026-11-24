/* One telemetry recording from either sim, in a common shape.

   session.ch holds time-series arrays on one time base (session.hz):
     t, distU (lap distance, unwrapped), speed (m/s), throttle, brake (0..1),
     steer, gear, rpm, latG, longG, vertG, lat, lon, x, y (metres), onPit ...
   Per-wheel channels are arrays of four arrays in the order FL, FR, RL, RR.

   Sign conventions after finalize(): latG > 0 and steer > 0 mean turning left,
   longG > 0 means accelerating.

   session.laps describe each lap; lapGrid() resamples a lap onto a fixed
   distance grid (about 1 m) so laps can be compared point for point. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, G = STA.G;

  const IBT_WANT = ['SessionTime', 'Lap', 'LapDist', 'LapDistPct', 'LapLastLapTime', 'LapCurrentLapTime', 'Speed', 'Throttle',
    'Brake', 'ThrottleRaw', 'Clutch', 'SteeringWheelAngle', 'Gear', 'RPM', 'LatAccel', 'LongAccel', 'VertAccel', 'YawRate', 'YawNorth', 'VelocityX', 'VelocityY',
    'Lat', 'Lon', 'Alt', 'OnPitRoad', 'IsOnTrack', 'FuelLevel', 'BrakeABSactive', 'CFSRrideHeight', 'TrackTempCrew', 'AirTemp',
    'dcBrakeBias', 'dcTractionControl', 'dcABS'];
  for (const w of ['LF', 'RF', 'LR', 'RR']) {
    for (const s of ['speed', 'pressure', 'tempL', 'tempM', 'tempR', 'tempCL', 'tempCM', 'tempCR', 'rideHeight', 'shockDefl', 'wearL', 'wearM', 'wearR']) IBT_WANT.push(w + s);
  }

  /* ---------- iRacing ---------- */

  function fromIbt(ibt, file) {
    const v = (name) => (ibt.vars[name] ? ibt.vars[name].data : null);
    const n = ibt.n, hz = ibt.tickRate;
    if (!n || !v('Speed')) throw new Error('This .ibt file has no telemetry samples.');
    const info = ibt.sessionInfo || {}, wk = info.WeekendInfo || {}, di = info.DriverInfo || {};
    const idx = parseInt(di.DriverCarIdx, 10);
    const drv = (di.Drivers || []).find((d) => parseInt(d.CarIdx, 10) === idx) || (di.Drivers || [])[0] || {};

    const t = new Float64Array(n);
    const st = v('SessionTime');
    for (let i = 0; i < n; i++) t[i] = st ? st[i] : i / hz;

    const scale = (a, k) => { if (!a) return null; const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * k; return o; };
    const f32 = (a) => (a ? Float32Array.from(a) : null);
    const four = (suffix, k) => {
      const arr = ['LF', 'RF', 'LR', 'RR'].map((w) => (k ? scale(v(w + suffix), k) : f32(v(w + suffix))));
      return arr.every(Boolean) ? arr : null;
    };
    /* Tyre temperatures: on the left side of the car the tyre's left edge is the
       outer edge; on the right side it is the inner edge. Prefer carcass temps. */
    const temps = (pos) => {
      const pick = (w, side) => f32(v(w + 'tempC' + side)) || f32(v(w + 'temp' + side));
      const map = { I: { LF: 'R', RF: 'L', LR: 'R', RR: 'L' }, M: { LF: 'M', RF: 'M', LR: 'M', RR: 'M' }, O: { LF: 'L', RF: 'R', LR: 'L', RR: 'R' } }[pos];
      const arr = ['LF', 'RF', 'LR', 'RR'].map((w) => pick(w, map[w]));
      return arr.every(Boolean) ? arr : null;
    };

    const ch = {
      t, speed: f32(v('Speed')), throttle: f32(v('Throttle')), throttleRaw: f32(v('ThrottleRaw')), brake: f32(v('Brake')), clutch: f32(v('Clutch')),
      steer: scale(v('SteeringWheelAngle'), 180 / Math.PI), gear: f32(v('Gear')), rpm: f32(v('RPM')),
      latG: scale(v('LatAccel'), 1 / G), longG: scale(v('LongAccel'), 1 / G), vertG: scale(v('VertAccel'), 1 / G),
      yawRate: f32(v('YawRate')), yawNorth: f32(v('YawNorth')), lat: v('Lat'), lon: v('Lon'), alt: f32(v('Alt')),
      velX: f32(v('VelocityX')), velY: f32(v('VelocityY')),
      onPit: f32(v('OnPitRoad')), fuel: f32(v('FuelLevel')), abs: f32(v('BrakeABSactive')), lapNo: f32(v('Lap')),
      wheelSpeed: four('speed'), tyrePress: four('pressure'), tyreTempI: temps('I'), tyreTempM: temps('M'), tyreTempO: temps('O'),
      rideH: four('rideHeight'), suspPos: four('shockDefl'),
    };

    // Unwrap LapDist into a continuous distance; note discontinuities (tow, reset).
    const ld = v('LapDist'), lapNo = v('Lap'), spd = ch.speed;
    const distU = new Float64Array(n), breaks = [], marks = [];
    let offset = 0;
    const lastLap = v('LapLastLapTime');
    for (let i = 0; i < n; i++) {
      if (i > 0 && ld) {
        const dt = t[i] - t[i - 1] > 0 ? t[i] - t[i - 1] : 1 / hz;
        const expect = spd[i] * dt, step = ld[i] - ld[i - 1];
        const lapUp = lapNo && lapNo[i] > lapNo[i - 1];
        if (lapUp || step < -200) {
          // Start/finish crossing: keep distance continuous across the reset.
          offset += ld[i - 1] + expect - ld[i];
          const frac = expect > 1e-6 ? U.clamp(1 - ld[i] / expect, 0, 1) : 1;
          marks.push({ i, tCross: t[i - 1] + frac * dt, d: 0, num: lapNo ? lapNo[i] : marks.length + 1 });
        } else if (Math.abs(step - expect) > 60) {
          offset += ld[i - 1] + expect - ld[i];
          breaks.push(i);
        }
      }
      distU[i] = (ld ? ld[i] : 0) + offset;
    }
    // d at a crossing is the unwrapped distance of the line itself.
    for (const m of marks) m.d = distU[m.i] - ld[m.i];
    // Official lap time: LapLastLapTime changes shortly after the crossing.
    if (lastLap) {
      for (const m of marks) {
        const before = lastLap[Math.max(0, m.i - 1)], lim = Math.min(n - 1, m.i + Math.round(6 * hz));
        let val = null;
        for (let k = m.i; k <= lim; k++) if (lastLap[k] !== before) { val = lastLap[k]; break; }
        m.official = val;
      }
    }
    ch.distU = distU;

    const trackLen = parseFloat(wk.TrackLength) * 1000 || null;
    const sessionNum = 0;
    const sessType = (((info.SessionInfo || {}).Sessions || [])[sessionNum] || {}).SessionType || wk.EventType || '';
    const meta = {
      sim: 'iracing', fileName: file ? file.name : '', track: wk.TrackDisplayName || wk.TrackName || 'Unknown track',
      trackConfig: wk.TrackConfigName && wk.TrackConfigName !== 'N/A' ? wk.TrackConfigName : '',
      car: drv.CarScreenName || drv.CarPath || 'Unknown car', carClass: drv.CarClassShortName || '', driver: drv.UserName || '',
      sessionType: sessType, recordedAt: ibt.header.startDate ? ibt.header.startDate * 1000 : (file && file.lastModified) || Date.now(),
      trackLenHint: trackLen, maxRpm: parseFloat(di.DriverCarRedLine) || null, steerUnit: 'deg',
      setupName: di.DriverSetupName || '', airTemp: wk.TrackAirTemp || '', trackTemp: wk.TrackSurfaceTemp || '',
      tyreNote: 'iRacing only refreshes tyre temperature, pressure and wear readings when the car is in the pits, so tyre values reflect the end of a run.',
    };
    const setup = info.CarSetup ? STA.setup.fromIracing(info.CarSetup, {
      car: meta.car, carClass: meta.carClass, track: trackName(meta), name: cleanSetupName(meta.setupName) || runName(meta.recordedAt),
    }) : null;
    return finalize({ meta, hz, n, ch, marks, breaks, setup, warnings: setup ? [] : ['This recording holds no setup, so the Setup advice tab is hidden for it.'] });
  }

  /* Name for a setup that only exists inside a telemetry file. */
  function runName(ms) {
    const d = new Date(ms), p2 = (v) => String(v).padStart(2, '0');
    return isNaN(d) ? 'Driven setup' : 'Driven ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function cleanSetupName(s) { return String(s || '').replace(/\.sto$/i, '').trim(); }
  function trackName(meta) { return meta.track + (meta.trackConfig ? ' – ' + meta.trackConfig : ''); }

  /* ---------- Le Mans Ultimate ---------- */

  function fromLmu(lmu, file) {
    const hz = 50, n = Math.max(2, Math.floor((lmu.tEnd - lmu.tStart) * hz) + 1);
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = lmu.tStart + i / hz;
    const c = (name, k, mode, Type) => {
      const s = lmu.cont[name]; if (!s) return null;
      const o = Type ? U.interp(s.t, s.v, t, mode, Type) : U.interp(s.t, s.v, t, mode);
      if (k && k !== 1) for (let i = 0; i < n; i++) o[i] *= k;
      return o;
    };
    const w = (name, k) => {
      const s = lmu.wheel[name]; if (!s) return null;
      return s.v.map((arr) => { const o = U.interp(s.t, arr, t); if (k && k !== 1) for (let i = 0; i < n; i++) o[i] *= k; return o; });
    };
    const ev = (name, dflt) => { const e = lmu.events[name]; return e ? U.stepEvents(e.ts, e.v, t, dflt) : null; };
    const pickSides = (L, R) => (L && R ? [R[0], L[1], R[2], L[3]] : null); // inner edge: right for left-side tyres

    const tl = w('TyresTempLeft'), tr = w('TyresTempRight');
    const ch = {
      t, speed: c('Ground Speed', 1 / 3.6), throttle: c('Throttle Pos Unfiltered', 0.01) || c('Throttle Pos', 0.01), throttleEcu: c('Throttle Pos', 0.01),
      brake: c('Brake Pos', 0.01), clutch: c('Clutch Pos', 0.01),
      steer: c('Steering Pos'), gear: ev('Gear', 0), rpm: c('Engine RPM'),
      latG: c('G Force Lat'), longG: c('G Force Long'), vertG: c('G Force Vert'),
      lat: c('GPS Latitude', 1, null), lon: c('GPS Longitude', 1, null),
      onPit: ev('In Pits', 0), fuel: c('Fuel Level'), abs: ev('ABS', 0), tc: c('TC', 1, 'step'), lapNo: ev('Lap', 0),
      wheelSpeed: w('Wheel Speed'), tyrePress: w('TyresPressure'), tyreTempI: pickSides(tl, tr), tyreTempM: w('TyresTempCentre'),
      tyreTempO: tl && tr ? [tl[0], tr[1], tl[2], tr[3]] : null, tyreCarcass: w('TyresCarcassTemp'), tyreWear: w('Tyres Wear'),
      brakeTemp: w('Brakes Temp'), rideH: w('RideHeights'), suspPos: w('Susp Pos'),
      rideF: c('FrontRideHeight'), rideR: c('RearRideHeight'), pathLat: c('Path Lateral'),
      // only in runs saved by the live lap recorder
      velX: c('Local Vel Forward'), velY: c('Local Vel Lateral'), yawRate: c('Yaw Rate'),
    };
    const px = c('Pos X', 1, null, Float64Array), py = c('Pos Y', 1, null, Float64Array);
    if (px && py) { ch.x = px; ch.y = py; const pz = c('Pos Height', 1, null, Float64Array); if (pz) ch.z = pz; }
    if (!ch.speed) throw new Error('The recording has no Ground Speed channel.');

    // Unwrap the 10 Hz Lap Dist before interpolating, so the reset at the line does not smear.
    const ld = lmu.cont['Lap Dist'];
    const breaks = [];
    if (ld) {
      const m = ld.v.length, un = new Float64Array(m);
      let offset = 0;
      for (let i = 0; i < m; i++) {
        if (i > 0) {
          const prevStep = i > 1 ? Math.max(0, ld.v[i - 1] - ld.v[i - 2]) : 0;
          if (ld.v[i] < ld.v[i - 1] - 200) offset += ld.v[i - 1] + prevStep - ld.v[i];
        }
        un[i] = ld.v[i] + offset;
      }
      ch.distU = U.interp(ld.t, un, t, null, Float64Array);
    } else {
      ch.distU = new Float64Array(n);
      for (let i = 1; i < n; i++) ch.distU[i] = ch.distU[i - 1] + ch.speed[i] / hz;
    }

    const marks = [];
    const lapEv = lmu.events['Lap'], lapTimeEv = lmu.events['Lap Time'], s1 = lmu.events['Last Sector1'], s2 = lmu.events['Last Sector2'];
    const at = (e, ts) => { if (!e) return null; for (let k = 0; k < e.ts.length; k++) if (Math.abs(e.ts[k] - ts) < 0.011) return e.v[k]; return null; };
    if (lapEv) {
      for (let k = 0; k < lapEv.ts.length; k++) {
        const ts = lapEv.ts[k];
        if (ts <= lmu.tStart + 0.05) continue; // the first row is the state when recording began, not a crossing
        const i = Math.min(n - 1, Math.max(1, Math.ceil((ts - lmu.tStart) * hz)));
        const f = (ts - t[i - 1]) * hz;
        marks.push({ i, tCross: ts, d: ch.distU[i - 1] + (ch.distU[i] - ch.distU[i - 1]) * U.clamp(f, 0, 1), num: lapEv.v[k],
          official: at(lapTimeEv, ts), s1: at(s1, ts), s2: at(s2, ts) });
      }
    }

    const mt = lmu.meta;
    const maxRpmEv = lmu.events['Engine Max RPM'];
    const meta = {
      sim: 'lmu', fileName: file ? file.name : '', track: mt.TrackName || 'Unknown track',
      trackConfig: mt.TrackLayout && mt.TrackLayout !== mt.TrackName ? mt.TrackLayout : '',
      car: mt.CarName || 'Unknown car', carClass: mt.CarClass || '', driver: mt.DriverName || '', sessionType: mt.SessionType || '',
      recordedAt: Date.parse(String(mt.RecordingTime || '').replace(/_/g, ':')) || (file && file.lastModified) || Date.now(),
      trackLenHint: null, maxRpm: maxRpmEv && maxRpmEv.v.length ? maxRpmEv.v[maxRpmEv.v.length - 1] : null, steerUnit: '% lock',
      setupName: '', weather: mt.WeatherConditions || '', live: !!mt.Live,
    };
    let setup = null;
    if (mt.CarSetup) {
      try {
        setup = STA.setup.fromLmuJson(mt.CarSetup, { car: meta.car, carClass: meta.carClass, track: trackName(meta), name: runName(meta.recordedAt) });
      } catch (e) { /* setup stays null; reported below */ }
    }
    const warnings = (lmu.warnings || []).slice();
    if (mt.CarSetup && !setup) warnings.push('The setup stored in this recording could not be read, so the Setup advice tab is hidden for it.');
    if (!mt.CarSetup && !mt.Live) warnings.push('This recording holds no setup, so the Setup advice tab is hidden for it.');
    return finalize({ meta, hz, n, ch, marks, breaks, setup, warnings, lmuSmoothGps: !mt.Live });
  }

  /* ---------- shared processing ---------- */

  function finalize(s) {
    const ch = s.ch, n = s.n, hz = s.hz;
    s.id = 'sess-' + U.hash([s.meta.sim, s.meta.fileName, s.meta.recordedAt, n].join('|'));
    s.trackName = trackName(s.meta);
    s._grids = new Map();

    // --- position in metres ---
    let haveXY = !!(ch.x && ch.y); // already in metres
    // Samples taken while the car is driving. iRacing logs latitude, longitude and altitude as zero
    // in the garage, so those samples must not set the centre of the map or the lowest point.
    const driving = (i) => ch.speed[i] > 3 && !(ch.lat && ch.lat[i] === 0 && ch.lon && ch.lon[i] === 0);
    const rangeOf = (a) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const v = a[i]; if (v === v && isFinite(v) && driving(i)) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo, hi]; };
    if (!haveXY && ch.lat && ch.lon) {
      let [la0, la1] = rangeOf(ch.lat), [lo0, lo1] = rangeOf(ch.lon);
      if (!isFinite(la0)) { [la0, la1] = U.minMax(ch.lat); [lo0, lo1] = U.minMax(ch.lon); }
      const latC = (la0 + la1) / 2, lonC = (lo0 + lo1) / 2, R = 6371000, k = Math.PI / 180;
      let x = new Float64Array(n), y = new Float64Array(n);
      for (let i = 0; i < n; i++) { x[i] = (ch.lon[i] - lonC) * k * R * Math.cos(latC * k); y[i] = (ch.lat[i] - latC) * k * R; }
      if (s.lmuSmoothGps) { const wdw = Math.round(hz * 0.3); x = U.smooth(x, wdw); y = U.smooth(y, wdw); }
      const [x0, x1] = U.minMax(x), [y0, y1] = U.minMax(y);
      if (isFinite(x0) && isFinite(y0) && (x1 - x0 > 0.5 || y1 - y0 > 0.5)) { ch.x = x; ch.y = y; haveXY = true; }
    }
    if (!haveXY && ch.yawNorth) {
      // Dead-reckon from heading and speed (drifts; only used when no position is logged).
      const x = new Float64Array(n), y = new Float64Array(n);
      for (let i = 1; i < n; i++) { x[i] = x[i - 1] + ch.speed[i] * Math.sin(ch.yawNorth[i]) / hz; y[i] = y[i - 1] + ch.speed[i] * Math.cos(ch.yawNorth[i]) / hz; }
      ch.x = x; ch.y = y; haveXY = true;
      s.warnings.push('No GPS position in this file, so the track map is estimated from heading and speed and will drift.');
    }
    if (!haveXY) s.warnings.push('No position data in this file, so the track map is unavailable.');

    // --- height in metres, used by the 3D view: iRacing's altitude, or the LMU lap recorder's height ---
    if (haveXY && !ch.z && ch.alt) ch.z = Float64Array.from(ch.alt);
    delete ch.alt;
    if (ch.z) {
      const [lo, hi] = rangeOf(ch.z);
      // A track never climbs more than about 400 m; anything else is not a height.
      if (!isFinite(lo) || hi - lo > 1000) delete ch.z;
      else { for (let i = 0; i < n; i++) ch.z[i] -= lo; s.heightRange = hi - lo; }
    }

    // --- reference accelerations from the path itself, used to sanity-check the logged ones ---
    const dv = new Float32Array(n), latGeo = new Float32Array(n);
    const hw = Math.max(1, Math.round(hz * 0.25));
    for (let i = hw; i < n - hw; i++) dv[i] = (ch.speed[i + hw] - ch.speed[i - hw]) / (2 * hw / hz) / G;
    if (haveXY) {
      const head = new Float64Array(n);
      for (let i = hw; i < n - hw; i++) head[i] = Math.atan2(ch.y[i + hw] - ch.y[i - hw], ch.x[i + hw] - ch.x[i - hw]);
      for (let i = hw + 1; i < n - hw; i++) { // unwrap
        let d = head[i] - head[i - 1];
        while (d > Math.PI) { head[i] -= 2 * Math.PI; d -= 2 * Math.PI; }
        while (d < -Math.PI) { head[i] += 2 * Math.PI; d += 2 * Math.PI; }
      }
      for (let i = 2 * hw; i < n - 2 * hw; i++) {
        const w = (head[i + hw] - head[i - hw]) / (2 * hw / hz);
        latGeo[i] = ch.speed[i] > 8 ? (ch.speed[i] * w) / G : 0;
      }
    }
    const moving = (a) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch.speed[i] > 8 ? a[i] : NaN; return o; };
    if (ch.latG && ch.longG) {
      const A = moving(ch.latG), B = moving(ch.longG), mdv = moving(dv), mgeo = moving(latGeo);
      const aLong = Math.abs(U.corr(A, mdv)), bLong = Math.abs(U.corr(B, mdv));
      const aLat = haveXY ? Math.abs(U.corr(A, mgeo)) : 1 - aLong, bLat = haveXY ? Math.abs(U.corr(B, mgeo)) : 1 - bLong;
      if (aLong > bLong + 0.2 && bLat > aLat + 0.2) {
        const tmp = ch.latG; ch.latG = ch.longG; ch.longG = tmp;
        s.notes = (s.notes || []).concat('The lateral and longitudinal G channels are labelled the other way round in this file; they were swapped after checking them against speed and the driven path.');
      }
    }
    if (!ch.longG) { ch.longG = dv; s.notes = (s.notes || []).concat('Longitudinal G is derived from speed.'); }
    if (!ch.latG) { ch.latG = latGeo; s.notes = (s.notes || []).concat('Lateral G is derived from the driven path.'); }
    const flip = (a) => { for (let i = 0; i < a.length; i++) a[i] = -a[i]; };
    if (U.corr(moving(ch.longG), moving(dv)) < 0) flip(ch.longG);
    if (haveXY && U.corr(moving(ch.latG), moving(latGeo)) < 0) flip(ch.latG);
    if (ch.steer && U.corr(moving(ch.steer), moving(ch.latG)) < 0) flip(ch.steer);
    // Yaw rate turns the same way as the cornering force. Sideways velocity (car frame) is made
    // positive toward the inside of the corner the same way: in a corner the car's centre slides
    // outward a little, so raw sideways velocity runs against lateral G.
    if (ch.yawRate && U.corr(moving(ch.yawRate), moving(ch.latG)) < 0) flip(ch.yawRate);
    if (ch.velY) { const quick = (a) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch.speed[i] > 20 ? a[i] : NaN; return o; }; if (U.corr(quick(ch.velY), quick(ch.latG)) > 0) flip(ch.velY); }

    buildLaps(s);
    summarise(s);
    return s;
  }

  function buildLaps(s) {
    const ch = s.ch, n = s.n, marks = s.marks, t = ch.t;
    const laps = [];
    const spans = [];
    for (let k = 0; k <= marks.length; k++) {
      const a = k === 0 ? null : marks[k - 1], b = k === marks.length ? null : marks[k];
      spans.push({ a, b });
    }
    // Track length = typical distance between two crossings.
    const lens = [];
    for (let k = 1; k < marks.length; k++) lens.push(marks[k].d - marks[k - 1].d);
    let L = lens.length ? U.median(lens) : null;
    if (!L || !(L > 100)) L = s.meta.trackLenHint || (U.minMax(ch.distU)[1] - U.minMax(ch.distU)[0]) || 1000;
    s.trackLen = L;

    spans.forEach((sp, k) => {
      const i0 = sp.a ? sp.a.i : 0, i1 = sp.b ? sp.b.i : n;
      if (i1 - i0 < 2) return;
      const full = !!(sp.a && sp.b);
      const lap = {
        num: sp.a ? sp.a.num : (sp.b ? sp.b.num - 1 : 0), i0, i1,
        t0: sp.a ? sp.a.tCross : t[i0], t1: sp.b ? sp.b.tCross : t[i1 - 1],
        d0: sp.a ? sp.a.d : ch.distU[i0], d1: sp.b ? sp.b.d : ch.distU[i1 - 1],
        complete: full, valid: false, pit: false, time: null, s1: null, s2: null, note: '',
      };
      // Distance that counts as zero for this lap (the start/finish line).
      lap.dBase = sp.a ? sp.a.d : sp.b ? sp.b.d - L : 0;
      const computed = lap.t1 - lap.t0;
      lap.timeComputed = computed;
      const official = sp.b ? sp.b.official : null;
      if (full) {
        const dist = lap.d1 - lap.d0;
        if (Math.abs(dist - L) > Math.max(30, 0.02 * L)) { lap.complete = false; lap.note = 'distance does not match a full lap'; }
        if (s.breaks.some((b) => b > i0 && b < i1)) { lap.complete = false; lap.note = 'car was reset or towed'; }
      } else lap.note = sp.a ? 'recording ended mid-lap' : 'recording started mid-lap';
      if (ch.onPit) {
        let pit = 0; for (let i = i0; i < i1; i += 5) if (ch.onPit[i] > 0.5) pit++;
        if (pit > 0) { lap.pit = true; lap.note = lap.note || 'pit lane'; }
      }
      if (lap.complete) {
        if (U.isNum(official) && official > 0 && Math.abs(official - computed) < 1.0) { lap.time = official; lap.valid = true; }
        else if (U.isNum(official) && official <= 0) { lap.time = computed; lap.valid = false; lap.note = lap.note || 'invalidated by the sim'; }
        else { lap.time = computed; lap.valid = true; if (U.isNum(official) && official > 0) lap.note = lap.note || 'timed from telemetry'; }
        if (sp.b && U.isNum(sp.b.s1) && sp.b.s1 > 0 && U.isNum(sp.b.s2) && sp.b.s2 > sp.b.s1) {
          lap.s1 = sp.b.s1; lap.s2 = sp.b.s2 - sp.b.s1; lap.s3 = lap.time - sp.b.s2;
        }
        if (lap.pit) lap.valid = false;
      }
      lap.idx = laps.length;
      laps.push(lap);
    });
    s.laps = laps;
    const timed = laps.filter((l) => l.complete && l.valid);
    s.bestLap = timed.length ? timed.reduce((a, b) => (b.time < a.time ? b : a)) : null;
    if (!laps.some((l) => l.complete)) s.warnings.push('No complete lap in this recording. You can still look at the data, but lap comparison and setup advice need at least one full lap.');
  }

  const GRID_SCALARS = ['speed', 'throttle', 'throttleRaw', 'brake', 'steer', 'gear', 'rpm', 'latG', 'longG', 'vertG', 'x', 'y', 'abs', 'tc', 'fuel', 'rideF', 'rideR', 'yawRate', 'clutch', 'velX', 'velY', 'z'];
  const GRID_WHEELS = ['wheelSpeed', 'tyrePress', 'tyreTempI', 'tyreTempM', 'tyreTempO', 'tyreCarcass', 'brakeTemp', 'rideH', 'suspPos'];

  /* Resample one lap onto a distance grid from 0 to track length.
     Returns { n, step, d[], t[] (elapsed seconds), <channel>[] ... }. */
  function lapGrid(s, lap) {
    if (s._grids.has(lap.idx)) { const g = s._grids.get(lap.idx); s._grids.delete(lap.idx); s._grids.set(lap.idx, g); return g; }
    const ch = s.ch, L = s.trackLen;
    const N = Math.max(50, Math.round(L)) + 1, step = L / (N - 1);
    const a = Math.max(0, lap.i0 - 1), b = Math.min(s.n, lap.i1 + 1), m = b - a;
    const span = lap.complete ? (lap.d1 - lap.d0) : L, kd = span > 0 ? L / span : 1;
    const xs = new Float64Array(m), el = new Float64Array(m);
    let prev = -Infinity;
    for (let i = 0; i < m; i++) {
      let d = (ch.distU[a + i] - lap.dBase) * kd;
      if (d < prev) d = prev; prev = d;
      xs[i] = d; el[i] = ch.t[a + i] - lap.t0;
    }
    const grid = new Float64Array(N);
    for (let k = 0; k < N; k++) grid[k] = k * step;
    const g = { n: N, step, d: grid, lapIdx: lap.idx, dMin: xs[0], dMax: xs[m - 1] };
    g.t = U.interp(xs, el, grid, null, Float64Array);
    for (const name of GRID_SCALARS) {
      if (!ch[name]) continue;
      g[name] = U.interp(xs, ch[name].subarray(a, b), grid, name === 'gear' || name === 'abs' || name === 'tc' ? 'step' : null);
    }
    for (const name of GRID_WHEELS) {
      if (!ch[name]) continue;
      g[name] = ch[name].map((arr) => U.interp(xs, arr.subarray(a, b), grid));
    }
    // Outside the recorded part of a partial lap there is nothing to show.
    if (!lap.complete) {
      for (let k = 0; k < N; k++) if (grid[k] < g.dMin || grid[k] > g.dMax) { for (const name of GRID_SCALARS) if (g[name]) g[name][k] = NaN; g.t[k] = NaN; }
    }
    s._grids.set(lap.idx, g);
    while (s._grids.size > (s._gridCap || 14)) s._grids.delete(s._grids.keys().next().value);
    return g;
  }

  /* Corners = stretches of sustained lateral load on the reference lap. */
  function findCorners(g) {
    const N = g.n, w = Math.max(3, Math.round(15 / g.step));
    const lat = U.smooth(g.latG, w), abs = new Float64Array(N);
    for (let i = 0; i < N; i++) abs[i] = Math.abs(lat[i]);
    const p95 = U.percentile(abs, 0.95);
    const thr = Math.max(0.25, 0.3 * p95), low = thr * 0.5;
    let regs = [];
    let i = 0;
    while (i < N) {
      if (abs[i] > thr) {
        const sgn = Math.sign(lat[i]); let j = i;
        while (j < N && abs[j] > thr && Math.sign(lat[j]) === sgn) j++;
        regs.push({ a: i, b: j - 1, sgn });
        i = j;
      } else i++;
    }
    // merge same-direction pieces that are close together, drop very short ones
    const merged = [];
    for (const r of regs) {
      const p = merged[merged.length - 1];
      if (p && p.sgn === r.sgn && (r.a - p.b) * g.step < 25) p.b = r.b; else merged.push({ a: r.a, b: r.b, sgn: r.sgn });
    }
    regs = merged.filter((r) => (r.b - r.a) * g.step >= 15);
    // widen each region to where the load has died away, without overlapping neighbours
    regs.forEach((r, k) => {
      const lo = k > 0 ? regs[k - 1].b + 1 : 0, hi = k < regs.length - 1 ? regs[k + 1].a - 1 : N - 1;
      let a = r.a, b = r.b;
      while (a > lo && abs[a - 1] > low && Math.sign(lat[a - 1]) === r.sgn) a--;
      while (b < hi && abs[b + 1] > low && Math.sign(lat[b + 1]) === r.sgn) b++;
      r.a0 = a; r.b0 = b;
    });
    return regs.map((r, k) => {
      let apex = r.a0, vmin = Infinity, gmaxI = r.a0, gmax = 0;
      for (let q = r.a0; q <= r.b0; q++) {
        if (g.speed[q] < vmin) { vmin = g.speed[q]; apex = q; }
        if (abs[q] > gmax) { gmax = abs[q]; gmaxI = q; }
      }
      // Flat-out or accelerating bends have their slowest point at an edge; use peak load instead.
      if (apex - r.a0 < 3 || r.b0 - apex < 3) apex = gmaxI;
      const kmh = g.speed[apex] * 3.6;
      return { n: k + 1, name: 'C' + (k + 1), a: r.a0, b: r.b0, apex, dir: r.sgn > 0 ? 'L' : 'R',
        dStart: g.d[r.a0], dEnd: g.d[r.b0], dApex: g.d[apex], apexKmh: kmh, band: kmh < 100 ? 'low' : kmh < 160 ? 'medium' : 'high', peakG: gmax };
    });
  }

  /* Numbers for one corner on one lap, using the reference corner windows. */
  function cornerStats(g, c, prevEnd) {
    let vmin = Infinity, im = c.a, gmax = 0, bmax = 0;
    for (let q = c.a; q <= c.b; q++) {
      if (g.speed[q] < vmin) { vmin = g.speed[q]; im = q; }
      const al = Math.abs(g.latG[q]); if (al > gmax) gmax = al;
    }
    // Brake point: last place before the slowest point where the brake comes on.
    const lim = Math.max(prevEnd == null ? 0 : prevEnd, c.a - Math.round(450 / g.step), 0);
    let brakeAt = null;
    for (let q = im; q > lim; q--) {
      if (g.brake[q] > bmax) bmax = g.brake[q];
      if (g.brake[q] > 0.08 && g.brake[q - 1] <= 0.08) { brakeAt = g.d[q]; if (im - q > 5 / g.step) break; }
    }
    let throttleAt = null;
    for (let q = im; q <= Math.min(g.n - 1, c.b + Math.round(150 / g.step)); q++) if (g.throttle[q] > 0.9) { throttleAt = g.d[q]; break; }
    return { entry: g.speed[c.a], min: vmin, dMin: g.d[im], iMin: im, exit: g.speed[c.b], time: g.t[c.b] - g.t[c.a],
      brakeAt, maxBrake: bmax, throttleAt, peakG: gmax };
  }

  function summarise(s) {
    const ref = s.bestLap || s.laps.find((l) => l.complete) || null;
    s.refLap = ref; s.corners = []; s.profile = null;
    if (!ref) return;
    const g = lapGrid(s, ref);
    s.corners = findCorners(g);
    // Track profile from the reference lap, weighted by time.
    let tot = 0, wot = 0, brk = 0, vmax = 0, tLow = 0, tMed = 0, tHigh = 0;
    const bandAt = new Uint8Array(g.n);
    for (const c of s.corners) for (let q = c.a; q <= c.b; q++) bandAt[q] = c.band === 'low' ? 1 : c.band === 'medium' ? 2 : 3;
    for (let q = 1; q < g.n; q++) {
      const dt = g.t[q] - g.t[q - 1]; if (!(dt > 0)) continue;
      tot += dt; if (g.throttle[q] > 0.95) wot += dt; if (g.brake[q] > 0.1) brk += dt;
      if (g.speed[q] > vmax) vmax = g.speed[q];
      if (bandAt[q] === 1) tLow += dt; else if (bandAt[q] === 2) tMed += dt; else if (bandAt[q] === 3) tHigh += dt;
    }
    s.profile = {
      lengthM: s.trackLen, wot: tot ? wot / tot : 0, braking: tot ? brk / tot : 0, vmaxKmh: vmax * 3.6, avgKmh: tot ? (s.trackLen / tot) * 3.6 : 0,
      corners: s.corners.length, slow: s.corners.filter((c) => c.band === 'low').length, medium: s.corners.filter((c) => c.band === 'medium').length,
      fast: s.corners.filter((c) => c.band === 'high').length, tLow: tot ? tLow / tot : 0, tMed: tot ? tMed / tot : 0, tHigh: tot ? tHigh / tot : 0,
      bump: g.vertG ? U.std(g.vertG) : null,
    };
  }

  /* Time difference B − A along the lap (positive = B is behind). B is resampled if grids differ. */
  function deltaTime(gA, gB) {
    const N = gA.n, out = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const f = N > 1 ? k / (N - 1) : 0, p = f * (gB.n - 1), a = Math.floor(p), b = Math.min(gB.n - 1, a + 1);
      out[k] = gB.t[a] + (gB.t[b] - gB.t[a]) * (p - a) - gA.t[k];
    }
    return out;
  }

  /* Channel of grid B expressed on grid A's points. */
  function onGrid(gA, gB, arr) {
    if (gA.n === gB.n) return arr;
    const out = new Float32Array(gA.n);
    for (let k = 0; k < gA.n; k++) {
      const p = (k / (gA.n - 1)) * (gB.n - 1), a = Math.floor(p), b = Math.min(gB.n - 1, a + 1);
      out[k] = arr[a] + (arr[b] - arr[a]) * (p - a);
    }
    return out;
  }

  /* Compact record of a session for the library (no sample data). */
  function summaryOf(s) {
    const timed = s.laps.filter((l) => l.complete && l.valid);
    return {
      id: s.id, sim: s.meta.sim, car: s.meta.car, carClass: s.meta.carClass, track: s.trackName, fileName: s.meta.fileName,
      recordedAt: s.meta.recordedAt, laps: s.laps.filter((l) => l.complete).length, timedLaps: timed.length,
      bestLap: s.bestLap ? s.bestLap.time : null, setupId: s.setup ? s.setup.id : null, profile: s.profile, sessionType: s.meta.sessionType,
    };
  }

  STA.session = { IBT_WANT, runName, fromIbt, fromLmu, lapGrid, findCorners, cornerStats, deltaTime, onGrid, summaryOf, trackName, GRID_SCALARS, GRID_WHEELS };
})(typeof window !== 'undefined' ? window : globalThis);
