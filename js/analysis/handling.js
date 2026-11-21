/* Reads how the car behaved from the telemetry, without knowing which car it is.

   Balance. For a car in its linear range, steering follows
       steer ≈ K·curvature + C·lateralG
   (geometry plus a constant understeer gradient). K and C are fitted from the
   gentle-cornering samples of the laps being analysed. Near the limit, steering
   beyond that line means the front is giving up (understeer); steering below it,
   or opposite lock, means the rear is (oversteer). The gap is expressed as a
   share of the steering the driver normally uses, so it is unit-free and works
   with degrees (iRacing) or percent of lock (LMU).

   Rear sliding. When the file has the car's own forward and sideways velocity and its yaw
   rate (iRacing does), the slip angle of the rear axle is measured directly:
       rear slip = atan((b·yawRate − sidewaysVelocity) / forwardVelocity)
   with b the distance from the centre of gravity to the rear axle (a nominal 1.35 m; an
   error of 0.3 m moves the result by about half a degree in a hairpin). The slip of the
   front axle follows from the steering:  steer − K·yawRate/speed  is the front slip minus
   the rear slip, in steering-wheel degrees. A sample counts as the rear sliding when the
   rear is at a bigger slip angle than the front, or far beyond the angle it normally
   works at. Oversteer is reported from how often that happens, not from an average, so
   a car that steps out and is caught shows up even when most of the corner is tidy.

   Everything else (wheel speeds, tyre temperatures, ride height, brakes,
   gearing) is used when the file has the channel and skipped when it does not.

   Thresholds are general racing-car rules of thumb, not car-specific targets. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, G = STA.G, S = () => STA.session;

  const PHASES = ['entry', 'mid', 'exit'], BANDS = ['low', 'medium', 'high'];
  const BAND_TEXT = { low: 'slow corners', medium: 'medium corners', high: 'fast corners' };
  const BAND_RANGE = { low: 'under 100 km/h', medium: '100–160 km/h', high: 'over 160 km/h' };
  const PHASE_TEXT = { entry: 'Corner entry', mid: 'Mid-corner', exit: 'Corner exit' };

  function pickLaps(session, lapIdxs) {
    if (lapIdxs && lapIdxs.length) return lapIdxs.map((i) => session.laps[i]).filter((l) => l && l.complete);
    const timed = session.laps.filter((l) => l.complete && l.valid).sort((a, b) => a.time - b.time);
    if (!timed.length) return session.laps.filter((l) => l.complete).slice(0, 3);
    return timed.filter((l) => l.time <= timed[0].time * 1.03).slice(0, 6);
  }

  const REAR_ARM = 1.35; // m, centre of gravity to rear axle (nominal)

  function conf(n) { return n >= 3 ? 'high' : n === 2 ? 'medium' : 'low'; }

  function analyse(session, lapIdxs) {
    const laps = pickLaps(session, lapIdxs);
    const out = { laps: laps.map((l) => l.idx), lapNums: laps.map((l) => l.num), findings: [], balance: null, wheels: null, tyres: null, ride: null, brakes: null, gearing: null, notes: [] };
    if (!laps.length || !session.corners.length) {
      out.notes.push('Setup advice needs at least one complete lap with detectable corners.');
      return out;
    }
    const grids = laps.map((l) => S().lapGrid(session, l));
    const corners = session.corners, ch = session.ch;
    const lapWord = laps.length === 1 ? '1 lap' : laps.length + ' laps';
    const baseConf = laps.length >= 3 ? 'medium' : 'low';

    /* ---------- balance from steering ---------- */
    if (grids[0].steer && grids[0].latG) {
      const absG = [], absS = [];
      for (const g of grids) for (let i = 0; i < g.n; i += 2) if (g.speed[i] > 12) { absG.push(Math.abs(g.latG[i])); absS.push(Math.abs(g.steer[i])); }
      const gmax = U.percentile(absG, 0.98), sRef = U.percentile(absS, 0.95) || 1;
      let Skk = 0, Ska = 0, Saa = 0, Sks = 0, Sas = 0, nLin = 0;
      for (const g of grids) {
        for (let i = 0; i < g.n; i++) {
          const v = g.speed[i], a = g.latG[i], aa = Math.abs(a);
          if (!(v > 12) || aa < 0.1 * gmax || aa > 0.45 * gmax) continue;
          const k = (a * G) / (v * v), s = g.steer[i];
          Skk += k * k; Ska += k * a; Saa += a * a; Sks += k * s; Sas += a * s; nLin++;
        }
      }
      let K = Skk > 0 ? Sks / Skk : NaN, C = 0;
      const det = Skk * Saa - Ska * Ska;
      if (nLin > 200 && det > 1e-9 * Skk * Saa) {
        const K2 = (Sks * Saa - Sas * Ska) / det, C2 = (Skk * Sas - Ska * Sks) / det;
        if (K2 > 0 && C2 > -0.5 * sRef / Math.max(gmax, 0.1)) { K = K2; C = C2; }
      }
      if (K > 0 && nLin > 100) {
        const cells = {}, perCorner = {};
        const add = (key, v) => (cells[key] = cells[key] || []).push(v);
        let counter = 0, nearLimit = 0;
        const haveSlip = !!(grids[0].velX && grids[0].velY && grids[0].yawRate), slip = [];
        const counterBy = { entry: 0, mid: 0, exit: 0 }, nearBy = { entry: 0, mid: 0, exit: 0 };
        grids.forEach((g) => {
          corners.forEach((c, ci) => {
            const st = S().cornerStats(g, c, ci > 0 ? corners[ci - 1].b : null);
            const half = Math.max(Math.round(8 / g.step), Math.round(0.12 * (c.b - c.a)));
            for (let i = c.a; i <= c.b; i++) {
              const v = g.speed[i], a = g.latG[i];
              if (!(v > 8) || Math.abs(a) < 0.5 * gmax) continue;
              const k = (a * G) / (v * v), sg = Math.sign(a);
              const e = ((g.steer[i] - K * k - C * a) * sg) / sRef;
              const ph = Math.abs(i - st.iMin) <= half ? 'mid' : i < st.iMin ? 'entry' : 'exit';
              add(ph + '|' + c.band, e); add(ph, e);
              const pk = c.name + '|' + ph; (perCorner[pk] = perCorner[pk] || []).push(e);
              nearLimit++; nearBy[ph]++;
              if (g.steer[i] * sg < -0.03 * sRef) { counter++; counterBy[ph]++; }
              if (haveSlip) slip.push({ ph, band: c.band, name: c.name, lap: g.lapIdx,
                rear: Math.atan2(REAR_ARM * g.yawRate[i] - g.velY[i], Math.max(1, g.velX[i])) * (180 / Math.PI) * sg,
                gap: (g.steer[i] - K * g.yawRate[i] / v) * sg });
            }
          });
        });
        const cell = (key) => { const a = cells[key] || []; return { n: a.length, idx: a.length >= 25 ? U.median(a) : null }; };
        const matrix = {};
        for (const ph of PHASES) { matrix[ph] = { all: cell(ph) }; for (const b of BANDS) matrix[ph][b] = cell(ph + '|' + b); }
        const cornerIdx = {};
        for (const key of Object.keys(perCorner)) if (perCorner[key].length >= 8) cornerIdx[key] = U.median(perCorner[key]);
        out.balance = { K, C, steerRef: sRef, gmax, linearSamples: nLin, matrix, cornerIdx, counterShare: nearLimit ? counter / nearLimit : 0,
          counterBy: { entry: nearBy.entry ? counterBy.entry / nearBy.entry : 0, mid: nearBy.mid ? counterBy.mid / nearBy.mid : 0, exit: nearBy.exit ? counterBy.exit / nearBy.exit : 0 } };

        /* Rear sliding, measured (see the top of this file). */
        let slide = null;
        if (slip.length >= 200) {
          const ref = Math.max(1.5, U.median(slip.map((o) => o.rear)));
          // The steering test only counts while the rear is actually loaded, so a light car on a fast, easy corner is not read as sliding.
          const isSlide = (o) => (o.gap < -0.06 * sRef && o.rear >= 0.8 * ref) || o.rear > Math.max(1.8 * ref, ref + 2.5);
          const cellsS = {}, byCorner = {};
          for (const o of slip) {
            const hit = isSlide(o) ? 1 : 0;
            for (const key of [o.ph, o.ph + '|' + o.band]) { const cS = cellsS[key] || (cellsS[key] = { n: 0, hits: 0, peak: 0 }); cS.n++; cS.hits += hit; if (hit && o.rear > cS.peak) cS.peak = o.rear; }
            const ck = o.ph + '|' + o.name, bc = byCorner[ck] || (byCorner[ck] = { band: o.band, laps: {} });
            const L = bc.laps[o.lap] || (bc.laps[o.lap] = { n: 0, hits: 0 }); L.n++; L.hits += hit;
          }
          // A corner counts when the rear slides there on at least half of the laps.
          const repeatIn = (ph, band) => Object.keys(byCorner).filter((k) => k.indexOf(ph + '|') === 0 && (!band || byCorner[k].band === band)).filter((k) => {
            const per = Object.values(byCorner[k].laps); return per.filter((L) => L.n >= 4 && L.hits / L.n >= 0.15).length >= Math.max(1, Math.ceil(laps.length / 2));
          }).map((k) => k.split('|')[1]);
          slide = { ref, cells: cellsS, share: (key) => (cellsS[key] && cellsS[key].n >= 40 ? cellsS[key].hits / cellsS[key].n : null), repeatIn };
          out.balance.slide = { rearSlipRef: ref, by: Object.fromEntries(PHASES.map((ph) => [ph, slide.share(ph)])),
            cells: Object.fromEntries(Object.keys(cellsS).map((k) => [k, { n: cellsS[k].n, share: cellsS[k].hits / cellsS[k].n, peak: cellsS[k].peak }])) };
          for (const ph of PHASES) for (const b of BANDS) {
            const share = slide.share(ph + '|' + b), where = repeatIn(ph, b);
            if (share == null || !(share >= 0.08 || (share >= 0.05 && where.length >= 1) || where.length >= 2)) continue;
            out.findings.push({
              id: 'os-' + ph + '-' + b, kind: 'oversteer', phase: ph, band: b, area: 'Balance', measured: true,
              title: PHASE_TEXT[ph] + ' oversteer in ' + BAND_TEXT[b],
              detail: 'Rear slides: at a bigger slip angle than the front for ' + Math.round(share * 100) + '% of the time near the limit (rear up to ' + cellsS[ph + '|' + b].peak.toFixed(0) + '°, normally ' + ref.toFixed(0) + '°).',
              evidence: (where.length ? 'Repeats in ' + where.join(', ') + '. ' : '') + lapWord + '.',
              severity: U.clamp(share / 0.25, 0.25, 1), confidence: where.length ? (laps.length >= 3 ? 'high' : 'medium') : baseConf, corners: where,
            });
          }
        }

        const US = 0.25, OS = -0.10;
        for (const ph of PHASES) {
          for (const b of BANDS) {
            const m = matrix[ph][b];
            if (m.idx == null) continue;
            const names = corners.filter((c) => c.band === b).filter((c) => cornerIdx[c.name + '|' + ph] != null);
            if (m.idx >= US) {
              const worst = names.filter((c) => cornerIdx[c.name + '|' + ph] >= US).map((c) => c.name);
              out.findings.push({
                id: 'us-' + ph + '-' + b, kind: 'understeer', phase: ph, band: b, area: 'Balance',
                title: PHASE_TEXT[ph] + ' understeer in ' + BAND_TEXT[b],
                detail: 'Front gives up first: ' + Math.round(m.idx * 100) + '% more steering than the car needs at the limit.',
                evidence: (worst.length ? 'Worst in ' + worst.join(', ') + '. ' : '') + lapWord + '.',
                severity: U.clamp((m.idx - 0.2) / 0.5, 0.1, 1), confidence: baseConf, corners: worst,
              });
            } else if (m.idx <= OS && !out.findings.some((f) => f.id === 'os-' + ph + '-' + b)) {
              const worst = names.filter((c) => cornerIdx[c.name + '|' + ph] <= OS).map((c) => c.name);
              out.findings.push({
                id: 'os-' + ph + '-' + b, kind: 'oversteer', phase: ph, band: b, area: 'Balance',
                title: PHASE_TEXT[ph] + ' oversteer in ' + BAND_TEXT[b],
                detail: 'Rear rotates the car: ' + Math.round(-m.idx * 100) + '% less steering than the car needs at the limit.',
                evidence: (worst.length ? 'Worst in ' + worst.join(', ') + '. ' : '') + lapWord + '.',
                severity: U.clamp((-m.idx) / 0.4, 0.1, 1), confidence: baseConf, corners: worst,
              });
            }
          }
        }
        // A phase that is fine on average can still have individual corners that are clearly not.
        for (const ph of PHASES) {
          for (const [kind, test] of [['understeer', (v) => v >= 0.35], ['oversteer', (v) => v <= -0.15]]) {
            if (out.findings.some((f) => f.kind === kind && f.phase === ph)) continue;
            const list = corners.filter((c) => cornerIdx[c.name + '|' + ph] != null && test(cornerIdx[c.name + '|' + ph]));
            if (list.length < 2) continue;
            const counts = { low: 0, medium: 0, high: 0 }; list.forEach((c) => counts[c.band]++);
            const band = BANDS.reduce((a, b) => (counts[b] > counts[a] ? b : a), 'low');
            const mean = U.mean(list.map((c) => cornerIdx[c.name + '|' + ph]));
            out.findings.push({
              id: (kind === 'understeer' ? 'us-' : 'os-') + ph + '-' + band, kind, phase: ph, band, area: 'Balance',
              title: PHASE_TEXT[ph] + ' ' + kind + ' in ' + list.map((c) => c.name).join(', '),
              detail: kind === 'understeer'
                ? 'Front gives up first here: about ' + Math.round(mean * 100) + '% more steering than the car needs.'
                : 'Rear rotates the car here: about ' + Math.round(-mean * 100) + '% less steering than the car needs.',
              evidence: 'Other corners are near neutral in this phase. ' + lapWord + '.',
              severity: U.clamp(Math.abs(mean) / 0.7, 0.2, 0.8), confidence: baseConf, corners: list.map((c) => c.name),
            });
          }
        }
        for (const ph of PHASES) {
          const share = out.balance.counterBy[ph];
          if (!slide && share >= 0.03 && !out.findings.some((f) => f.kind === 'oversteer' && f.phase === ph)) {
            out.findings.push({
              id: 'os-counter-' + ph, kind: 'oversteer', phase: ph, band: 'low', area: 'Balance',
              title: PHASE_TEXT[ph] + ' oversteer (opposite lock)',
              detail: 'On opposite lock for ' + (share * 100).toFixed(1) + '% of the time near the limit.',
              evidence: lapWord + '.', severity: U.clamp(share / 0.1, 0.2, 1), confidence: baseConf, corners: [],
            });
          }
        }
        const loose = out.findings.filter((f) => f.kind === 'oversteer');
        if (loose.length) for (const f of out.findings) {
          if (f.kind !== 'understeer') continue;
          f.rearFirst = true;
          const same = loose.some((x) => x.phase === f.phase);
          // Always ranked below the sliding rear itself.
          f.severity = +Math.min(f.severity * (same ? 0.4 : 0.7), 0.8 * Math.max.apply(null, loose.map((x) => x.severity))).toFixed(3);
          f.evidence += ' The rear also slides ' + (same ? 'in this part of the corner' : 'elsewhere in the corner') + ': settle the rear first. Only front-end changes are offered for this.';
        }
      } else out.notes.push('Not enough gentle cornering in these laps to calibrate steering against cornering, so balance could not be judged from steering.');
    } else out.notes.push('No steering or lateral G channel, so balance could not be judged.');

    /* ---------- traction on exit: driver lifts and traction-control activity ---------- */
    {
      const hits = {}, tcBy = {}; let exits = 0, tcOn = 0, tcN = 0;
      const haveTc = !!grids[0].tc;
      grids.forEach((g) => {
        const pedal = g.throttleRaw || g.throttle;
        corners.forEach((c, ci) => {
          const st = S().cornerStats(g, c, ci > 0 ? corners[ci - 1].b : null);
          const next = ci < corners.length - 1 ? corners[ci + 1].a : g.n - 1;
          const end = Math.min(g.n - 1, next, c.b + Math.round(60 / g.step));
          let started = false, peak = 0, low = 0, lifted = false, cOn = 0, cN = 0;
          for (let i = st.iMin; i <= end; i++) {
            const th = pedal[i];
            if (haveTc && th > 0.3) { cN++; if (g.tc[i] > 0.5) cOn++; }
            if (lifted) continue;
            if (!started) { if (th > 0.3) { started = true; peak = th; } continue; }
            if (th > 0.97) { started = false; peak = 2; continue; } // reached full throttle: later dips are gear changes
            if (th > peak) peak = th;
            if (peak <= 1 && peak - th > 0.2 && g.brake[i] < 0.05) { if (++low * g.step >= 3) lifted = true; } else low = 0;
          }
          if (cN) { tcOn += cOn; tcN += cN; if (cOn / cN > 0.25) tcBy[c.name] = (tcBy[c.name] || 0) + 1; }
          exits++; if (lifted && c.band !== 'high') hits[c.name] = (hits[c.name] || 0) + 1;
        });
      });
      const need = Math.max(1, Math.ceil(laps.length / 2));
      const repeat = Object.keys(hits).filter((k) => hits[k] >= need), tcRepeat = Object.keys(tcBy).filter((k) => tcBy[k] >= need);
      out.exits = { lifts: hits, repeat, tcShare: tcN ? tcOn / tcN : null, tcCorners: tcRepeat, exits };
      const exitIdx = out.balance ? out.balance.matrix.exit.all.idx : null;
      if (repeat.length >= 2) {
        const front = exitIdx != null && exitIdx >= 0.25;
        if (!out.findings.some((f) => f.phase === 'exit' && f.kind === (front ? 'understeer' : 'oversteer'))) {
          out.findings.push({
            id: 'exit-lift', kind: front ? 'understeer' : 'traction', phase: 'exit', band: 'low', area: 'Traction',
            title: front ? 'Lifting on exit to wait for the front' : 'Lifting on exit to keep the rear in line',
            detail: 'Throttle comes back off before reaching full in ' + repeat.join(', ') + '.',
            evidence: 'At least half of ' + lapWord + '.', severity: U.clamp(repeat.length / 5, 0.3, 0.9), confidence: baseConf, corners: repeat,
          });
        }
      }
      if (out.exits.tcShare != null && out.exits.tcShare > 0.15 && tcRepeat.length >= 2) {
        out.findings.push({
          id: 'tc-busy', kind: 'traction', phase: 'exit', band: 'low', area: 'Traction',
          title: 'Traction control busy on exit',
          detail: 'TC cuts power for ' + Math.round(out.exits.tcShare * 100) + '% of exit throttle time, mostly in ' + tcRepeat.join(', ') + '.',
          evidence: 'TC channel, ' + lapWord + '.', severity: U.clamp(out.exits.tcShare / 0.5, 0.3, 0.9), confidence: conf(laps.length), corners: tcRepeat, tcBusy: true,
        });
      }
    }

    /* ---------- wheel speeds: locking and wheelspin ---------- */
    if (grids[0].wheelSpeed) {
      let brakeN = 0, fLock = 0, rLock = 0, powN = 0, rSpin = 0, fSpin = 0, absOn = 0;
      for (const g of grids) {
        const w = g.wheelSpeed;
        for (let i = 0; i < g.n; i++) {
          const v = g.speed[i]; if (!(v > 12)) continue;
          if (g.brake[i] > 0.3) {
            brakeN++;
            if (Math.min(w[0][i], w[1][i]) < 0.86 * v) fLock++;
            if (Math.min(w[2][i], w[3][i]) < 0.86 * v) rLock++;
            if (g.abs && g.abs[i] > 0.5) absOn++;
          } else if (g.throttle[i] > 0.5 && g.speed[i] < 55) {
            powN++;
            const f = (w[0][i] + w[1][i]) / 2, r = (w[2][i] + w[3][i]) / 2;
            if (r > f * 1.06) rSpin++; else if (f > r * 1.06) fSpin++;
          }
        }
      }
      out.wheels = { frontLock: brakeN ? fLock / brakeN : 0, rearLock: brakeN ? rLock / brakeN : 0, rearSpin: powN ? rSpin / powN : 0,
        frontSpin: powN ? fSpin / powN : 0, absShare: brakeN && grids[0].abs ? absOn / brakeN : null };
      const W = out.wheels;
      if (W.frontLock > 0.04 && W.frontLock > W.rearLock * 1.5) out.findings.push({ id: 'front-lock', kind: 'frontLock', area: 'Braking', title: 'Front wheels locking',
        detail: 'A front wheel runs 14%+ slower than the car for ' + (W.frontLock * 100).toFixed(1) + '% of hard braking.', evidence: 'Wheel speeds, ' + lapWord + '.', severity: U.clamp(W.frontLock / 0.15, 0.2, 1), confidence: conf(laps.length) });
      if (W.rearLock > 0.03 && W.rearLock >= W.frontLock) out.findings.push({ id: 'rear-lock', kind: 'rearLock', area: 'Braking', title: 'Rear wheels locking',
        detail: 'A rear wheel runs 14%+ slower than the car for ' + (W.rearLock * 100).toFixed(1) + '% of hard braking.', evidence: 'Wheel speeds, ' + lapWord + '.', severity: U.clamp(W.rearLock / 0.1, 0.3, 1), confidence: conf(laps.length) });
      const spin = Math.max(W.rearSpin, W.frontSpin), axle = W.rearSpin >= W.frontSpin ? 'rear' : 'front';
      if (spin > 0.05) out.findings.push({ id: 'wheelspin', kind: 'wheelspin', axle, area: 'Traction', title: (axle === 'rear' ? 'Rear' : 'Front') + ' wheelspin under power',
        detail: 'Driven wheels run 6%+ faster than the other axle for ' + (spin * 100).toFixed(1) + '% of low-speed acceleration.', evidence: 'Wheel speeds, ' + lapWord + '.', severity: U.clamp(spin / 0.2, 0.2, 1), confidence: conf(laps.length) });
    }

    /* ---------- tyres ---------- */
    if (ch.tyreTempI && ch.tyreTempM && ch.tyreTempO) {
      const live = session.meta.sim === 'lmu';
      const val = (name, w) => {
        if (!live) { // iRacing: readings only refresh in the pits; use the last value in the file
          const a = ch[name][w]; return a[a.length - 1];
        }
        let s = 0, n = 0;
        for (const g of grids) { const a = g[name][w]; for (let i = 0; i < g.n; i += 4) { if (a[i] === a[i]) { s += a[i]; n++; } } }
        return n ? s / n : NaN;
      };
      const rows = STA.WHEELS.map((name, w) => {
        const inner = val('tyreTempI', w), mid = val('tyreTempM', w), outer = val('tyreTempO', w);
        const press = ch.tyrePress ? val('tyrePress', w) : null;
        return { wheel: name, inner, mid, outer, avg: (inner + mid + outer) / 3, spread: inner - outer, crown: mid - (inner + outer) / 2, press };
      });
      const warm = rows.every((r) => r.avg > 40);
      out.tyres = { rows, live, warm, note: live ? 'Surface temperatures averaged over the analysed laps.' : session.meta.tyreNote };
      if (warm) {
        const tConf = live ? baseConf : 'low';
        for (const [axle, a, b] of [['front', 0, 1], ['rear', 2, 3]]) {
          const spread = (rows[a].spread + rows[b].spread) / 2, crown = (rows[a].crown + rows[b].crown) / 2;
          if (spread > 16) out.findings.push({ id: 'camber-much-' + axle, kind: 'camberTooMuch', axle, area: 'Tyres', title: 'Too much negative camber, ' + axle,
            detail: 'Inner edge ' + spread.toFixed(0) + ' °C hotter than outer (5–12 °C is typical).', evidence: out.tyres.note, severity: U.clamp((spread - 12) / 15, 0.2, 0.8), confidence: tConf });
          else if (spread < 2) out.findings.push({ id: 'camber-little-' + axle, kind: 'camberTooLittle', axle, area: 'Tyres', title: 'Not enough negative camber, ' + axle,
            detail: 'Inner edge only ' + spread.toFixed(0) + ' °C hotter than outer; the outer shoulder is overworked.', evidence: out.tyres.note, severity: U.clamp((5 - spread) / 12, 0.2, 0.8), confidence: tConf });
          if (crown > 5) out.findings.push({ id: 'press-high-' + axle, kind: 'pressureHigh', axle, area: 'Tyres', title: axle === 'front' ? 'Front tyre pressures look high' : 'Rear tyre pressures look high',
            detail: 'Tread centre ' + crown.toFixed(0) + ' °C hotter than the edges.', evidence: out.tyres.note, severity: 0.3, confidence: 'low' });
          else if (crown < -7) out.findings.push({ id: 'press-low-' + axle, kind: 'pressureLow', axle, area: 'Tyres', title: axle === 'front' ? 'Front tyre pressures look low' : 'Rear tyre pressures look low',
            detail: 'Tread centre ' + (-crown).toFixed(0) + ' °C cooler than the edges.', evidence: out.tyres.note, severity: 0.3, confidence: 'low' });
        }
        const fAvg = (rows[0].avg + rows[1].avg) / 2, rAvg = (rows[2].avg + rows[3].avg) / 2;
        out.tyres.frontMinusRear = fAvg - rAvg;
        // Tyre temperatures back up (or contradict) the steering-based balance.
        for (const f of out.findings) {
          if (f.area !== 'Balance') continue;
          if ((f.kind === 'understeer' && fAvg - rAvg > 6) || (f.kind === 'oversteer' && rAvg - fAvg > 6)) {
            f.evidence += ' Tyres agree: ' + (f.kind === 'understeer' ? 'fronts' : 'rears') + ' ' + Math.abs(fAvg - rAvg).toFixed(0) + ' °C hotter.';
            if (live && f.confidence === 'medium') f.confidence = 'high';
          }
        }
      } else out.notes.push('Tyres were not up to temperature in these laps, so tyre-based advice is left out.');
    }

    /* ---------- ride height ---------- */
    {
      let fMin = Infinity, rMin = Infinity, have = false, fLow = 0, rLow = 0, cnt = 0;
      for (const g of grids) {
        const f = g.rideH ? [g.rideH[0], g.rideH[1]] : g.rideF ? [g.rideF] : null, r = g.rideH ? [g.rideH[2], g.rideH[3]] : g.rideR ? [g.rideR] : null;
        if (!f || !r) continue; have = true;
        for (let i = 0; i < g.n; i++) {
          if (!(g.speed[i] > 20)) continue; cnt++;
          let fv = Infinity, rv = Infinity;
          for (const a of f) if (a[i] < fv) fv = a[i];
          for (const a of r) if (a[i] < rv) rv = a[i];
          if (fv < fMin) fMin = fv; if (rv < rMin) rMin = rv;
          if (fv < 0.004) fLow++; if (rv < 0.004) rLow++;
        }
      }
      if (have && cnt) {
        out.ride = { frontMinMm: fMin * 1000, rearMinMm: rMin * 1000, frontLowShare: fLow / cnt, rearLowShare: rLow / cnt };
        for (const [axle, share, mn] of [['front', fLow / cnt, fMin], ['rear', rLow / cnt, rMin]]) {
          if (share > 0.004) out.findings.push({ id: 'bottom-' + axle, kind: 'bottoming', axle, area: 'Ride height', title: (axle === 'rear' ? 'Rear' : 'Front') + ' close to the ground at speed',
            detail: 'Under 4 mm for ' + (share * 100).toFixed(1) + '% of the lap (minimum ' + (mn * 1000).toFixed(1) + ' mm).',
            evidence: 'Ride-height channel, ' + lapWord + '. The measuring point differs by car, so check before acting.', severity: U.clamp(share / 0.03, 0.2, 0.8), confidence: 'low' });
        }
      }
    }

    /* ---------- brakes ---------- */
    if (grids[0].brakeTemp) {
      const peak = [0, 0, 0, 0];
      for (const g of grids) for (let w = 0; w < 4; w++) { const m = U.minMax(g.brakeTemp[w])[1]; if (m > peak[w]) peak[w] = m; }
      out.brakes = { peak };
      const fMax = Math.max(peak[0], peak[1]), rMax = Math.max(peak[2], peak[3]);
      if (fMax > 850 || rMax > 850) out.findings.push({ id: 'brake-hot', kind: 'brakeHot', axle: fMax >= rMax ? 'front' : 'rear', area: 'Braking', title: 'Brakes very hot',
        detail: 'Peak disc ' + Math.max(fMax, rMax).toFixed(0) + ' °C, ' + (fMax >= rMax ? 'front' : 'rear') + '.', evidence: 'Brake temperatures, ' + lapWord + '. Safe limits depend on the disc material.', severity: 0.4, confidence: 'low' });
    }

    /* ---------- gearing ---------- */
    if (session.meta.maxRpm && grids[0].rpm && grids[0].gear) {
      let top = 0; for (const g of grids) { const m = U.minMax(g.gear)[1]; if (m > top) top = m; }
      let lim = 0, tot = 0;
      for (const g of grids) for (let i = 1; i < g.n; i++) {
        const dt = g.t[i] - g.t[i - 1]; if (!(dt > 0)) continue; tot += dt;
        if (g.gear[i] === top && g.throttle[i] > 0.95 && g.rpm[i] > 0.985 * session.meta.maxRpm) lim += dt;
      }
      out.gearing = { topGear: top, limiterShare: tot ? lim / tot : 0 };
      if (out.gearing.limiterShare > 0.015) out.findings.push({ id: 'limiter', kind: 'limiter', area: 'Gearing', title: 'On the rev limiter in top gear',
        detail: 'Within 1.5% of max revs in gear ' + top + ' for ' + (out.gearing.limiterShare * 100).toFixed(1) + '% of the lap.', evidence: 'RPM and gear, ' + lapWord + '.', severity: 0.5, confidence: conf(laps.length) });
    }

    out.findings.sort((a, b) => b.severity - a.severity);
    return out;
  }

  STA.handling = { analyse, pickLaps, PHASES, BANDS, BAND_TEXT, BAND_RANGE, PHASE_TEXT };
})(typeof window !== 'undefined' ? window : globalThis);
