/* Learns from what happened after earlier setup changes.

   Every session leaves a short record in the library (no raw telemetry): the
   balance in each corner phase, the findings, lap times and the setup that was
   on the car. When two consecutive sessions with the same car at the same
   track used different setups, the app works out which settings changed and
   in which direction, and checks whether the problem each change is meant to
   address got better, stayed the same or got worse.

   The results are counted per car and fed back into the setup advice: changes
   that have helped on this car move up, changes that have not are moved down.
   The more sessions are loaded, the more this reflects the car and the driver
   rather than general rules.

   What it cannot know: lap time also moves with track temperature, fuel, tyre
   wear, traffic and practice. One before/after pair is weak evidence, which is
   why a change is only moved to the bottom after two results against it. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  /* What to keep from a session so later sessions can be compared with it. */
  function snapshot(session, an, tech) {
    const timed = session.laps.filter((l) => l.complete && l.valid).map((l) => l.time).sort((a, b) => a - b);
    const near = timed.filter((t) => t <= timed[0] * 1.03);
    const out = { v: 2, medianLap: near.length ? U.median(near) : null, lapSpread: near.length >= 3 ? U.std(near) : null, findings: [], balance: null, metrics: {} };
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
    return out;
  }

  /* Settings that differ between two setups, as { role, axle, dir } with '+' meaning the value went up. */
  function changesBetween(a, b) {
    if (!a || !b) return [];
    const bMap = new Map(b.params.map((p) => [p.id, p])), groups = new Map();
    for (const pa of a.params) {
      const pb = bMap.get(pa.id);
      if (!pb || pa.derived || !pa.role || !STA.advisor.ROLE[pa.role]) continue;
      let d = null;
      if (U.isNum(pa.num) && U.isNum(pb.num) && String(pa.unit).toLowerCase() === String(pb.unit).toLowerCase()) d = pb.num - pa.num;
      else if (pa.index != null && pb.index != null) d = pb.index - pa.index;
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
      out.push({ role: g.role, axle: g.axle, dir, key: STA.advisor.blockKey(g.role, g.axle, dir), title: STA.advisor.titleFor(g.role, dir, g.axle),
        from: Array.from(new Set(g.from)).join(' / '), to: Array.from(new Set(g.to)).join(' / ') });
    }
    return out;
  }

  /* Is this change one of the usual answers to this finding? */
  function addresses(change, f) {
    for (const opt of STA.advisor.ruleFor(f)) {
      const axle = (opt.axle === '@' ? f.axle : opt.axle) || null;
      if (opt.role === change.role && axle === change.axle && opt.dir === change.dir) return true;
      for (const e of STA.advisor.equivalents(opt.role, axle, opt.dir)) if (e.role === change.role && (e.axle || null) === change.axle && e.dir === change.dir) return true;
    }
    return false;
  }

  const pct = (v) => { const r = Math.round(v * 100); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + '%'; };

  /* How one finding moved between two session records: 'better' | 'same' | 'worse' | 'overshot'. */
  function movement(f, before, after) {
    const balance = f.kind === 'understeer' || f.kind === 'oversteer';
    if (balance && before.balance && after.balance && f.phase && f.band) {
      const x = before.balance[f.phase][f.band], y = after.balance[f.phase][f.band];
      if (x != null && y != null) {
        const text = pct(x) + ' to ' + pct(y);
        if (f.kind === 'understeer') return { text, word: y <= -0.10 ? 'overshot' : y - x <= -0.05 ? 'better' : y - x >= 0.05 ? 'worse' : 'same' };
        return { text, word: y >= 0.25 ? 'overshot' : y - x >= 0.03 ? 'better' : y - x <= -0.03 ? 'worse' : 'same' };
      }
    }
    const was = (before.findings || before.tendencies || []).find((g) => g.id === f.id), now = (after.findings || after.tendencies || []).find((g) => g.id === f.id);
    if (!now) return { text: 'no longer shows up', word: 'better' };
    if (was && U.isNum(was.severity) && U.isNum(now.severity)) {
      const d = now.severity - was.severity;
      return { text: d <= -0.1 ? 'less severe' : d >= 0.1 ? 'more severe' : 'about the same', word: d <= -0.1 ? 'better' : d >= 0.1 ? 'worse' : 'same' };
    }
    return { text: 'still there', word: 'same' };
  }

  /* Judge every change between two session records of the same car and track. */
  function judge(before, after, setupBefore, setupAfter) {
    const changes = changesBetween(setupBefore, setupAfter);
    const paceB = before.medianLap || before.bestLap, paceA = after.medianLap || after.bestLap;
    const rel = paceB && paceA ? (paceA - paceB) / paceB : null;
    // Lap times that vary a lot make a small difference meaningless.
    const noise = Math.max(0.003, ((before.lapSpread || 0) + (after.lapSpread || 0)) / 2 / (paceB || 1));
    const lap = { before: paceB, after: paceA, rel, word: rel == null ? 'unknown' : rel <= -noise ? 'faster' : rel >= noise ? 'slower' : 'same', noise };
    const found = before.findings || before.tendencies || [];
    for (const c of changes) {
      c.targets = found.filter((f) => addresses(c, f)).map((f) => Object.assign({ title: f.title, kind: f.kind, phase: f.phase, band: f.band, axle: f.axle }, movement(f, before, after)));
      const better = c.targets.filter((t) => t.word === 'better' || t.word === 'overshot').length, worse = c.targets.filter((t) => t.word === 'worse').length;
      c.overshot = c.targets.some((t) => t.word === 'overshot');
      if (c.targets.length) c.verdict = better && lap.word !== 'slower' ? 'helped' : worse && !better ? 'hurt' : lap.word === 'slower' && !better ? 'hurt' : 'none';
      else c.verdict = lap.word === 'faster' ? 'helped' : lap.word === 'slower' ? 'hurt' : 'none';
      c.shared = changes.length - 1;
    }
    return { changes, lap };
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
    return out;
  }

  /* Per car: how each kind of change has turned out so far.
     Map of "role|axle|dir" -> { tried, helped, none, hurt, trials[] } */
  function outcomes(summaries, setups, q) {
    const stats = new Map();
    for (const p of pairs(summaries, setups, { sim: q.sim, car: q.car })) {
      const j = judge(p.before, p.after, p.setupBefore, p.setupAfter);
      for (const c of j.changes) {
        // A change that was not aimed at any finding is only counted when it was the only change,
        // because then the lap time at least has a single explanation.
        if (!c.targets.length && (c.shared > 0 || c.verdict === 'none')) continue;
        const st = stats.get(c.key) || { tried: 0, helped: 0, none: 0, hurt: 0, trials: [] };
        st.tried++; st[c.verdict]++;
        st.trials.push({ track: p.after.track, when: p.after.recordedAt, verdict: c.verdict, shared: c.shared });
        stats.set(c.key, st);
      }
    }
    return stats;
  }

  /* The change that led into this session, judged. null when there is no earlier session
     with this car at this track. */
  function review(summaries, setups, session) {
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
    const j = judge(before, after, a, b);
    return { before, after, setupBefore: a, setupAfter: b, changes: j.changes, lap: j.lap, sessions: mine.length };
  }

  STA.learning = { snapshot, changesBetween, addresses, judge, pairs, outcomes, review };
})(typeof window !== 'undefined' ? window : globalThis);
