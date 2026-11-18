/* Suggests a starting setup for a car at a track.

   Order of preference, checked every time before anything new is proposed:
     1. a setup you were already working on for this car at this track
     2. a setup of yours for this car at another track, adapted to this one
     3. the sim's own baseline (or any setup you pick), adapted to this track

   "Adapted" means a small number of general changes driven by the track's
   character (how much of the lap is flat out, how the corners split between
   slow and fast, how bumpy it is), your stated preference for a stable or a
   lively car, and balance problems that keep showing up in your earlier
   sessions with the same car. It is a starting point to be refined with the
   setup advice, not a tuned setup. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  const isSimBaseline = (s) => !!(s.tags && s.tags.simBaseline) || /\bbaseline\b|\bdefault\b|\bfixed\b/i.test(s.name || '');

  /* Look through the library for earlier work on this car. */
  function findPrevious(allSetups, q) {
    const mine = allSetups.filter((s) => s.sim === q.sim);
    const car = (s) => STA.library.sameCar(s.car, q.car), track = (s) => STA.library.sameTrack(s.track, q.track);
    const recent = (a, b) => ((b.usage && b.usage.lastUsed) || b.createdAt || 0) - ((a.usage && a.usage.lastUsed) || a.createdAt || 0);
    const work = (s) => !isSimBaseline(s);
    const sameCombo = mine.filter((s) => car(s) && track(s) && work(s)).sort(recent);
    const sameCar = mine.filter((s) => car(s) && !track(s) && work(s)).sort(recent);
    const sameClassTrack = q.carClass ? mine.filter((s) => !car(s) && track(s) && work(s) && U.slug(s.carClass) === U.slug(q.carClass)).sort(recent) : [];
    const simBaselines = mine.filter((s) => car(s) && isSimBaseline(s)).sort((a, b) => (track(b) ? 1 : 0) - (track(a) ? 1 : 0) || recent(a, b));
    return { sameCombo, sameCar, sameClassTrack, simBaselines };
  }

  /* Which starting point to recommend, in words. */
  function recommend(prev) {
    if (prev.sameCombo.length) {
      const s = prev.sameCombo[0];
      return { mode: 'continue', setup: s, text: 'You already have a setup in progress for this car at this track. Carry on from it rather than starting again.' };
    }
    if (prev.sameCar.length) return { mode: 'adapt', setup: prev.sameCar[0], text: 'No setup yet for this track, but you have one for this car at ' + prev.sameCar[0].track + '. Adapt that one to this track.' };
    if (prev.simBaselines.length) return { mode: 'new', setup: prev.simBaselines[0], text: 'No earlier setup of yours for this car. Start from the sim baseline and adapt it to this track.' };
    return { mode: 'none', setup: null, text: 'No setup for this car in the library yet. Load the sim baseline (or any setup for this car) first, then build from it.' };
  }

  /* Describe a track in words from its measured profile. */
  function readTrack(profile, pref) {
    pref = pref || {};
    const out = { downforce: 'medium', surface: 'smooth', corners: 'mixed', why: [] };
    if (pref.downforce && pref.downforce !== 'auto') { out.downforce = pref.downforce; out.why.push('Downforce level set by you: ' + pref.downforce + '.'); }
    else if (profile) {
      const wot = profile.wot;
      out.downforce = wot >= 0.66 ? 'low' : wot <= 0.50 ? 'high' : 'medium';
      out.why.push(Math.round(wot * 100) + '% of the lap is at full throttle, which points to ' + out.downforce + ' downforce.');
    } else out.why.push('No telemetry for this track yet, so medium downforce is assumed.');
    if (pref.surface && pref.surface !== 'auto') { out.surface = pref.surface; out.why.push('Surface set by you: ' + pref.surface + '.'); }
    else if (profile && profile.bump != null && profile.bump > 0.22) { out.surface = 'bumpy'; out.why.push('Vertical G varies a lot over the lap, so the surface is treated as bumpy.'); }
    if (pref.corners && pref.corners !== 'auto') { out.corners = pref.corners; out.why.push('Corner mix set by you: ' + pref.corners + '.'); }
    else if (profile) {
      if (profile.tLow > 0.33 && profile.tHigh < 0.10) out.corners = 'slow';
      else if (profile.tHigh > 0.20 && profile.tLow < 0.25) out.corners = 'fast';
      out.why.push(Math.round(profile.tLow * 100) + '% of the lap is spent in slow corners and ' + Math.round(profile.tHigh * 100) + '% in fast ones (' + out.corners + ' mix).');
    }
    return out;
  }

  /* Build a baseline on top of `reference`.
     opts = { profile, pref: { downforce, surface, corners, balance: 'stable'|'neutral'|'lively' },
              tendencies: [{ kind, phase, band, count }], track, name } */
  function build(reference, opts) {
    opts = opts || {};
    const pref = opts.pref || {}, track = readTrack(opts.profile, pref);
    const net = new Map();
    const want = (role, axle, n, why) => {
      const key = role + '|' + (axle || '');
      const e = net.get(key) || { role, axle, n: 0, why: [] };
      e.n += n; e.why.push(why); net.set(key, e);
    };

    if (track.downforce === 'low') { want('rearWing', 'rear', -2, 'Low-downforce track'); want('frontAero', 'front', -1, 'Keeps aero balance with the smaller rear wing'); }
    if (track.downforce === 'high') { want('rearWing', 'rear', 2, 'High-downforce track'); want('frontAero', 'front', 1, 'Keeps aero balance with the larger rear wing'); }
    if (track.surface === 'bumpy') {
      want('spring', 'front', -1, 'Bumpy surface'); want('spring', 'rear', -1, 'Bumpy surface');
      want('rideHeight', 'front', 1, 'Clearance on a bumpy surface'); want('rideHeight', 'rear', 1, 'Clearance on a bumpy surface');
      want('fastBump', 'front', -1, 'Absorbs bumps and kerbs'); want('fastBump', 'rear', -1, 'Absorbs bumps and kerbs');
    }
    if (track.corners === 'slow') { want('arb', 'rear', -1, 'Traction out of slow corners'); want('diffPreload', null, -1, 'Rotation in slow corners'); }
    if (track.corners === 'fast') { want('arb', 'front', 1, 'Sharper response in fast corners'); }
    if (pref.balance === 'stable') { want('arb', 'rear', -1, 'You asked for a stable car'); want('brakeBias', null, 1, 'You asked for a stable car'); }
    if (pref.balance === 'lively') { want('arb', 'front', -1, 'You asked for a car that rotates'); want('brakeBias', null, -1, 'You asked for a car that rotates'); }

    // Balance problems seen repeatedly with this car in earlier sessions.
    const usedHistory = [];
    for (const tnd of opts.tendencies || []) {
      if (tnd.count < 2) continue;
      const opt = STA.advisor.ruleFor(tnd).find((x) => {
        const axle = x.axle === '@' ? tnd.axle : x.axle;
        return STA.advisor.resolve(reference, x.role, axle || null, x.dir, { blocked: opts.blocked || null, limits: opts.limits || null }).params.length > 0;
      });
      if (!opt) continue;
      want(opt.role, opt.axle === '@' ? tnd.axle : opt.axle, opt.dir === '+' ? 1 : -1, 'Seen in ' + tnd.count + ' earlier sessions: ' + tnd.title);
      usedHistory.push(tnd.title);
    }

    const setup = STA.setup.clone(reference, {
      name: opts.name || 'App baseline – ' + (opts.track || reference.track), track: opts.track || reference.track,
      source: 'baseline', parentId: reference.id, status: 'in progress', tags: {},
    });
    for (const p of setup.params) delete p.note;
    const changes = [], notApplied = [], blocked = { blocked: opts.blocked || null, limits: opts.limits || null }, touched = new Set();
    for (const e of net.values()) {
      if (!e.n) continue;
      const n = U.clamp(e.n, -3, 3), dir = n > 0 ? '+' : '-';
      const why = Array.from(new Set(e.why)).join('; ');
      // The wanted setting first, then other ways to get the same effect if it cannot move.
      const tries = [{ role: e.role, axle: e.axle || null, dir }].concat(STA.advisor.equivalents(e.role, e.axle || null, dir));
      let done = false, firstWhy = null;
      for (const t of tries) {
        const key = t.role + '|' + (t.axle || '');
        if (t !== tries[0] && (touched.has(key) || net.has(key))) continue; // do not stack onto a setting the baseline already moves
        const r = STA.advisor.resolve(setup, t.role, t.axle, t.dir, blocked);
        if (!r.params.length) { if (!firstWhy) firstWhy = r.why; continue; }
        const change = STA.advisor.buildChange(t.role, t.dir, r.params, t === tries[0] ? Math.abs(n) : 1);
        const from = STA.setup.describe(r.params);
        let applied = 0, short = false;
        for (const p of r.params) {
          const res = STA.setup.applyChange(p, Object.assign({ why: e.why[0] }, change));
          if (!res.atLimit) applied++;
          if (res.moved != null && change.steps && Math.abs(res.moved) < Math.abs(change.steps)) short = true;
        }
        if (!applied) { if (!firstWhy) firstWhy = STA.advisor.labelFor(t.role, t.axle) + ' (already at the end of its range)'; continue; }
        if (short) change.text += ' (fewer steps were available)';
        touched.add(key);
        changes.push({ label: STA.advisor.labelFor(t.role, t.axle), from, to: STA.setup.describe(r.params), text: change.text,
          why: why + (t === tries[0] ? '' : '. Used instead of: ' + firstWhy) });
        done = true; break;
      }
      if (!done) notApplied.push({ label: STA.advisor.labelFor(e.role, e.axle), why, reason: (firstWhy || 'not adjustable on this car').replace(/^.*?\((.*)\)$/, '$1') });
    }
    STA.setup.refresh(setup);
    return { setup, changes, notApplied, track, usedHistory };
  }

  /* Count how often each balance finding shows up across stored sessions of this car. */
  function tendencies(sessionSummaries, q) {
    const counts = new Map();
    for (const s of sessionSummaries) {
      if (s.sim !== q.sim || !STA.library.sameCar(s.car, q.car)) continue;
      for (const t of s.tendencies || []) {
        if (t.kind !== 'understeer' && t.kind !== 'oversteer') continue;
        const e = counts.get(t.id) || Object.assign({ count: 0 }, t);
        e.count++; counts.set(t.id, e);
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
  }

  STA.baseline = { findPrevious, recommend, readTrack, build, tendencies, isSimBaseline };
})(typeof window !== 'undefined' ? window : globalThis);
