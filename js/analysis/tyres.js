/* Tyre temperatures: where on the lap they spike, whether they sit in their working
   window, and how quickly they get there after leaving the pits.

   What the two sims record (checked on real files):
     iRacing  surface temperatures (inner, middle, outer) all the way round the lap. They
              swing hard: up 10–30 °C in a corner, down again on the straight, and on
              average they read 20–35 °C under the carcass readings iRacing takes when the
              car stops in the pits. So on track they show *where* a tyre heats up,
              compared with that tyre's own lap; whether a tyre is too cold or too hot is
              judged from the pit readings, which are what iRacing's window refers to.
     LMU      tyre temperatures that move slowly and sit within a few degrees of the
              carcass temperature, so they are held to the window directly. They are too
              smooth to show short spikes.

   The window is a general guide (80–100 °C) unless the driver has set one for the car,
   for example from the ideal temperature LMU shows in its pit menu. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, S = () => STA.session;

  const DEFAULT = { lo: 80, hi: 100 };
  const WHEEL_TEXT = { FL: 'front left', FR: 'front right', RL: 'rear left', RR: 'rear right' };
  const SMOOTH_M = 30;           // metres of track averaged into one map value (about 1 s at 110 km/h)
  const REL_STEPS = [5, 15]; // °C above/below the tyre's lap average: a little, a lot
  const WIN_STEPS = [0, 8];  // °C outside the window: a little, a lot

  /* How temperatures in this session can be judged. */
  function modeOf(session) {
    if (!session || !session.ch.tyreTempM) return null;
    if (session.meta.sim === 'lmu') return 'window';
    return session.meta.tyreLive ? 'relative' : null;
  }

  function windowFor(sim, car) {
    const mine = STA.library && STA.library.tyreWindow ? STA.library.tyreWindow.get(sim, car) : null;
    return mine ? { lo: mine.lo, hi: mine.hi, mine: true } : { lo: DEFAULT.lo, hi: DEFAULT.hi, mine: false };
  }

  /* Smoothed surface temperature (mean of inner, middle, outer) for one wheel on a lap grid. */
  function surface(g, w) {
    if (!g.tyreTempM) return null;
    const raw = new Float64Array(g.n);
    for (let i = 0; i < g.n; i++) raw[i] = (g.tyreTempI[w][i] + g.tyreTempM[w][i] + g.tyreTempO[w][i]) / 3;
    return U.smooth(raw, Math.max(1, Math.round(SMOOTH_M / g.step)));
  }
  const meanOf = (a) => { let s = 0, k = 0; for (const x of a) if (x === x) { s += x; k++; } return k ? s / k : NaN; };

  /* Colour class per point: -2..-1 cold side, 0 neutral, 1..2 hot side.
     In window mode the neutral band is the window; in relative mode it is the tyre's own lap average. */
  function stepOf(diff, steps) {
    const a = Math.abs(diff); let k = 0;
    if (a > steps[0] || (steps[0] === 0 && a > 0)) k = 1;
    if (a > steps[1]) k = 2;
    return diff < 0 ? -k : k;
  }

  /* Map data for one lap: temperatures and colour classes for one wheel (0-3) or the
     hottest of the four ('hot'). */
  function lapMap(g, which, mode, win) {
    const sm = [0, 1, 2, 3].map((w) => surface(g, w));
    if (!sm[0]) return null;
    const means = sm.map(meanOf), N = g.n;
    const temp = new Float64Array(N), diff = new Float64Array(N), cls = new Int8Array(N), wheel = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      let best = -Infinity, bw = 0;
      const list = which === 'hot' ? [0, 1, 2, 3] : [which];
      for (const w of list) {
        const t = sm[w][i], d = mode === 'window' ? (t < win.lo ? t - win.lo : t > win.hi ? t - win.hi : 0) : t - means[w];
        // "hottest" means hottest against its own reference, so a hot rear and a cool front compare fairly
        const score = mode === 'window' ? t : d;
        if (score > best) { best = score; bw = w; }
      }
      const t = sm[bw][i], d = mode === 'window' ? (t < win.lo ? t - win.lo : t > win.hi ? t - win.hi : 0) : t - means[bw];
      temp[i] = t; diff[i] = d; wheel[i] = bw;
      cls[i] = g.speed && !(g.speed[i] === g.speed[i]) ? 0 : stepOf(d, mode === 'window' ? WIN_STEPS : REL_STEPS);
    }
    return { temp, diff, cls, wheel, means, all: sm };
  }

  /* Corners where a tyre gets hotter than it does in that tyre's other corners. */
  function hotSpots(session, grids, mode, win) {
    const corners = session.corners || [];
    if (!corners.length || !grids.length || !grids[0].tyreTempM) return [];
    const out = [];
    for (let w = 0; w < 4; w++) {
      const per = corners.map(() => []);
      for (const g of grids) {
        const sm = surface(g, w), m = meanOf(sm);
        // each stretch hotter than the lap average belongs to the corner nearest its peak
        let i = 0;
        while (i < g.n) {
          if (!(sm[i] > m + 4)) { i++; continue; }
          let j = i, pk = i;
          while (j < g.n && sm[j] > m + 4) { if (sm[j] > sm[pk]) pk = j; j++; }
          let ci = -1, dist = Infinity;
          corners.forEach((c, k) => { const dd = pk < c.a ? c.a - pk : pk > c.b ? pk - c.b : 0; if (dd < dist) { dist = dd; ci = k; } });
          if (ci >= 0 && dist * g.step < 150) {
            // The peak lags the cause (the surface takes time to heat, and the values are smoothed),
            // so the phase comes from where the temperature climbs fastest on the way up.
            const lag = Math.max(1, Math.round(10 / g.step)), from = Math.max(lag, i - Math.round(60 / g.step));
            let ks = pk, rise = -Infinity;
            for (let q = from; q <= pk; q++) { const r = sm[q] - sm[q - lag]; if (r > rise) { rise = r; ks = q - (lag >> 1); } }
            const phase = g.brake && g.brake[ks] > 0.1 ? 'braking' : g.throttle && g.throttle[ks] > 0.3 && ks >= corners[ci].apex ? 'exit' : 'mid';
            const prev = per[ci][per[ci].length - 1];
            const rec = { lap: g.lapIdx, peak: sm[pk], excess: sm[pk] - m, phase, d: g.d[pk], i: pk };
            if (prev && prev.lap === g.lapIdx) { if (rec.excess > prev.excess) per[ci][per[ci].length - 1] = rec; } else per[ci].push(rec);
          }
          i = j;
        }
      }
      const typical = U.median(per.map((a) => (a.length ? U.median(a.map((r) => r.excess)) : 0)));
      corners.forEach((c, k) => {
        const recs = per[k];
        if (recs.length < Math.max(1, Math.ceil(grids.length / 2))) return;
        const excess = U.median(recs.map((r) => r.excess)), peak = U.median(recs.map((r) => r.peak));
        const over = mode === 'window' ? peak > win.hi : excess >= Math.max(12, typical + 8);
        if (!over) return;
        const phases = {}; for (const r of recs) phases[r.phase] = (phases[r.phase] || 0) + 1;
        const phase = Object.keys(phases).sort((a, b) => phases[b] - phases[a])[0];
        out.push({ wheel: STA.WHEELS[w], w, corner: c.name, cornerIdx: k, excess, peak, typical, phase, laps: recs.length, of: grids.length, at: U.median(recs.map((r) => r.i)) });
      });
    }
    out.sort((a, b) => (mode === 'window' ? b.peak - a.peak : b.excess - b.typical - (a.excess - a.typical)));
    return out.slice(0, 6);
  }

  const DRIVE = {
    front: {
      braking: 'The front is sliding or close to locking at the end of the braking. Ease off the pedal more gradually as you turn in.',
      mid: 'The front is scrubbing through the middle of the corner. Arrive a little slower and use less steering until the front bites.',
      exit: 'The front is being dragged wide on the way out. Unwind the steering as you add throttle.',
    },
    rear: {
      braking: 'The rear is moving around under braking. Brake a little straighter and blip the downshifts so the rear wheels do not lock.',
      mid: 'The rear is sliding through the middle of the corner. Keep the car settled: steady throttle, no sudden lift.',
      exit: 'The rear is spinning up or sliding as you go back to the throttle. Squeeze the throttle in more gradually, or short-shift.',
    },
  };
  function driveTip(spot) { return DRIVE[spot.w < 2 ? 'front' : 'rear'][spot.phase]; }

  /* Average temperature per lap, per run (a run starts each time the car leaves the pits or is reset). */
  function runs(session) {
    const ch = session.ch, hz = session.hz || 60;
    if (!ch.tyreTempM) return [];
    const startsInPit = (l) => { if (!ch.onPit) return false; for (let i = l.i0; i < Math.min(l.i1, l.i0 + 2 * hz); i += 5) if (ch.onPit[i] > 0.5) return true; return false; };
    const lapAvg = (l) => {
      const s = [0, 0, 0, 0]; let k = 0;
      for (let i = l.i0; i < l.i1; i += 3) {
        if (!(ch.speed[i] > 10) || (ch.onPit && ch.onPit[i] > 0.5)) continue;
        k++; for (let w = 0; w < 4; w++) s[w] += (ch.tyreTempI[w][i] + ch.tyreTempM[w][i] + ch.tyreTempO[w][i]) / 3;
      }
      return k * 3 > 10 * hz ? s.map((x) => x / k) : null;
    };
    const readings = (session.tyreReadings || []).slice(1); // the first is whatever the tyres held when recording began
    const out = []; let cur = null, prev = null;
    for (const l of session.laps) {
      const reset = prev && session.breaks && session.breaks.some((b) => b > prev.i0 && b <= l.i0 + 2 * hz);
      const read = prev && readings.some((r) => r.i > prev.i1 - 2 * hz && r.i <= l.i0 + 2 * hz);
      if (!cur || startsInPit(l) || reset || read) { cur = { laps: [] }; out.push(cur); }
      const temps = lapAvg(l);
      if (temps) cur.laps.push({ idx: l.idx, num: l.num, time: l.complete ? l.time : null, complete: l.complete, valid: l.valid, pit: l.pit, temps });
      prev = l;
    }
    const kept = out.filter((r) => r.laps.length);
    // the carcass reading taken when this run ended, if the recording has it
    // where the car drives off: the first sample of a lap that is at speed and off pit road
    const leaves = (l) => { for (let i = l.i0; i < l.i1; i++) if (ch.speed[i] > 10 && !(ch.onPit && ch.onPit[i] > 0.5)) return i; return l.i1; };
    for (const r of kept) {
      const last = session.laps[r.laps[r.laps.length - 1].idx];
      const next = kept[kept.indexOf(r) + 1], until = next ? leaves(session.laps[next.laps[0].idx]) : Infinity;
      const rd = readings.find((x) => x.i >= last.i0 && x.i < until);
      if (rd && r.laps.filter((x) => x.complete).length >= 1) r.reading = { i: rd.i, rows: rd.rows.map((x) => ({ inner: x.inner, mid: x.mid, outer: x.outer, avg: (x.inner + x.mid + x.outer) / 3 })), afterLap: last.num };
    }
    return kept;
  }

  /* When the tyres came in on each run, and whether timed laps were attempted before that. */
  function warmup(session, mode, win) {
    const all = runs(session), best = session.bestLap ? session.bestLap.time : null;
    for (const r of all) {
      const timed = r.laps.filter((x) => x.complete && !x.pit && x.time);
      const clean = timed.filter((x) => !best || x.time <= best * 1.05);
      r.short = clean.length < 3;
      r.target = [0, 1, 2, 3].map((w) => {
        if (mode === 'window') return win.lo;
        if (clean.length < 3) return null;
        return U.percentile(clean.map((x) => x.temps[w]), 0.75) - 3; // within 3 °C of where this tyre settles on the run
      });
      r.warmAtWheel = [0, 1, 2, 3].map((w) => { if (r.target[w] == null) return null; const k = r.laps.findIndex((x) => x.temps[w] >= r.target[w]); return k < 0 ? null : k; });
      r.warmAt = r.warmAtWheel.some((k) => k == null) ? null : Math.max(...r.warmAtWheel);
      // the tyre that holds the warm-up back: last to come in, or furthest short if one never did
      const end = r.laps[r.laps.length - 1].temps;
      r.lastWheel = r.warmAt != null ? r.warmAtWheel.indexOf(r.warmAt)
        : r.target.some((x) => x == null) ? -1 : [0, 1, 2, 3].reduce((a, w) => (r.target[w] - end[w] > r.target[a] - end[a] ? w : a), 0);
      // a "push" lap: within 1.5% of the best lap of the recording
      const pushes = timed.filter((x) => best && x.time <= best * 1.015);
      r.firstPush = pushes.length ? r.laps.indexOf(pushes[0]) : null;
      r.coldTimed = timed.filter((x) => r.laps.indexOf(x) < (r.warmAt == null ? Infinity : r.warmAt));
      r.coldPushed = r.coldTimed.filter((x) => best && x.time <= best * 1.03);
      if (r.reading) r.reading.verdict = r.reading.rows.map((x) => (x.avg < win.lo ? 'cold' : x.avg > win.hi ? 'hot' : 'in'));
    }
    return all;
  }

  /* Share of the analysed laps each tyre spent below, inside and above the window (window mode). */
  function shares(grids, win) {
    return [0, 1, 2, 3].map((w) => {
      let lo = 0, hi = 0, k = 0, sum = 0;
      for (const g of grids) {
        const sm = surface(g, w);
        for (let i = 0; i < g.n; i++) { const t = sm[i]; if (!(t === t)) continue; k++; sum += t; if (t < win.lo) lo++; else if (t > win.hi) hi++; }
      }
      return k ? { below: lo / k, inside: (k - lo - hi) / k, above: hi / k, avg: sum / k } : null;
    });
  }

  /* The warm-up routine, built from what the runs showed. */
  function routine(info, session) {
    const { mode, win, runs: rs } = info;
    const steps = [];
    const known = rs.filter((r) => r.warmAt != null);
    // the lap of a run (1 = the first, usually the out lap) on which all four were in
    const lapsIn = known.length ? Math.round(U.median(known.map((r) => r.warmAt))) + 1 : null;
    const lagging = known.length ? U.median(known.map((r) => r.lastWheel)) : (rs.length && rs[0].lastWheel >= 0 ? rs[0].lastWheel : null);
    const lagAxle = lagging == null ? null : lagging < 2 ? 'front' : 'rear';
    steps.push({ title: 'Brake hard into every corner on the out lap', text: 'Brake firmly, short of locking, and carry good speed between the corners. In a back-to-back test, heavy braking warmed the tyres more than weaving did, and stop-and-go did no better.' });
    if (lagAxle === 'front') steps.push({ title: 'Work the fronts: they are last to come in', text: 'Use your hardest braking of the lap, and add a touch more steering than you need in the slow corners. A small, deliberate slide on the front heats its surface.' });
    else if (lagAxle === 'rear') steps.push({ title: 'Work the rears: they are last to come in', text: 'Accelerate firmly out of the slow corners in a low gear, without letting the rear wheels spin.' });
    const nth = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
    steps.push({ title: lapsIn != null ? (lapsIn <= 1 ? 'Push from the second lap of a run' : 'Push from the ' + nth(lapsIn) + ' lap of a run, not before') : 'Give the tyres two or three laps before pushing',
      text: lapsIn != null ? 'All four tyres reached ' + (mode === 'window' ? 'the window' : 'the temperature they settle at') + ' on the ' + nth(lapsIn) + ' lap ' + (known.length === 1 ? 'of this run' : 'of a run (the middle of ' + known.length + ' runs)') + ', counting the out lap as the first. Build up over the laps before it instead of attacking from the first corner.'
        : 'This recording does not show when they came in. GT3 tyres usually need a couple of laps; prototypes and hypercars take longer.' });
    steps.push(session.meta.sim === 'lmu'
      ? { title: 'Check against the pit menu', text: 'Le Mans Ultimate shows the ideal temperature for each compound in the pit menu. Enter it as this car\'s window below so the colours and advice use it.' }
      : { title: 'Stop in your pit box after the run', text: 'iRacing takes the carcass readings in the pit box. With those in the recording, the app can tell you whether the tyres finished in the window.' });
    if (info.hot) steps.push({ title: 'If they overheat later in the run', text: 'Cut the sliding: smoother steering and throttle, and let the car run straight on the straights so the surface can cool.' });
    return { steps, lapsIn, lagAxle };
  }

  /* Everything for one session. `grids` are the analysed laps (handling.analyse picks them). */
  function analyse(session, lapIdxs) {
    const mode = modeOf(session);
    if (!mode) return null;
    const win = windowFor(session.meta.sim, session.meta.car);
    const laps = (lapIdxs || []).map((i) => session.laps[i]).filter((l) => l && l.complete);
    const grids = laps.map((l) => S().lapGrid(session, l));
    const info = { mode, win, laps: laps.map((l) => l.idx), lapNums: laps.map((l) => l.num) };
    info.runs = warmup(session, mode, win);
    info.spots = hotSpots(session, grids, mode, win).map((x) => Object.assign(x, { tip: driveTip(x) }));
    if (mode === 'window') {
      info.shares = grids.length ? shares(grids, win) : null;
      info.avg = info.shares ? info.shares.map((x) => (x ? x.avg : NaN)) : null;
    } else {
      const withRead = info.runs.filter((r) => r.reading);
      // the reading for the run holding most of the analysed laps, else the latest one
      const holds = (r) => r.laps.filter((x) => info.laps.includes(x.idx)).length;
      const pick = withRead.slice().sort((a, b) => holds(b) - holds(a) || withRead.indexOf(b) - withRead.indexOf(a))[0];
      info.reading = pick ? pick.reading : null;
      info.avg = info.reading ? info.reading.rows.map((x) => x.avg) : null;
    }
    info.cold = info.avg ? info.avg.map((t) => t < win.lo) : [false, false, false, false];
    info.hot = info.avg ? info.avg.some((t) => t > win.hi) : false;
    info.routine = routine(info, session);
    return info;
  }

  /* Findings for the setup advice: an axle whose two tyres both sit outside the window. */
  function findings(info) {
    if (!info || !info.avg) return [];
    const out = [], src = info.mode === 'window' ? 'Average tyre temperature over laps ' + info.lapNums.join(', ') : 'Carcass readings iRacing took in the pits after lap ' + info.reading.afterLap;
    const winText = info.win.lo + '–' + info.win.hi + ' °C' + (info.win.mine ? ' (your window for this car)' : ' (a general guide; set the window for this car on the Driving technique tab)');
    for (const [axle, a, b] of [['front', 0, 1], ['rear', 2, 3]]) {
      const ta = info.avg[a], tb = info.avg[b], t = (ta + tb) / 2;
      const conf = info.win.mine ? 'medium' : 'low';
      if (ta < info.win.lo && tb < info.win.lo) out.push({ id: 'tyre-cold-' + axle, kind: 'tyreCold', axle, area: 'Tyres', title: (axle === 'front' ? 'Front' : 'Rear') + ' tyres below their window',
        detail: 'About ' + t.toFixed(0) + ' °C against a window of ' + winText + '.', evidence: src + '.', severity: U.clamp((info.win.lo - t) / 25, 0.2, 0.7), confidence: conf });
      else if (ta > info.win.hi && tb > info.win.hi) out.push({ id: 'tyre-hot-' + axle, kind: 'tyreHot', axle, area: 'Tyres', title: (axle === 'front' ? 'Front' : 'Rear') + ' tyres above their window',
        detail: 'About ' + t.toFixed(0) + ' °C against a window of ' + winText + '.', evidence: src + '.', severity: U.clamp((t - info.win.hi) / 25, 0.2, 0.7), confidence: conf });
    }
    return out;
  }

  STA.tyres = { DEFAULT, WHEEL_TEXT, REL_STEPS, WIN_STEPS, modeOf, windowFor, surface, lapMap, hotSpots, runs, warmup, shares, routine, analyse, findings, driveTip };
})(typeof window !== 'undefined' ? window : globalThis);
