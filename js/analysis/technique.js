/* Driving technique: what the driver can change, as opposed to the car.

   Two parts.
   1. Measured from the laps: where the driver's own best sections add up to a
      faster lap, which corners vary most from lap to lap, coasting, how the
      brake is applied and released, and how the throttle is picked up.
   2. For every handling finding, the usual ways to drive around it. These are
      what to try when a setup change did not do what was expected, or when the
      car has no setting left to move.

   Thresholds are general rules of thumb. Each item carries its evidence and a
   confidence so it can be weighed, not followed blindly. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, S = () => STA.session;

  const sec = (v) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)) + ' s';
  const kmh = (ms) => ms * 3.6;

  /* Laps close enough to the best to say something about the driving. */
  function pickLaps(session) {
    const timed = session.laps.filter((l) => l.complete && l.valid).sort((a, b) => a.time - b.time);
    if (!timed.length) return [];
    return timed.filter((l) => l.time <= timed[0].time * 1.05).slice(0, 12).sort((a, b) => a.idx - b.idx);
  }

  /* One section per corner: from half-way down the straight before it to half-way down the one after. */
  function sections(corners, n) {
    return corners.map((c, k) => ({
      c, a: k === 0 ? 0 : Math.round((corners[k - 1].b + c.a) / 2), b: k === corners.length - 1 ? n - 1 : Math.round((c.b + corners[k + 1].a) / 2),
    }));
  }

  /* Pedal work through one section of one lap. */
  function drive(g, sct, prevEnd) {
    const c = sct.c, st = S().cornerStats(g, c, prevEnd), dt = (i) => g.t[i] - g.t[i - 1];
    const o = { time: g.t[sct.b] - g.t[sct.a], min: st.min, dMin: st.dMin, brakeAt: st.brakeAt, throttleAt: st.throttleAt, peak: st.maxBrake,
      ramp: null, release: null, overlap: null, coast: 0, pickup: null, feed: null, heavy: false };
    // Brake application: from first touch to 90% of this stop's peak.
    let on = -1;
    if (st.brakeAt != null) on = Math.min(g.n - 1, Math.max(0, Math.round(st.brakeAt / g.step)));
    if (on >= 0 && st.maxBrake > 0.3) {
      o.heavy = st.maxBrake >= 0.6 && kmh(g.speed[on] - st.min) >= 40;
      for (let i = on; i <= st.iMin; i++) if (g.brake[i] >= 0.9 * st.maxBrake) { o.ramp = g.t[i] - g.t[on]; break; }
      // Release: last point the brake is on, measured against where the corner's side load starts.
      let rel = -1, half = -1;
      for (let i = Math.min(g.n - 1, st.iMin + Math.round(30 / g.step)); i >= on; i--) {
        if (rel < 0 && g.brake[i] > 0.05) rel = i;
        if (rel >= 0 && g.brake[i] >= 0.5 * st.maxBrake) { half = i; break; }
      }
      if (rel >= 0) { o.overlap = g.d[rel] - g.d[c.a]; if (half >= 0) o.release = g.t[rel] - g.t[half]; }
    }
    // Throttle pick-up: the first time it comes back on after the driver has been fully off it.
    let off = -1, pick = -1;
    const lookTo = Math.min(sct.b, st.iMin + Math.round(30 / g.step));
    for (let i = on >= 0 ? on : sct.a; i <= lookTo; i++) if (g.throttle[i] < 0.1) { off = i; break; }
    if (off >= 0) for (let i = off; i <= sct.b; i++) if (g.throttle[i] > 0.15 && g.brake[i] < 0.05) { pick = i; break; }
    // Coasting: neither pedal, at speed, from the start of the section until the throttle is back on.
    for (let i = sct.a + 1, end = pick >= 0 ? pick : sct.b; i <= end; i++) if (g.throttle[i] < 0.05 && g.brake[i] < 0.05 && g.speed[i] > 12) o.coast += dt(i);
    if (pick >= 0) {
      o.pickup = g.d[pick] - st.dMin; // negative = before the slowest point
      for (let i = pick; i <= sct.b; i++) if (g.throttle[i] > 0.95) { o.feed = g.t[i] - g.t[pick]; break; }
    }
    return o;
  }

  function conf(n) { return n >= 5 ? 'high' : n >= 3 ? 'medium' : 'low'; }

  function analyse(session, an) {
    const out = { laps: [], items: [], metrics: {}, ideal: null, notes: [] };
    const laps = pickLaps(session), corners = session.corners || [];
    if (!laps.length || !corners.length) { out.notes.push('Driving advice needs at least one complete timed lap with detectable corners.'); return out; }
    session._gridCap = Math.max(session._gridCap || 14, laps.length + 8);
    const grids = laps.map((l) => S().lapGrid(session, l));
    const scts = sections(corners, grids[0].n);
    out.laps = laps.map((l) => l.num);
    const lapWord = laps.length === 1 ? '1 lap' : laps.length + ' laps';
    // D[lap][section]
    const D = grids.map((g) => scts.map((sct, k) => drive(g, sct, k > 0 ? corners[k - 1].b : null)));
    const best = laps.reduce((a, l, i) => (l.time < laps[a].time ? i : a), 0);
    const half = Math.max(1, Math.ceil(laps.length / 2));
    const name = (k) => corners[k].name;
    const med = (k, f) => { const a = D.map((row) => f(row[k])).filter((v) => v != null && v === v); return a.length ? U.median(a) : null; };

    /* ---------- 1. your own best sections ---------- */
    if (laps.length >= 2) {
      const mins = scts.map((_, k) => D.reduce((a, row, i) => (row[k].time < D[a][k].time ? i : a), 0));
      const ideal = mins.reduce((s, li, k) => s + D[li][k].time, 0), bestSum = D[best].reduce((s, o) => s + o.time, 0);
      const gain = bestSum - ideal;
      const loss = scts.map((_, k) => ({ k, lost: D[best][k].time - D[mins[k]][k].time, from: mins[k] })).filter((x) => x.lost >= 0.04).sort((a, b) => b.lost - a.lost);
      out.ideal = { time: laps[best].time - gain, gain, sections: loss.map((x) => ({ corner: name(x.k), lost: x.lost, lap: laps[x.from].num })) };
      out.metrics.idealGain = +gain.toFixed(3);
      if (gain >= 0.1 && loss.length) {
        const why = (x) => {
          const a = D[best][x.k], b = D[x.from][x.k], bits = [];
          if (a.brakeAt != null && b.brakeAt != null && Math.abs(b.brakeAt - a.brakeAt) >= 4) bits.push('braked ' + Math.abs(b.brakeAt - a.brakeAt).toFixed(0) + ' m ' + (b.brakeAt > a.brakeAt ? 'later' : 'earlier'));
          if (Math.abs(kmh(b.min - a.min)) >= 2) bits.push(Math.abs(kmh(b.min - a.min)).toFixed(0) + ' km/h ' + (b.min > a.min ? 'faster' : 'slower') + ' at the slowest point');
          if (a.throttleAt != null && b.throttleAt != null && Math.abs(b.throttleAt - a.throttleAt) >= 4) bits.push('full throttle ' + Math.abs(b.throttleAt - a.throttleAt).toFixed(0) + ' m ' + (b.throttleAt < a.throttleAt ? 'earlier' : 'later'));
          return name(x.k) + ' ' + sec(x.lost) + ': lap ' + laps[x.from].num + (bits.length ? ' ' + bits.join(', ') : ' was quicker');
        };
        out.items.push({
          id: 'ideal', area: 'Lap time', gain, corners: loss.slice(0, 3).map((x) => name(x.k)), confidence: conf(laps.length),
          title: 'Best sections add up to ' + U.fmtLap(laps[best].time - gain) + ' (−' + gain.toFixed(2) + ' s)',
          detail: 'Lost on your best lap (lap ' + laps[best].num + '): ' + loss.slice(0, 3).map(why).join('; ') + '.',
          how: 'Copy the quicker lap in the first corner listed, then the next.',
          evidence: 'One section per corner, straight to straight. ' + lapWord + ' within 5% of your best.',
        });
      }
    }

    /* ---------- 2. repeatability ---------- */
    if (laps.length >= 3) {
      const spread = scts.map((_, k) => ({ k, sd: U.std(D.map((row) => row[k].time)) })).sort((a, b) => b.sd - a.sd);
      const lapSd = U.std(laps.map((l) => l.time));
      out.metrics.lapSpread = +lapSd.toFixed(3);
      const loose = spread.filter((x) => x.sd >= 0.1).slice(0, 3);
      if (loose.length && lapSd >= 0.25) out.items.push({
        id: 'repeat', area: 'Consistency', gain: null, corners: loose.map((x) => name(x.k)), confidence: conf(laps.length),
        title: 'Lap times vary ±' + sec(lapSd),
        detail: 'Mostly ' + loose.map((x) => name(x.k) + ' (±' + sec(x.sd) + ')').join(', ') + '.',
        how: 'One brake marker and one turn-in point per corner, every lap. Setup changes cannot be judged until laps repeat.',
        evidence: 'Spread of section times, ' + lapWord + '.',
      });
    }

    /* ---------- 3. coasting ---------- */
    {
      const perLap = D.map((row) => row.reduce((s, o) => s + o.coast, 0)), coast = U.median(perLap), share = coast / laps[best].time;
      out.metrics.coast = +share.toFixed(4);
      const where = scts.map((_, k) => ({ k, n: D.filter((row) => row[k].coast >= 0.3).length, t: med(k, (o) => o.coast) })).filter((x) => x.n >= half).sort((a, b) => b.t - a.t);
      if ((share >= 0.03 || coast >= 1.5) && where.length) out.items.push({
        id: 'coast', area: 'Pedals', gain: null, corners: where.slice(0, 4).map((x) => name(x.k)), confidence: conf(laps.length),
        title: 'Coasting ' + sec(coast) + ' a lap (' + (share * 100).toFixed(1) + '%)',
        detail: 'Mostly into ' + where.slice(0, 4).map((x) => name(x.k) + ' (' + sec(x.t) + ')').join(', ') + '.',
        how: 'Stay flat to the brake point, then keep one pedal lightly on through the corner. Ignore if saving fuel.',
        evidence: 'Both pedals under 5% above 43 km/h, median of ' + lapWord + '.',
      });
    }

    /* ---------- 4. brake application and release ---------- */
    {
      const stops = scts.map((_, k) => k).filter((k) => D.filter((row) => row[k].heavy).length >= half);
      const ramps = stops.map((k) => ({ k, v: med(k, (o) => (o.heavy ? o.ramp : null)) })).filter((x) => x.v != null);
      if (ramps.length) {
        const ramp = U.median(ramps.map((x) => x.v));
        out.metrics.brakeRamp = +ramp.toFixed(3);
        const slow = ramps.filter((x) => x.v >= 0.35).sort((a, b) => b.v - a.v);
        if (ramp >= 0.3 && slow.length) out.items.push({
          id: 'brake-ramp', area: 'Braking', gain: null, corners: slow.slice(0, 4).map((x) => name(x.k)), confidence: laps.length >= 3 ? 'medium' : 'low',
          title: 'Slow brake build-up (' + sec(ramp) + ' to peak)',
          detail: 'Slowest into ' + slow.slice(0, 4).map((x) => name(x.k) + ' (' + sec(x.v) + ')').join(', ') + '.',
          how: 'Hit peak pressure straight away, then ease off as the speed drops.',
          evidence: 'First brake to 90% of the stop\'s peak, stops of 40 km/h or more, median of ' + lapWord + '.',
        });
      }
      const ov = stops.filter((k) => corners[k].band !== 'high').map((k) => ({ k, v: med(k, (o) => o.overlap), r: med(k, (o) => o.release) })).filter((x) => x.v != null);
      if (ov.length) {
        out.metrics.trailOverlap = +U.median(ov.map((x) => x.v)).toFixed(1);
        const none = ov.filter((x) => x.v <= 0), entryUs = an && an.findings.some((f) => f.kind === 'understeer' && f.phase === 'entry');
        const entryOs = an && an.findings.some((f) => f.kind === 'oversteer' && f.phase === 'entry');
        if (none.length >= Math.max(2, Math.ceil(ov.length * 0.6)) && !entryOs) out.items.push({
          id: 'trail', area: 'Braking', gain: null, corners: none.slice(0, 4).map((x) => name(x.k)), confidence: entryUs ? 'medium' : 'low', relates: 'understeer|entry',
          title: 'Braking finished before turn-in',
          detail: 'Brake fully off before turning into ' + none.slice(0, 4).map((x) => name(x.k)).join(', ') + '.' + (entryUs ? ' Adds to the entry understeer.' : ''),
          how: 'Keep a little brake on into the corner and bleed it off to the apex. Start light.',
          evidence: 'Brake release point against where side load starts, median of ' + lapWord + '.',
        });
        const snap = ov.filter((x) => x.r != null && x.r < 0.12);
        if (snap.length >= Math.max(2, Math.ceil(ov.length * 0.6))) out.items.push({
          id: 'release', area: 'Braking', gain: null, corners: snap.slice(0, 4).map((x) => name(x.k)), confidence: 'low', relates: entryOs ? 'oversteer|entry' : 'understeer|entry',
          title: 'Abrupt brake release',
          detail: 'Half pressure to zero in under 0.12 s into ' + snap.slice(0, 4).map((x) => name(x.k)).join(', ') + '.',
          how: 'Ease the pedal out over the last part of the stop.',
          evidence: '50% of the stop\'s peak to under 5%, median of ' + lapWord + '.',
        });
      }
    }

    /* ---------- 5. throttle pick-up ---------- */
    {
      const slowC = scts.map((_, k) => k).filter((k) => corners[k].band !== 'high');
      const early = slowC.map((k) => ({ k, p: med(k, (o) => o.pickup), f: med(k, (o) => o.feed) })).filter((x) => x.p != null && x.f != null && x.p <= -8 && x.f >= 1.5);
      const exitUs = an && an.findings.some((f) => f.kind === 'understeer' && f.phase === 'exit');
      if (early.length >= 2) out.items.push({
        id: 'early-throttle', area: 'Throttle', gain: null, corners: early.slice(0, 4).map((x) => name(x.k)), confidence: exitUs ? 'medium' : 'low', relates: 'understeer|exit',
        title: 'Early, hesitant throttle',
        detail: early.slice(0, 4).map((x) => name(x.k) + ' (' + Math.abs(x.p).toFixed(0) + ' m before the slowest point, ' + sec(x.f) + ' to full)').join(', ') + '.' + (exitUs ? ' Adds to the exit understeer.' : ''),
        how: 'Wait until the car points at the exit, then one firm application.',
        evidence: 'First throttle over 15% against the slowest point, and time to 95%, median of ' + lapWord + '.',
      });
      const lifts = an && an.exits ? an.exits.repeat : [];
      if (lifts.length >= 2) out.items.push({
        id: 'relift', area: 'Throttle', gain: null, corners: lifts.slice(0, 4), confidence: laps.length >= 3 ? 'medium' : 'low', relates: 'oversteer|exit',
        title: 'Throttle on, then off again',
        detail: 'In ' + lifts.slice(0, 4).join(', ') + '.',
        how: 'Apply it later and more progressively. If the car still steps out, it is a setup problem.',
        evidence: 'Exit throttle traces, at least half of the laps.',
      });
    }

    /* ---------- 6. steering corrections ---------- */
    if (an && an.balance && grids[0].steer) {
      const amp = 0.05 * an.balance.steerRef, w = Math.max(2, Math.round(5 / grids[0].step));
      const count = (g, c) => {
        const s = U.smooth(g.steer.subarray(c.a, c.b + 1), w);
        let n = 0, ext = s[0], dir = 0;
        for (let i = 1; i < s.length; i++) {
          if (dir >= 0 && s[i] > ext) ext = s[i]; else if (dir <= 0 && s[i] < ext) ext = s[i];
          if (dir >= 0 && ext - s[i] > amp) { if (dir > 0) n++; dir = -1; ext = s[i]; }
          else if (dir <= 0 && s[i] - ext > amp) { if (dir < 0) n++; dir = 1; ext = s[i]; }
        }
        return n;
      };
      const busy = corners.map((c, k) => ({ k, n: U.median(grids.map((g) => count(g, c))) })).filter((x) => x.n >= 4).sort((a, b) => b.n - a.n);
      out.metrics.steerCorrections = busy.length;
      if (busy.length >= 2) out.items.push({
        id: 'sawing', area: 'Steering', gain: null, corners: busy.slice(0, 4).map((x) => name(x.k)), confidence: 'low',
        title: 'Repeated steering corrections',
        detail: busy.slice(0, 4).map((x) => name(x.k) + ' (' + Math.round(x.n) + ' reversals)').join(', ') + '.',
        how: 'One input in, one out: enter slightly slower. Check the steering trace for kerbs first.',
        evidence: 'Reversals of 5% or more of your usual steering range, median of ' + lapWord + '.',
      });
    }

    out.items.sort((a, b) => (b.gain || 0) - (a.gain || 0));
    return out;
  }

  /* Ways to drive around a handling problem. Keyed like the setup rules. */
  const TIPS = {
    'understeer|entry': ['Slow the car more before turn-in.', 'Trail the brake into the corner to keep weight on the front.', 'One smooth steering input; more lock will not help.'],
    'understeer|mid': ['Wait for the car to rotate before any throttle.', 'Later apex, slightly lower minimum speed.', 'If the front slides, take a little lock off.'],
    'understeer|exit': ['Delay throttle until you see the exit, then unwind as you apply it.', 'Later apex, so the car points down the straight sooner.'],
    'oversteer|entry': ['Brake hardest in a straight line and release smoothly.', 'Downshift later, not while turning.', 'Gentler first steering input.'],
    'oversteer|mid': ['Hold a small, steady throttle.', 'Ease off; do not lift suddenly.'],
    'oversteer|exit': ['Squeeze the throttle and open the steering together.', 'One gear higher out of slow corners.'],
    traction: ['Squeeze the throttle and open the steering together.', 'One gear higher out of slow corners.'],
    wheelspin: ['Feed in the first half of the throttle more slowly.', 'Straighten the car before full power; short-shift out of the slowest corners.'],
    frontLock: ['Peak pressure early, then ease off as the speed drops.', 'Finish heavy braking before steering.'],
    rearLock: ['Downshift later in the stop.', 'Keep the car straight for the hardest braking.'],
    brakeHot: ['Brake later and harder for less time; lift slightly before the biggest stops on long runs.'],
    bottoming: ['If it only happens over certain kerbs, change the line there first.'],
  };

  function forFinding(f) {
    if (f.kind === 'understeer' || f.kind === 'oversteer') return TIPS[f.kind + '|' + f.phase] || [];
    return TIPS[f.kind] || [];
  }

  /* Tips for a setup change that did not work, from what it was meant to fix. */
  function forTargets(targets) {
    const seen = new Set(), out = [];
    for (const t of targets || []) for (const tip of forFinding(t)) if (!seen.has(tip)) { seen.add(tip); out.push(tip); }
    return out;
  }

  STA.technique = { analyse, forFinding, forTargets, TIPS, pickLaps };
})(typeof window !== 'undefined' ? window : globalThis);
