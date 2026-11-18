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
  const list = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

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
          if (Math.abs(kmh(b.min - a.min)) >= 2) bits.push('was ' + Math.abs(kmh(b.min - a.min)).toFixed(0) + ' km/h ' + (b.min > a.min ? 'faster' : 'slower') + ' at the slowest point');
          if (a.throttleAt != null && b.throttleAt != null && Math.abs(b.throttleAt - a.throttleAt) >= 4) bits.push('was at full throttle ' + Math.abs(b.throttleAt - a.throttleAt).toFixed(0) + ' m ' + (b.throttleAt < a.throttleAt ? 'earlier' : 'later'));
          return name(x.k) + ': ' + sec(x.lost) + ' (lap ' + laps[x.from].num + (bits.length ? ' ' + list(bits) : ' was quicker through it') + ')';
        };
        out.items.push({
          id: 'ideal', area: 'Lap time', gain, corners: loss.slice(0, 3).map((x) => name(x.k)), confidence: conf(laps.length),
          title: 'Your best sections add up to ' + U.fmtLap(laps[best].time - gain) + ', ' + sec(gain) + ' quicker than your best lap',
          detail: 'Compared with your best lap (lap ' + laps[best].num + '), you have already driven these parts faster. ' + loss.slice(0, 3).map(why).join('. ') + '.',
          how: 'This time is available without touching the setup, because you have already done it. Take the first corner on the list, repeat what the quicker lap did there until it is normal, then move to the next.',
          evidence: 'Each lap is split into one section per corner, from half-way down the straight before it to half-way down the one after. Based on ' + lapWord + ' within 5% of your best.',
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
        title: 'Lap times vary by ±' + sec(lapSd) + ', mostly in ' + list(loose.map((x) => name(x.k))),
        detail: loose.map((x) => name(x.k) + ' varies by ±' + sec(x.sd)).join(', ') + ' from lap to lap.',
        how: 'Pick one braking marker and one turn-in point for each of these corners and hit them every lap before trying to go faster. Until the laps repeat, a setup change worth a tenth cannot be told apart from normal variation, so the setup advice is less reliable too.',
        evidence: 'Standard deviation of section times over ' + lapWord + '.',
      });
    }

    /* ---------- 3. coasting ---------- */
    {
      const perLap = D.map((row) => row.reduce((s, o) => s + o.coast, 0)), coast = U.median(perLap), share = coast / laps[best].time;
      out.metrics.coast = +share.toFixed(4);
      const where = scts.map((_, k) => ({ k, n: D.filter((row) => row[k].coast >= 0.3).length, t: med(k, (o) => o.coast) })).filter((x) => x.n >= half).sort((a, b) => b.t - a.t);
      if ((share >= 0.03 || coast >= 1.5) && where.length) out.items.push({
        id: 'coast', area: 'Pedals', gain: null, corners: where.slice(0, 4).map((x) => name(x.k)), confidence: conf(laps.length),
        title: 'You are on neither pedal for ' + sec(coast) + ' a lap (' + (share * 100).toFixed(1) + '% of the lap)',
        detail: 'Most of it is into ' + list(where.slice(0, 4).map((x) => name(x.k) + ' (' + sec(x.t) + ')')) + '.',
        how: 'Stay on full throttle up to the brake point instead of lifting early, and between releasing the brake and picking up the throttle keep one of the two lightly applied. If you are lifting early because the braking point feels uncertain, move the marker later a few metres at a time. Ignore this if you are saving fuel or energy on purpose.',
        evidence: 'Throttle and brake both under 5% above 43 km/h, median of ' + lapWord + '.',
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
          title: 'You build up brake pressure gradually (' + sec(ramp) + ' to reach the peak of a big stop)',
          detail: 'Slowest to reach peak pressure into ' + list(slow.slice(0, 4).map((x) => name(x.k) + ' (' + sec(x.v) + ')')) + '.',
          how: 'Go to peak pressure quickly at the start of the stop, when the car is fastest and has the most grip and downforce, then ease the pedal as the speed comes down. That shortens the stop, so the brake point can move later.',
          evidence: 'Time from first brake to 90% of that stop\'s peak, for stops of at least 40 km/h. Median of ' + lapWord + '.',
        });
      }
      const ov = stops.filter((k) => corners[k].band !== 'high').map((k) => ({ k, v: med(k, (o) => o.overlap), r: med(k, (o) => o.release) })).filter((x) => x.v != null);
      if (ov.length) {
        out.metrics.trailOverlap = +U.median(ov.map((x) => x.v)).toFixed(1);
        const none = ov.filter((x) => x.v <= 0), entryUs = an && an.findings.some((f) => f.kind === 'understeer' && f.phase === 'entry');
        const entryOs = an && an.findings.some((f) => f.kind === 'oversteer' && f.phase === 'entry');
        if (none.length >= Math.max(2, Math.ceil(ov.length * 0.6)) && !entryOs) out.items.push({
          id: 'trail', area: 'Braking', gain: null, corners: none.slice(0, 4).map((x) => name(x.k)), confidence: entryUs ? 'medium' : 'low', relates: 'understeer|entry',
          title: 'You finish braking before you turn in',
          detail: 'The brake is fully released before the car starts to turn into ' + list(none.slice(0, 4).map((x) => name(x.k))) + '.' + (entryUs ? ' The telemetry also shows entry understeer, which this makes worse: with the brake off, weight leaves the front tyres just as you ask them to turn.' : ''),
          how: 'Brake at the same point, but keep a little brake on as you turn in and let it off progressively towards the slowest point of the corner. Start with a light trail in one slow corner; too much will make the rear loose.',
          evidence: 'Where the brake drops under 5% compared with where side load starts to build. Median of ' + lapWord + '.',
        });
        const snap = ov.filter((x) => x.r != null && x.r < 0.12);
        if (snap.length >= Math.max(2, Math.ceil(ov.length * 0.6))) out.items.push({
          id: 'release', area: 'Braking', gain: null, corners: snap.slice(0, 4).map((x) => name(x.k)), confidence: 'low', relates: entryOs ? 'oversteer|entry' : 'understeer|entry',
          title: 'You come off the brake abruptly',
          detail: 'From half pressure to nothing takes under 0.12 s into ' + list(snap.slice(0, 4).map((x) => name(x.k))) + '. The nose rises quickly and the balance changes just as the car turns.',
          how: 'Let the pedal out smoothly over the last part of the stop, as if you were trying not to rock the car.',
          evidence: 'Time from 50% of the stop\'s peak pressure to under 5%. Median of ' + lapWord + '.',
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
        title: 'You pick up the throttle early and then wait on part throttle',
        detail: list(early.slice(0, 4).map((x) => name(x.k) + ' (' + Math.abs(x.p).toFixed(0) + ' m before the slowest point, then ' + sec(x.f) + ' to full throttle)')) + '.' + (exitUs ? ' The telemetry also shows exit understeer: early throttle moves weight off the front before the car has finished turning.' : ''),
        how: 'Wait a moment longer, until the car is pointing at the exit, then open the throttle once and go to full in one movement. A later, firmer application is usually faster down the next straight than an early, hesitant one.',
        evidence: 'First throttle over 15% compared with the slowest point of the corner, and time from there to 95%. Median of ' + lapWord + '.',
      });
      const lifts = an && an.exits ? an.exits.repeat : [];
      if (lifts.length >= 2) out.items.push({
        id: 'relift', area: 'Throttle', gain: null, corners: lifts.slice(0, 4), confidence: laps.length >= 3 ? 'medium' : 'low', relates: 'oversteer|exit',
        title: 'You go back off the throttle after applying it',
        detail: 'In ' + list(lifts.slice(0, 4)) + ' the throttle is opened, then closed again before reaching full.',
        how: 'The first application is too early or too sharp for the grip available. Apply it a little later and more progressively so it only moves one way. If the car still steps out with a smooth application, that is a setup problem: see the traction items in the setup advice.',
        evidence: 'Throttle traces out of each corner, on at least half of the laps analysed.',
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
        title: 'You make several steering corrections inside the corner',
        detail: list(busy.slice(0, 4).map((x) => name(x.k) + ' (' + Math.round(x.n) + ' reversals)')) + '.',
        how: 'Aim for one input in and one out. Repeated corrections mean the car is past the grip limit for part of the corner: enter slightly slower, or look at the balance findings for that corner phase. Kerbs and force-feedback noise can also cause this, so check the steering trace in the lap comparison first.',
        evidence: 'Reversals of at least 5% of your usual steering range, median of ' + lapWord + '.',
      });
    }

    out.items.sort((a, b) => (b.gain || 0) - (a.gain || 0));
    return out;
  }

  /* Ways to drive around a handling problem. Keyed like the setup rules. */
  const TIPS = {
    'understeer|entry': [
      'Slow the car a little more before turning in. Arriving too fast is the most common cause of entry understeer, and no setup change cures it.',
      'Carry a little brake into the corner and release it gradually (trail braking). It keeps weight on the front tyres while they start to turn the car.',
      'Turn in once, smoothly. Adding more lock when the front is already sliding scrubs speed and overheats the tyres without turning the car.',
    ],
    'understeer|mid': [
      'Wait for the car to rotate before touching the throttle. Even light throttle takes weight off the front.',
      'Try a slightly later apex with a lower minimum speed: the car spends less time at full steering lock and the exit opens up.',
      'If the front is sliding, take a little steering off. Past the tyre\'s peak, less lock gives more grip.',
    ],
    'understeer|exit': [
      'Delay the throttle until you can see the exit, then unwind the steering as you apply it. Steering and power share the same front grip in a front- or four-wheel-drive car, and in a rear-drive car power pushes the nose wide.',
      'Use a later apex in the corners listed so the car is pointing down the straight earlier.',
    ],
    'oversteer|entry': [
      'Do the hardest braking in a straight line and come off the pedal smoothly. Heavy trail braking or a sudden release unloads the rear as you turn.',
      'Downshift a little later, or avoid the last downshift while turning. Engine braking on the driven rear axle helps the rear step out.',
      'Make the first steering input gentler so the weight moves sideways after the rear has settled.',
    ],
    'oversteer|mid': [
      'Hold a small, steady throttle through the middle of the corner. It keeps weight on the rear tyres.',
      'Avoid lifting suddenly once the car is loaded up; ease off instead.',
    ],
    'oversteer|exit': [
      'Squeeze the throttle on progressively and open the steering as you do. Wait until the car is straighter before going to full throttle.',
      'Use one gear higher out of slow corners. It softens the torque reaching the rear tyres.',
    ],
    traction: [
      'Squeeze the throttle on progressively and open the steering as you do.',
      'Use one gear higher out of slow corners to soften the torque at the driven wheels.',
    ],
    wheelspin: [
      'Feed in the first half of the throttle travel more slowly, and take a gear higher out of the slowest corners.',
      'Straighten the car before asking for full power: a tyre that is cornering hard has little grip left for acceleration.',
    ],
    frontLock: [
      'Hit peak pressure early, then ease the pedal as the car slows. The tyres can take less braking at low speed, especially in a car with downforce, so holding peak pressure to the end of the stop locks the fronts.',
      'Finish the heavy braking before adding steering. A front tyre asked to brake and turn at once locks sooner.',
    ],
    rearLock: [
      'Downshift later in the stop, when the revs are lower. Early downshifts add engine braking to the rear axle.',
      'Keep the car straight for the hardest part of the stop.',
    ],
    brakeHot: [
      'Brake later and harder for a shorter time, not lightly for a long time. On long runs, lifting slightly before the heaviest stops also takes heat out.',
    ],
    bottoming: [
      'If it only happens over particular kerbs or bumps, a different line there may be all that is needed before raising the car.',
    ],
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
