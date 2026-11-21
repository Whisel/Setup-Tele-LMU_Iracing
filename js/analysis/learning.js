/* Learns from what happened after earlier setup changes.

   Every session leaves a short record in the library (no raw telemetry): the
   balance in each corner phase, the findings, lap times and the setup that was
   on the car. When two consecutive sessions with the same car at the same
   track used different setups, the app treats every changed setting as a small
   experiment:

     why       what the change was for. Inferred from the general rules (it is a
               usual answer to a finding in the earlier session), or stated by
               the driver when the app asks.
     expected  the lap gets faster where the change acts (see pace.js), and the
               problem it was aimed at gets smaller.
     got       time gained or lost where it acts, and how the problem moved.
     result    helped (faster), no clear difference, or worse (slower). Lap time
               decides: a problem that got smaller without the lap getting
               faster is not counted as having helped.
     rethink   when the expectation was not met, the most likely reason: step
               too small, this setting does not drive the problem on this car,
               it went the wrong way, it is the driving, or the problem was not
               what was costing time.

   It works in the other direction too. When a problem got better and nothing
   that changed was aimed at it, the change is credited with it. Seen cleanly,
   that becomes something the app offers for that problem on this car from then
   on, even though it is not a textbook answer.

   Everything is counted per car and fed back into the setup advice. The more
   sessions are loaded, the more the advice reflects this car and this driver
   rather than general rules.

   What it cannot know: lap time also moves with track temperature, fuel, tyre
   wear, traffic and practice. One before/after pair is weak evidence, which is
   why a change is only moved to the bottom after two results against it and a
   learned link needs one clean result (a single change) or two shared ones. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const AD = () => STA.advisor;

  const isBalance = (f) => f.kind === 'understeer' || f.kind === 'oversteer';
  /* A problem, without the speed band: "understeer|mid", "frontLock". */
  const targetKey = (f) => (isBalance(f) ? f.kind + '|' + f.phase : f.kind);
  const TARGET_TEXT = {
    'understeer|entry': 'entry understeer', 'understeer|mid': 'mid-corner understeer', 'understeer|exit': 'exit understeer',
    'oversteer|entry': 'entry oversteer', 'oversteer|mid': 'mid-corner oversteer', 'oversteer|exit': 'exit oversteer',
    frontLock: 'front locking', rearLock: 'rear locking', wheelspin: 'wheelspin', traction: 'exit traction', bottoming: 'bottoming',
    camberTooMuch: 'too much camber', camberTooLittle: 'too little camber', pressureHigh: 'high tyre pressure', pressureLow: 'low tyre pressure',
    brakeHot: 'brake temperature', limiter: 'hitting the limiter', lap: 'lap time', pace: 'lap time',
  };
  const targetText = (k) => TARGET_TEXT[k] || k;
  const lower = (t) => String(t || '').replace(/^./, (c) => c.toLowerCase());

  /* What to keep from a session so later sessions can be compared with it. */
  function snapshot(session, an, tech) {
    const timed = session.laps.filter((l) => l.complete && l.valid).map((l) => l.time).sort((a, b) => a - b);
    const near = timed.filter((t) => t <= timed[0] * 1.03);
    const out = { v: 4, prof: STA.pace ? STA.pace.profile(session, an && an.balance ? an.balance.gmax : null) : null, medianLap: near.length ? U.median(near) : null, lapSpread: near.length >= 3 ? U.std(near) : null, findings: [], balance: null, metrics: {}, habits: [] };
    if (!an) return out;
    out.findings = an.findings.map((f) => ({ id: f.id, kind: f.kind, phase: f.phase, band: f.band, axle: f.axle, title: f.title, severity: +f.severity.toFixed(3) }));
    out.tendencies = out.findings; // name used by the baseline builder
    if (an.balance) {
      out.balance = {};
      for (const ph of STA.handling.PHASES) {
        out.balance[ph] = {};
        for (const b of STA.handling.BANDS.concat('all')) { const v = an.balance.matrix[ph][b].idx; out.balance[ph][b] = v == null ? null : +v.toFixed(3); }
      }
    }
    if (an.wheels) Object.assign(out.metrics, { frontLock: an.wheels.frontLock, rearLock: an.wheels.rearLock, rearSpin: an.wheels.rearSpin });
    if (an.exits && an.exits.tcShare != null) out.metrics.tcShare = an.exits.tcShare;
    if (tech && tech.metrics) Object.assign(out.metrics, tech.metrics);
    // Driving habits that look like a handling problem, so a failed setup change can be told apart from the driving.
    if (tech) out.habits = tech.items.filter((x) => x.relates).map((x) => ({ relates: x.relates, title: x.title }));
    return out;
  }

  /* Settings that differ between two setups, as { role, axle, dir } with '+' meaning the value went up. */
  /* Aero choices that are words, not numbers ("None" / "5mm", "Low DF flap" / "High DF flap",
     "Medium DF"): ranked so a change between them has a direction. */
  const TEXT_LEVEL = { rearAeroPart: 1, frontAeroPart: 1, aeroTrim: 1 };
  function level(p) {
    const s = String(p.raw).toLowerCase();
    if (/^\s*(none|off|no)\b/.test(s)) return 0;
    if (/low/.test(s)) return 1;
    if (/med/.test(s)) return 2;
    if (/high/.test(s)) return 3;
    return U.isNum(p.num) ? p.num : null;
  }

  function changesBetween(a, b) {
    if (!a || !b) return [];
    const bMap = new Map(b.params.map((p) => [p.id, p])), groups = new Map();
    for (const pa of a.params) {
      const pb = bMap.get(pa.id);
      if (!pb || pa.derived || !pa.role || !AD().ROLE[pa.role]) continue;
      let d = null;
      if (U.isNum(pa.num) && U.isNum(pb.num) && String(pa.unit).toLowerCase() === String(pb.unit).toLowerCase()) d = pb.num - pa.num;
      else if (pa.index != null && pb.index != null) d = pb.index - pa.index;
      else if (TEXT_LEVEL[pa.role]) { const x = level(pa), y = level(pb); if (x != null && y != null) d = y - x; }
      if (!d || Math.abs(d) < 1e-9) continue;
      const key = pa.role + '|' + (pa.axle || '');
      const g = groups.get(key) || { role: pa.role, axle: pa.axle || null, up: 0, down: 0, from: [], to: [] };
      if (d > 0) g.up++; else g.down++;
      g.from.push(pa.raw); g.to.push(pb.raw); groups.set(key, g);
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.up && g.down) continue; // left and right moved opposite ways: no single direction to judge
      const dir = g.up ? '+' : '-';
      out.push({ role: g.role, axle: g.axle, dir, key: AD().blockKey(g.role, g.axle, dir), title: AD().titleFor(g.role, dir, g.axle),
        from: Array.from(new Set(g.from)).join(' / '), to: Array.from(new Set(g.to)).join(' / ') });
    }
    return out;
  }

  /* The rule that makes this change a usual answer to this finding, or null. */
  function ruleMatch(change, f) {
    for (const opt of AD().ruleFor(f)) {
      const axle = (opt.axle === '@' ? f.axle : opt.axle) || null;
      if (opt.role === change.role && axle === change.axle && opt.dir === change.dir) return opt;
      for (const e of AD().equivalents(opt.role, axle, opt.dir)) if (e.role === change.role && (e.axle || null) === change.axle && e.dir === change.dir) return opt;
    }
    return null;
  }
  const addresses = (change, f) => !!ruleMatch(change, f);

  /* ---------- the driver's own reason for a change ---------- */

  const GENERIC = [
    ['g:understeer|entry', 'Understeer on entry'], ['g:understeer|mid', 'Understeer mid-corner'], ['g:understeer|exit', 'Understeer on exit'],
    ['g:oversteer|entry', 'Oversteer on entry'], ['g:oversteer|mid', 'Oversteer mid-corner'], ['g:oversteer|exit', 'Oversteer on exit'],
    ['g:frontLock', 'Front wheels locking'], ['g:rearLock', 'Rear wheels locking'], ['g:wheelspin', 'Traction or wheelspin'],
    ['lap', 'Lap time (top speed, tyres, other)'], ['none', 'Just trying it'],
  ];
  /* What the driver can pick when asked "what was this for?" */
  function intentChoices(before) {
    return ((before && (before.findings || before.tendencies)) || []).map((f) => ({ value: 'f:' + f.id, label: f.title + ' (seen in that run)' }))
      .concat(GENERIC.map(([value, label]) => ({ value, label })));
  }
  const METRIC = { frontLock: 'frontLock', rearLock: 'rearLock', wheelspin: 'rearSpin' };
  function resolveIntent(value, before) {
    if (!value || value === 'none') return null;
    if (value === 'lap') return { id: 'your-lap', kind: 'lap', title: 'Lap time', stated: true };
    if (value.slice(0, 2) === 'f:') {
      const f = ((before.findings || before.tendencies) || []).find((x) => x.id === value.slice(2));
      return f ? Object.assign({ stated: true }, f) : null;
    }
    const k = value.slice(2), parts = k.split('|');
    const f = { id: 'your-' + k, kind: parts[0], stated: true, title: targetText(k).replace(/^./, (c) => c.toUpperCase()) };
    if (parts[1]) { f.phase = parts[1]; f.band = 'all'; } else f.metric = METRIC[k];
    return f;
  }

  /* ---------- how one problem moved ---------- */

  const pct = (v) => { const r = Math.round(v * 100); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + '%'; };

  /* word: better | slight (right way, small) | same | worse | overshot | unknown.  gain: improvement, positive is better. */
  function movement(f, before, after, lap) {
    if (f.kind === 'lap') {
      if (!lap || lap.rel == null) return { text: 'no lap times', word: 'unknown', gain: 0 };
      return { text: lap.word === 'same' ? 'no real change' : Math.abs(lap.rel * 100).toFixed(2) + '% ' + lap.word, word: lap.word === 'faster' ? 'better' : lap.word === 'slower' ? 'worse' : 'same', gain: -lap.rel };
    }
    if (isBalance(f) && before.balance && after.balance && f.phase && f.band) {
      const x = before.balance[f.phase][f.band], y = after.balance[f.phase][f.band];
      if (x != null && y != null) {
        const us = f.kind === 'understeer', gain = us ? x - y : y - x, big = us ? 0.05 : 0.03, small = us ? 0.02 : 0.012;
        // Only "too far" if it started on the problem side and ended up past neutral on the other.
        const over = us ? x > -0.10 && y <= -0.10 : x < 0.25 && y >= 0.25;
        // absent: the telemetry did not show this problem before the change.
        return { text: pct(x) + ' → ' + pct(y), gain, absent: us ? x < 0.10 : x > -0.04, word: over ? 'overshot' : gain >= big ? 'better' : gain >= small ? 'slight' : gain <= -big ? 'worse' : 'same' };
      }
    }
    if (f.metric) {
      const x = (before.metrics || {})[f.metric], y = (after.metrics || {})[f.metric];
      if (!U.isNum(x) || !U.isNum(y)) return { text: 'not measured', word: 'unknown', gain: 0 };
      const gain = x - y;
      return { text: (x * 100).toFixed(1) + '% → ' + (y * 100).toFixed(1) + '% of the time', gain, word: gain >= 0.01 && y <= x * 0.7 ? 'better' : gain <= -0.01 && y >= x * 1.3 ? 'worse' : 'same' };
    }
    const was = (before.findings || before.tendencies || []).find((g) => g.id === f.id), now = (after.findings || after.tendencies || []).find((g) => g.id === f.id);
    if (!was && !now) return { text: 'not seen in either run', word: 'unknown', gain: 0 };
    if (!now) return { text: 'gone', word: 'better', gain: was && U.isNum(was.severity) ? was.severity : 0.3 };
    if (was && U.isNum(was.severity) && U.isNum(now.severity)) {
      const d = was.severity - now.severity;
      return { text: d >= 0.1 ? 'less severe' : d <= -0.1 ? 'more severe' : 'about the same', gain: d, word: d >= 0.1 ? 'better' : d <= -0.1 ? 'worse' : 'same' };
    }
    return { text: 'still there', word: 'same', gain: 0 };
  }

  /* The next thing to try for a problem when this change did nothing: a different kind of setting. */
  function alternative(change, f) {
    for (const opt of AD().ruleFor(f)) if (opt.role !== change.role) return AD().titleFor(opt.role, opt.dir, (opt.axle === '@' ? f.axle : opt.axle) || null);
    return null;
  }

  const RETHINK = {
    asExpected: (c) => (c.time ? 'As expected: ' + sec(c.time.net) + ' faster where it acts.' : 'As expected.'),
    overshot: () => 'Worked, but too far. Go back half the step.',
    notTheLimit: () => 'Problem smaller, lap no faster: it was not what was costing time.',
    paceGain: (c) => 'Worth ' + sec(c.time.net) + ' a lap here.',
    paceLoss: (c) => 'Cost ' + sec(c.time.net) + ' a lap here. Put it back.',
    paceEven: () => 'No net lap time: what one part of the lap gained, another gave back.',
    timeOnly: (c) => sec(c.time.net) + ' faster where it acts, though the problem it was aimed at did not move.',
    fixedButSlower: (c) => 'Problem smaller, but ' + sec(c.time.net) + ' slower where it acts. Not worth it.',
    slower: (c) => sec(c.time.net) + ' slower where it acts, and the problem did not move. Put it back.',
    wrongWay: () => 'Went the wrong way. Put it back; the usual reasoning does not hold here.',
    tooSmall: () => 'Right direction, too small. Try a bigger step.',
    driver: (c) => 'No change, and your laps show ' + lower(c.habit) + ': likely the driving.',
    noLever: (c) => 'No change: this setting does not drive it on this car.' + (c.next ? ' Next: ' + lower(c.next) + '.' : ''),
    unmeasured: () => 'Not measured in these runs, so it cannot be judged.',
    notSeen: () => 'The telemetry did not show that problem before the change, so it has nothing to compare. Give your own verdict.',
    lapOnly: (c, lap) => (c.why === 'none' ? 'No target' : c.why === 'pace' ? 'Made for pace' : 'No reason on record') + ': '
      + (c.time ? (c.time.word === 'same' ? 'no time change where it acts' : sec(c.time.net) + ' ' + c.time.word + ' where it acts') : 'lap ' + (lap.word === 'same' ? 'unchanged' : lap.word))
      + '.' + (c.why === 'unknown' ? ' Say what it was for.' : ''),
    yourCall: (c) => 'Your call' + (c.auto && c.auto !== c.verdict ? ' (telemetry said ' + ({ helped: 'helped', none: 'no clear difference', hurt: 'worse' })[c.auto] + ')' : '') + '.',
  };

  const sec = (v) => Math.abs(v).toFixed(2) + ' s';

  /* Judge every change between two session records of the same car and track.
     notes:   { [changeKey]: { target, verdict } }, what the driver has said about this pair.
     learned: Map targetKey -> [{ key }], answers this car has taught the app before this pair. */
  function judge(before, after, setupBefore, setupAfter, notes, learned) {
    const LEARNED = { effect: 'Learned on this car: it cut this problem before.' };
    const match = (c, f) => ruleMatch(c, f) || (learned && (learned.get(targetKey(f)) || []).some((e) => e.key === c.key) ? LEARNED : null);
    const changes = changesBetween(setupBefore, setupAfter);
    const paceB = before.medianLap || before.bestLap, paceA = after.medianLap || after.bestLap;
    const rel = paceB && paceA ? (paceA - paceB) / paceB : null;
    // Lap times that vary a lot make a small difference meaningless.
    const noise = Math.max(0.003, ((before.lapSpread || 0) + (after.lapSpread || 0)) / 2 / (paceB || 1));
    const lap = { before: paceB, after: paceA, rel, word: rel == null ? 'unknown' : rel <= -noise ? 'faster' : rel >= noise ? 'slower' : 'same', noise, noisy: noise > 0.006 };
    const found = before.findings || before.tendencies || [];
    // Where the best lap gained or lost time, zone by zone. null for records made before pace profiles were kept.
    const pd = STA.pace ? STA.pace.delta(before.prof, after.prof) : null;
    const withMove = (f, rule) => Object.assign({ id: f.id, title: f.title, kind: f.kind, phase: f.phase, band: f.band, axle: f.axle, stated: !!f.stated, key: targetKey(f), mechanism: rule ? rule.effect : '' }, movement(f, before, after, lap));

    for (const c of changes) {
      const note = (notes && notes[c.key]) || {};
      const stated = note.target ? resolveIntent(note.target, before) : null;
      c.note = note;
      if (note.target === 'none') { c.why = 'none'; c.targets = []; }
      else if (stated) { c.why = 'driver'; c.targets = [withMove(stated, match(c, stated))]; }
      else { c.targets = found.map((f) => [f, match(c, f)]).filter((x) => x[1]).map((x) => withMove(x[0], x[1])); c.why = c.targets.length ? 'app' : 'unknown'; }

      // A wing change that answers no handling problem was made for pace (unless the driver says otherwise):
      // it is judged on lap time alone.
      const aim = !stated && note.target !== 'none' && !c.targets.length && STA.pace ? STA.pace.purpose(c) : null;
      if (aim) { c.why = 'pace'; c.purpose = aim; }
      // Lap time where this change acts. Without pace profiles (older records) the whole lap stands in.
      c.time = pd ? STA.pace.effect(c, changes, pd) : null;
      c.top = pd && STA.pace.AERO[c.role] ? pd.top : null;
      const tw = c.time ? c.time.word : lap.word, byTime = tw === 'faster' ? 'helped' : tw === 'slower' ? 'hurt' : 'none';

      const T = c.targets.filter((t) => t.word !== 'unknown');
      const better = T.some((t) => t.word === 'better' || t.word === 'overshot'), worse = T.some((t) => t.word === 'worse'), slight = T.some((t) => t.word === 'slight');
      c.overshot = T.some((t) => t.word === 'overshot');
      c.shared = changes.length - 1;
      if (c.why === 'pace') { c.verdict = byTime; c.cause = !c.time ? 'lapOnly' : tw === 'faster' ? 'paceGain' : tw === 'slower' ? 'paceLoss' : 'paceEven'; }
      else if (!c.targets.length) { c.verdict = byTime; c.cause = 'lapOnly'; }
      else if (!T.length) { c.verdict = 'none'; c.cause = 'unmeasured'; }
      else if (c.overshot) { c.verdict = tw === 'slower' ? 'hurt' : 'helped'; c.cause = 'overshot'; }
      else if (better && tw === 'faster') { c.verdict = 'helped'; c.cause = 'asExpected'; }
      // Problem smaller but no time gained: with pace data that is not a result. (Older records keep the benefit of the doubt.)
      else if (better && tw === 'same') { c.verdict = c.time ? 'none' : 'helped'; c.cause = c.time ? 'notTheLimit' : 'asExpected'; }
      else if (better) { c.verdict = c.time ? 'hurt' : 'none'; c.cause = c.time ? 'fixedButSlower' : 'notTheLimit'; }
      else if (c.time && tw === 'faster') { c.verdict = 'helped'; c.cause = 'timeOnly'; }
      else if (worse) { c.verdict = 'hurt'; c.cause = 'wrongWay'; }
      else if (c.time && tw === 'slower') { c.verdict = 'hurt'; c.cause = 'slower'; }
      else if (slight) { c.verdict = 'none'; c.cause = 'tooSmall'; }
      else {
        c.verdict = 'none';
        const habit = (after.habits || []).find((h) => T.some((t) => t.key === h.relates));
        if (T.every((t) => t.stated && t.absent)) c.cause = 'notSeen';
        else if (habit) { c.cause = 'driver'; c.habit = habit.title; }
        else { c.cause = 'noLever'; c.next = alternative(c, T[0]); }
      }
      // The driver can overrule the telemetry: they felt what a few laps of numbers may not show.
      if (note.verdict && note.verdict !== c.verdict) { c.auto = c.verdict; c.verdict = note.verdict; c.cause = 'yourCall'; }
      else if (note.verdict) c.confirmed = true;
      c.rethink = RETHINK[c.cause](c, lap);
      c.confidence = c.shared > 0 || lap.noisy ? 'low' : 'medium';
      // For the tallies, a pace change's target is the lap time itself.
      if (c.why === 'pace' && c.time) c.targets.push({ id: 'pace', key: 'pace', kind: 'pace', title: 'Lap time', stated: false, mechanism: c.purpose, text: c.time.text, gain: -c.time.net, word: tw === 'faster' ? 'better' : tw === 'slower' ? 'worse' : 'same' });
    }

    // Problems that got better although nothing was aimed at them: an unexpected gain, credited to what changed.
    const bonus = [];
    if (changes.length) for (const f of found) {
      if (changes.some((c) => c.targets.some((t) => t.id === f.id) || match(c, f))) continue;
      const m = movement(f, before, after, lap);
      if (m.word === 'better') bonus.push(Object.assign({ id: f.id, title: f.title, kind: f.kind, phase: f.phase, band: f.band, axle: f.axle, key: targetKey(f), credit: changes.map((c) => c.key) }, m));
    }
    return { changes, lap, bonus, pace: pd };
  }

  /* Consecutive sessions with the same car at the same track that used different setups. */
  function pairs(summaries, setups, q) {
    const byId = new Map(setups.map((s) => [s.id, s])), tracks = new Map();
    for (const s of summaries) {
      if (s.sim !== q.sim || !STA.library.sameCar(s.car, q.car) || !s.setupId || !s.bestLap || !byId.has(s.setupId)) continue;
      if (q.track && !STA.library.sameTrack(s.track, q.track)) continue;
      const k = U.slug(s.track); (tracks.get(k) || tracks.set(k, []).get(k)).push(s);
    }
    const out = [];
    for (const list of tracks.values()) {
      list.sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
      for (let i = 1; i < list.length; i++) {
        if (list[i].setupId === list[i - 1].setupId) continue;
        out.push({ before: list[i - 1], after: list[i], setupBefore: byId.get(list[i - 1].setupId), setupAfter: byId.get(list[i].setupId) });
      }
    }
    return out.sort((a, b) => (a.after.recordedAt || 0) - (b.after.recordedAt || 0));
  }

  const runs = (n) => (n === 1 ? '1 run' : n + ' runs');
  const sure = (n, clean) => (n >= 4 && clean ? 'high' : n >= 2 ? 'medium' : 'low');

  /* Everything the app has worked out about one car from its before/after pairs.
       stats  Map "role|axle|dir" -> { tried, helped, none, hurt, trials[], by: { [targetKey]: { tried, helped, none, hurt, gain, last } } }
       links  Map targetKey -> [{ key, role, axle, dir, n, weight }]   changes that fixed a problem they were not aimed at
       relay  [{ kind, text, confidence, when }]                       the same, in sentences, newest first
       judged Map afterSessionId -> the judged pair that led into that session
     reasons: { [afterSessionId]: { [changeKey]: { target, verdict } } } */
  function knowledge(summaries, setups, q, reasons) {
    const stats = new Map(), links = new Map(), lapGains = [], judged = new Map();
    // A link counts once it has one clean result (the only change) or two shared ones,
    // and stops counting if the same change has since failed for that problem.
    const active = () => {
      const out = new Map();
      for (const [k, list] of links) {
        const keep = list.filter((e) => { const b = stats.get(e.key) && stats.get(e.key).by[k]; return e.weight >= 1 - 1e-9 && !(b && b.helped === 0 && b.hurt + b.none >= 1); }).sort((a, b) => b.weight - a.weight);
        if (keep.length) out.set(k, keep);
      }
      return out;
    };
    // dead: no effect at all (as opposed to "problem smaller but no time gained" or "step too small").
    const DEAD = { noLever: 1, driver: 1, paceEven: 1, lapOnly: 1 };
    const stat = (c) => stats.get(c.key) || stats.set(c.key, { title: c.title, tried: 0, helped: 0, none: 0, hurt: 0, dead: 0, time: 0, timed: 0, trials: [], by: {} }).get(c.key);
    for (const p of pairs(summaries, setups, { sim: q.sim, car: q.car })) {
      const j = judge(p.before, p.after, p.setupBefore, p.setupAfter, reasons && reasons[p.after.id], active()), when = p.after.recordedAt || 0;
      judged.set(p.after.id, Object.assign({ pair: p }, j));
      for (const c of j.changes) {
        if (c.cause === 'unmeasured' || c.cause === 'notSeen') continue;
        // A change that was not aimed at anything is only counted when it was the only change,
        // because then the lap time at least has a single explanation.
        if (!c.targets.length && c.cause !== 'yourCall' && (c.shared > 0 || c.verdict === 'none')) continue;
        const st = stat(c);
        const dead = c.verdict === 'none' && DEAD[c.cause] ? 1 : 0, net = c.time ? c.time.net : null;
        st.tried++; st[c.verdict]++; st.dead += dead;
        if (net != null) { st.time += net; st.timed++; }
        st.trials.push({ track: p.after.track, when, verdict: c.verdict, cause: c.cause, shared: c.shared, net, text: c.time ? c.time.text : '', top: c.top, from: c.from, to: c.to });
        for (const t of c.targets) {
          const b = st.by[t.key] || (st.by[t.key] = { tried: 0, helped: 0, none: 0, hurt: 0, dead: 0, gain: 0, time: 0, timed: 0, balance: t.kind === 'understeer' || t.kind === 'oversteer', last: null, when: 0, clean: true });
          b.tried++; b[c.verdict]++; b.dead += dead; b.gain += t.gain || 0; b.last = c.cause; b.when = when; if (c.shared > 0) b.clean = false;
          if (net != null) { b.time += net; b.timed++; }
        }
        if (!c.targets.length && c.shared === 0 && c.verdict === 'helped' && j.lap.rel != null) lapGains.push({ key: c.key, title: c.title, rel: j.lap.rel, track: p.after.track, when });
      }
      for (const b of j.bonus) for (const key of b.credit) {
        const c = j.changes.find((x) => x.key === key), list = links.get(b.key) || links.set(b.key, []).get(b.key);
        const e = list.find((x) => x.key === key) || list[list.push({ key, role: c.role, axle: c.axle, dir: c.dir, title: c.title, n: 0, weight: 0, when: 0 }) - 1];
        e.n++; e.weight += 1 / b.credit.length; e.when = when;
      }
    }
    const live = active();

    const relay = [];
    for (const [k, list] of live) for (const e of list) relay.push({ kind: 'new', when: e.when, confidence: sure(e.n, e.weight >= e.n),
      text: 'New: ' + lower(e.title) + ' also cut ' + targetText(k) + ' (' + runs(e.n) + '). Now offered for it.' });
    for (const st of stats.values()) for (const k of Object.keys(st.by)) {
      const b = st.by[k], title = st.title, per = b.balance && b.tried ? ' About ' + Math.abs(Math.round(b.gain / b.tried * 100)) + ' points a run.' : '';
      const worth = b.timed && Math.abs(b.time / b.timed) >= 0.03 ? ' ' + sec(b.time / b.timed) + ' a lap ' + (b.time < 0 ? 'faster' : 'slower') + ' where it acts.' : '';
      if (k === 'pace') {
        // A wing trade depends on the track and on the level it was made from, so each step is reported
        // on its own (the latest result for the same step at the same track), most recent first.
        const steps = new Map();
        for (const x of st.trials.filter((x) => x.net != null).sort((x, y) => x.when - y.when)) { const k = x.track + '|' + x.from + '|' + x.to, was = steps.get(k); steps.set(k, Object.assign({}, x, { n: (was ? was.n : 0) + 1, clean: (!was || was.clean) && !x.shared })); }
        for (const x of Array.from(steps.values()).sort((x, y) => y.when - x.when).slice(0, 4)) {
          relay.push({ kind: x.verdict === 'helped' ? 'works' : x.verdict === 'hurt' ? 'fails' : 'mixed', when: x.when, confidence: x.n === 1 && x.clean && Math.abs(x.net) >= 0.15 ? 'medium' : sure(x.n, x.clean), top: x.top,
            text: title + (x.from && x.to ? ' ' + x.from + ' → ' + x.to : '') + ' at ' + x.track + ': ' + (x.verdict === 'none' ? 'no net lap time' : sec(x.net) + ' a lap ' + (x.net < 0 ? 'faster' : 'slower')) + ' (' + x.text + ').' + (x.verdict === 'hurt' ? ' Put it back.' : '') });
        }
        continue;
      }
      if (b.helped && b.helped >= b.none + b.hurt) relay.push({ kind: 'works', when: b.when, confidence: sure(b.tried, b.clean), text: title + ' works for ' + targetText(k) + ' (' + b.helped + ' of ' + runs(b.tried) + ').' + (b.gain > 0 ? per : '') + worth + ' Ranked higher.' });
      else if (b.hurt && !b.helped) relay.push({ kind: 'fails', when: b.when, confidence: sure(b.tried, b.clean), text: title + ' made ' + targetText(k) + ' worse (' + runs(b.tried) + ').' + (b.hurt + b.none >= 2 ? ' Listed last.' : '') });
      else if (!b.helped && b.last === 'tooSmall') relay.push({ kind: 'size', when: b.when, confidence: sure(b.tried, b.clean), text: title + ' moves ' + targetText(k) + ' the right way, but one step was too small. A bigger step is offered.' });
      else if (!b.helped && b.last === 'notTheLimit') relay.push({ kind: 'mixed', when: b.when, confidence: sure(b.tried, b.clean), text: title + ' reduces ' + targetText(k) + ', but the lap was no faster (' + runs(b.tried) + '). That problem is not what is costing time.' });
      else if (!b.helped) relay.push({ kind: 'fails', when: b.when, confidence: sure(b.tried, b.clean), text: title + ' does not move ' + targetText(k) + ' (' + runs(b.tried) + ').' + (b.dead + b.hurt >= 2 ? ' Listed last.' : ' One more like this and it is listed last.') });
      else relay.push({ kind: 'mixed', when: b.when, confidence: 'low', text: title + ' is mixed for ' + targetText(k) + ' (' + b.helped + ' of ' + runs(b.tried) + ' helped).' });
    }
    for (const g of lapGains) relay.push({ kind: 'lap', when: g.when, confidence: 'low', text: g.title + ' on its own: lap ' + Math.abs(g.rel * 100).toFixed(2) + '% faster at ' + g.track + '.' });
    const order = { new: 0, works: 1, size: 2, fails: 3, mixed: 4, lap: 5 };
    relay.sort((a, b) => order[a.kind] - order[b.kind] || b.when - a.when);
    return { stats, links: live, relay, judged };
  }

  /* Kept for callers that only want the tallies. */
  const outcomes = (summaries, setups, q, reasons) => knowledge(summaries, setups, q, reasons).stats;

  /* The change that led into this session, judged. null when there is no earlier session
     with this car at this track. */
  function review(summaries, setups, session, reasons) {
    if (!session || !session.setup) return null;
    const q = { sim: session.meta.sim, car: session.meta.car, track: session.trackName };
    const mine = summaries.filter((s) => s.sim === q.sim && STA.library.sameCar(s.car, q.car) && STA.library.sameTrack(s.track, q.track) && s.bestLap)
      .sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
    const at = mine.findIndex((s) => s.id === session.id);
    if (at < 0) return null;
    if (at === 0) return { first: true, sessions: mine.length };
    const after = mine[at], before = mine[at - 1], byId = new Map(setups.map((s) => [s.id, s]));
    if (before.setupId === after.setupId) return { sameSetup: true, before, after, sessions: mine.length };
    const a = byId.get(before.setupId), b = byId.get(after.setupId);
    if (!a || !b) return null;
    // Judged with what the app knew about this car at that point, the same way the tallies are built.
    const j = knowledge(summaries, setups, q, reasons).judged.get(after.id) || judge(before, after, a, b, reasons && reasons[after.id]);
    return { before, after, setupBefore: a, setupAfter: b, changes: j.changes, lap: j.lap, bonus: j.bonus, pace: j.pace, sessions: mine.length, choices: intentChoices(before) };
  }

  STA.learning = { snapshot, changesBetween, addresses, judge, pairs, outcomes, knowledge, review, intentChoices, targetKey, targetText };
})(typeof window !== 'undefined' ? window : globalThis);
