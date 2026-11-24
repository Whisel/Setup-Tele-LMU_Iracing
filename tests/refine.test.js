/* The checks that keep the advice from chasing one problem into another:
   where a setting acts, why the rear slides, and what has already been tried. */
const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const sim = require('./helpers/sim.js');
const { makeIbt, SETUP_YAML } = require('./helpers/make-ibt.js');

const AD = STA.advisor;
const setupOf = (yaml, name) => STA.setup.fromIracing(STA.yaml.parse(yaml || SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: name || 'n' });
const sessionOf = async (opts, extra) => STA.session.fromIbt(await STA.ibt.read(makeIbt(sim.drive(Object.assign({ laps: 4, grips: [1, 1, 1, 1] }, opts)), extra), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
const cell = (idx) => ({ n: 100, idx });
const matrix = (entry, mid, exit) => ({ entry: { low: cell(entry), medium: cell(entry), high: cell(null), all: cell(entry) }, mid: { low: cell(mid), medium: cell(mid), high: cell(null), all: cell(mid) }, exit: { low: cell(exit), medium: cell(exit), high: cell(null), all: cell(exit) } });
const osExit = (over) => Object.assign({ id: 'os-exit-low', kind: 'oversteer', phase: 'exit', band: 'low', cause: 'power', causeText: 'It starts on the throttle.', title: 'Corner exit oversteer in slow corners', severity: 0.4, confidence: 'high', evidence: '', measured: true }, over);
const usMid = (over) => Object.assign({ id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners', severity: 0.42, confidence: 'medium', evidence: '' }, over);

test('why the rear slides is read from the pedals, and the three views of a throttle slide count once', async () => {
  const an = STA.handling.analyse(await sessionOf({ looseExit: 1 }));
  const os = an.findings.find((f) => f.kind === 'oversteer');
  assert.strictEqual(os.cause, 'power');
  assert.deepStrictEqual(an.balance.slide.cells['exit|low'].cause, 'power');
  const feet = an.balance.slide.cells['exit|low'].feet;
  assert.ok(feet[0] > 0 && feet[2] === 0 && feet[3] === 0, 'all of it over half throttle: ' + feet);
  // on the brakes instead: a different cause, and the cure is what acts off the throttle
  const brk = STA.handling.analyse(await sessionOf({ looseEntry: 1 }));
  const mid = brk.findings.find((f) => f.kind === 'oversteer' && f.phase === 'mid');
  assert.strictEqual(mid.cause, 'braking');
  assert.strictEqual(AD.ruleFor(mid)[0].role, 'brakeBias', 'a slide on the brakes that carries to mid-corner still starts with the brake bias');
  assert.strictEqual(AD.ruleFor(Object.assign({}, mid, { cause: 'balance' }))[0].role, 'arb');
  assert.ok(!AD.ruleFor(Object.assign({}, mid, { cause: 'lift' })).some((x) => x.role === 'brakeBias'), 'lifting off is not a brake bias matter');

  // exit oversteer on the throttle, wheelspin and a busy traction control are one problem
  const power = [osExit({ group: 'power' }), { id: 'wheelspin', kind: 'wheelspin', axle: 'rear', group: 'power', withSlide: true, title: 'Rear wheelspin under power', severity: 0.38, confidence: 'high' },
    { id: 'tc-busy', kind: 'traction', phase: 'exit', band: 'low', group: 'power', withSlide: true, title: 'Traction control busy on exit', severity: 0.35, confidence: 'high' }];
  const adv = AD.advise({ findings: power, balance: { matrix: matrix(0, 0, 0) } }, setupOf(), {});
  const tc = adv.suggestions.find((x) => x.blockKey === 'tc||+');
  assert.deepStrictEqual(tc.reasons.length, 3);
  assert.strictEqual(tc.score, 0.4, 'three reasons, the weight of one');
  assert.strictEqual(tc.confidence, 'medium', 'a slide that starts with the feet is at most half a setup problem');
  // with the rear stepping out, wheelspin is both tyres letting go: more differential lock is not offered
  assert.ok(!AD.ruleFor(power[1]).some((x) => x.role === 'diffPower' && x.dir === '+'));
  assert.ok(AD.ruleFor({ kind: 'wheelspin', axle: 'rear' }).some((x) => x.role === 'diffPower' && x.dir === '+'), 'one wheel spinning up on a car that stays in line still is');
});

test('a change is left out when it would push another part of the corner further the way it already leans', () => {
  const setup = setupOf();
  // where each kind of setting acts
  assert.deepStrictEqual(AD.shiftOf('arb', 'rear', '-'), [0.6, 1, 0.8], 'a softer rear bar adds understeer in every part of the corner');
  assert.deepStrictEqual(AD.shiftOf('slowBump', 'rear', '-').map((x) => +x.toFixed(1)), [0.3, 0, 0.5], 'a damper only while the car is still moving on its springs');
  assert.deepStrictEqual(AD.shiftOf('brakeBias', null, '+').map(Math.abs), [0.7, 0, 0], 'brake bias only on the way in');
  assert.strictEqual(AD.shiftOf('tc', null, '+'), null, 'traction control moves no balance');

  // the P320 recording in numbers: front pushes 41% mid-corner, rear steps out on the throttle
  const spin = { id: 'wheelspin', kind: 'wheelspin', axle: 'rear', group: 'power', withSlide: true, title: 'Rear wheelspin under power', severity: 0.38, confidence: 'high' };
  const an = { findings: [usMid({ first: true }), spin, osExit({ severity: 0.24, raw: 0.4, group: 'power', follows: ['us-mid-low'] })], balance: { matrix: matrix(0.18, 0.41, 0.02) } };
  const st = AD.stateOf(an);
  assert.ok(st.mid.us.low > 0.5 && st.exit.power === 0.4 && st.exit.os.low === 0, JSON.stringify(st));
  const hm = AD.harmOf('arb', 'rear', '-', an.findings[2], st);
  assert.strictEqual(hm.text, 'would add understeer mid-corner, where the front already pushes (+41%)');
  assert.strictEqual(AD.harmOf('arb', 'rear', '+', an.findings[0], st).text, 'would take traction from the rear, which already steps out on the throttle');
  assert.strictEqual(AD.harmOf('arb', 'front', '-', an.findings[0], st), null, 'more front grip is not held against a slide that starts on the throttle');
  assert.strictEqual(AD.harmOf('slowBump', 'rear', '-', an.findings[2], st), null, 'a change that only acts on the way out costs the middle nothing');

  const adv = AD.advise(an, setup, {});
  assert.deepStrictEqual(adv.suggestions.map((x) => x.blockKey), ['arb|front|-', 'tc||+', 'spring|front|-', 'pressure|rear|-', 'toe|rear|+']);
  const out = adv.held.find((h) => h.finding === 'Rear wheelspin under power').items;
  assert.deepStrictEqual(out.map((i) => i.title), ['Soften the rear anti-roll bar', 'Stiffen the front anti-roll bar', 'Soften the rear springs', 'Stiffen the front springs']);
  assert.ok(out.every((i) => /^would add understeer mid-corner/.test(i.why)));

  // the same slide on a car that is neutral everywhere else: nothing is held, the bar is still there further down the list
  const neutral = AD.advise({ findings: [osExit()], balance: { matrix: matrix(0.02, 0.08, 0) } }, setup, { contested: new Map([['tc||+', { reason: 'none' }], ['toe|rear|+', { reason: 'none' }], ['camber|rear|+', { reason: 'none' }], ['pressure|rear|-', { reason: 'none' }]]) });
  assert.ok(neutral.suggestions.some((x) => x.blockKey === 'arb|rear|-'), neutral.suggestions.map((x) => x.blockKey).join(', '));
  assert.deepStrictEqual(neutral.held, []);

  // a serious problem can still be bought with a small cost; a small one cannot be bought with a large cost
  const loose = { id: 'os-mid-low', kind: 'oversteer', phase: 'mid', band: 'low', cause: 'balance', title: 'Mid-corner oversteer in slow corners', severity: 0.9, confidence: 'high', evidence: '' };
  const slight = AD.advise({ findings: [loose], balance: { matrix: matrix(0.27, -0.2, 0) } }, setup, {});
  assert.strictEqual(slight.suggestions[0].blockKey, 'arb|rear|-', 'entry leans +27%, the mid-corner slide is severe: the bar is still right');
  const heavy = AD.advise({ findings: [Object.assign({}, loose, { severity: 0.3 })], balance: { matrix: matrix(0.6, -0.12, 0) } }, setup, {});
  assert.ok(!heavy.suggestions.some((x) => x.blockKey === 'arb|rear|-'));
  assert.match(heavy.held[0].items[0].why, /would add understeer on corner entry, where the front already pushes \(\+60%\)/);

  // a floor that hits the ground still has to be dealt with: the side effect is shown, not used to block
  const low = AD.advise({ findings: [{ id: 'bottom-front', kind: 'bottoming', axle: 'front', title: 'Front close to the ground at speed', severity: 0.3, confidence: 'low' }], balance: { matrix: matrix(0.2, 0.6, 0) } }, setup, {});
  assert.strictEqual(low.suggestions[0].blockKey, 'rideHeight|front|+');
  assert.match(low.suggestions[0].sideEffect, /would add understeer mid-corner/);
  assert.deepStrictEqual(low.held, []);
});

/* ---------- what has already been tried ---------- */

const arbs = (front, rear, tc) => SETUP_YAML.replace(/(Front:\n\s+ArbBlades: )\d+/, '$1' + front).replace(/(Rear:\n\s+ArbBlades: )\d+/, '$1' + rear).replace(/TractionControlSetting: \d+/, 'TractionControlSetting: ' + (tc == null ? 4 : tc));
const bal = (entry, mid, exit) => { const row = (v) => ({ low: v, medium: v, high: null, all: v }); return { entry: row(entry), mid: row(mid), exit: row(exit) }; };
let n = 0;
// hour: when the run was driven, in hours from a fixed start (the order the sessions are read in)
const rec = (hour, setup, balance, findings) => ({ id: 'r' + (++n), sim: 'iracing', car: 'Test GT3', track: 'Test Ring', recordedAt: 1767225600000 + hour * 3600000, bestLap: 90, medianLap: 90.2, setupId: setup.id, balance, findings, metrics: {}, habits: [] });
const sess = (record, setup) => ({ id: record.id, setup, meta: { sim: 'iracing', car: 'Test GT3' }, trackName: 'Test Ring' });

test('the trail: how each setting has moved over the sessions leading up to this one', () => {
  const a = setupOf(arbs(3, 4), 'a'), b = setupOf(arbs(3, 3), 'b'), c = setupOf(arbs(3, 2), 'c'), d = setupOf(arbs(2, 3), 'd');
  const os = [osExit()];
  const r1 = rec(1, a, bal(0.05, 0.10, 0), os), r2 = rec(2, b, bal(0.1, 0.25, 0), os), r2b = rec(3, b, bal(0.1, 0.26, 0), os), r3 = rec(4, c, bal(0.2, 0.41, 0), os), r4 = rec(5, d, bal(0.1, 0.2, 0), os);
  const all = [r1, r2, r2b, r3, r4], setups = [a, b, c, d];
  const t3 = STA.learning.trail(all, setups, sess(r3, c));
  assert.deepStrictEqual(Array.from(t3.keys()), ['arb|rear']);
  const e = t3.get('arb|rear');
  assert.deepStrictEqual([e.dir, e.n, e.from, e.to, e.then.id], ['-', 2, '4', '2', r1.id], 'two steps the same way, counted from the session before the first');
  // only sessions up to the one being looked at count
  assert.strictEqual(STA.learning.trail(all, setups, sess(r2, b)).get('arb|rear').n, 1);
  assert.strictEqual(STA.learning.trail(all, setups, sess(r1, a)).size, 0);
  // a step the other way starts the count again
  const t4 = STA.learning.trail(all, setups, sess(r4, d));
  assert.deepStrictEqual([t4.get('arb|rear').dir, t4.get('arb|rear').n, t4.get('arb|rear').then.id], ['+', 1, r3.id]);
  assert.deepStrictEqual([t4.get('arb|front').dir, t4.get('arb|front').n], ['-', 1]);
});

test('a change that made another part of the corner worse is offered back before anything new', () => {
  // the rear bar was softened twice for exit oversteer; the slide is still there and the front now pushes mid-corner
  const a = setupOf(arbs(3, 4), 'a'), b = setupOf(arbs(3, 3), 'b'), c = setupOf(arbs(3, 2), 'c');
  const r1 = rec(1, a, bal(0.05, 0.10, 0), [osExit()]), r2 = rec(2, b, bal(0.1, 0.25, 0), [osExit()]), r3 = rec(3, c, bal(0.2, 0.41, 0), [osExit(), usMid()]);
  const an = { findings: [usMid({ first: true }), osExit({ severity: 0.24, raw: 0.4 })], balance: { matrix: matrix(0.2, 0.41, 0) } };
  const adv = AD.advise(an, c, { trail: STA.learning.trail([r1, r2, r3], [a, b, c], sess(r3, c)) });
  const back = adv.suggestions[0];
  assert.deepStrictEqual([back.blockKey, back.undo, back.primary], ['arb|rear|+', true, true]);
  assert.strictEqual(back.effect, 'Takes back part of an earlier change. Rear anti-roll bar went from 4 to 2 (2 changes in a row), and since then mid-corner understeer in slow corners has gone from +10% to +41%.');
  assert.ok(!adv.suggestions.some((x) => x.blockKey === 'arb|rear|-'), 'and it is not softened a third time');
  // without the history the same car gets the front bar first, and the rear bar is left alone
  const cold = AD.advise(an, c, {});
  assert.strictEqual(cold.suggestions[0].blockKey, 'arb|front|-');
  assert.ok(!cold.suggestions.some((x) => x.role === 'arb' && x.axle === 'rear'));
  // understeer that was already there before the bar moved is not blamed on it
  const r1b = rec(1, a, bal(0.2, 0.40, 0), [osExit(), usMid()]);
  const same = AD.advise(an, c, { trail: STA.learning.trail([r1b, r2, r3], [a, b, c], sess(r3, c)) });
  assert.ok(!same.suggestions.some((x) => x.undo), same.suggestions.map((x) => x.blockKey).join(', '));
});

test('the same change is not offered a third time in a row when the problem has not shrunk', () => {
  const a = setupOf(arbs(3, 2, 4), 'a'), b = setupOf(arbs(3, 2, 5), 'b'), c = setupOf(arbs(3, 2, 6), 'c');
  const r1 = rec(1, a, bal(0, 0.05, 0), [osExit()]), r2 = rec(2, b, bal(0, 0.05, 0), [osExit()]), r3 = rec(3, c, bal(0, 0.05, 0), [osExit()]);
  const an = { findings: [osExit()], balance: { matrix: matrix(0, 0.05, 0) } };
  const adv = AD.advise(an, c, { trail: STA.learning.trail([r1, r2, r3], [a, b, c], sess(r3, c)) });
  assert.ok(!adv.suggestions.some((x) => x.role === 'tc'), adv.suggestions.map((x) => x.blockKey).join(', '));
  assert.deepStrictEqual(adv.held[0].items[0], { title: 'Raise traction control', why: 'already made 2 times in a row (4 → 6) and this has not shrunk: another step will not fix it', repeat: true });
  assert.strictEqual(adv.suggestions[0].blockKey, 'toe|rear|+', 'the next way to the same effect is offered instead');
  // when it is working (the slide is down by more than a third), carrying on is right
  const better = AD.advise({ findings: [osExit({ severity: 0.2 })], balance: { matrix: matrix(0, 0.05, 0) } }, c, { trail: STA.learning.trail([r1, r2, r3], [a, b, c], sess(r3, c)) });
  assert.strictEqual(better.suggestions[0].blockKey, 'tc||+');
  // and after one step it is still offered
  const once = AD.advise(an, b, { trail: STA.learning.trail([r1, r2], [a, b], sess(r2, b)) });
  assert.strictEqual(once.suggestions[0].blockKey, 'tc||+');
});

test('following the advice run after run does not walk the car into understeer', async () => {
  /* A driver who gets on the throttle too early: the rear steps out on exit whatever the setup.
     The car pushes mid-corner by an amount that depends on the bars, as a real one does:
     a softer rear bar or a stiffer front bar adds to it. Each run, the two changes the app
     ticks by default are made. The old advice softened the rear bar every time. */
  const get = (setup, role, axle) => STA.setup.byRole(setup, role, axle)[0].num;
  const pushOf = (setup) => Math.max(0, 0.3 + 0.15 * (get(setup, 'arb', 'front') - 3) - 0.15 * (get(setup, 'arb', 'rear') - 2));
  let setup = setupOf(SETUP_YAML, 'run 1');
  const summaries = [], setups = [], log = [];
  const start = { front: get(setup, 'arb', 'front'), rear: get(setup, 'arb', 'rear') };
  for (let i = 0; i < (+process.env.RUNS || 6); i++) {
    const s = await sessionOf({ looseExit: 0.6, understeer: pushOf(setup) }, { startDate: 1767225600 + i * 7200 });
    s.setup = setup; s.id = 'loop-' + i;
    const an = STA.handling.analyse(s);
    summaries.push(Object.assign(STA.session.summaryOf(s), STA.learning.snapshot(s, an, null))); setups.push(setup);
    const adv = AD.advise(an, setup, { trail: STA.learning.trail(summaries, setups, s) });
    const picked = adv.suggestions.filter((x) => x.primary).slice(0, 2);
    log.push({ push: an.balance.matrix.mid.low.idx, front: get(setup, 'arb', 'front'), rear: get(setup, 'arb', 'rear'), tc: get(setup, 'tc'), picked: picked.map((x) => x.blockKey), all: adv.suggestions.map((x) => x.blockKey), exhausted: adv.exhausted.map((e) => e.finding) });
    if (!picked.length) break;
    setup = AD.proposeSetup(setup, picked, 'run ' + (i + 2));
    // Some changes are given as a step, not a value (traction control, toe: which way and how far differs by car),
    // so the driver makes those by hand in the garage.
    for (const x of picked) {
      if (x.change.delta != null || x.change.steps != null) continue;
      for (const p of setup.params) if (x.paramIds.includes(p.id)) { p.num += x.dir === '+' ? 1 : -1; p.raw = p.num + (p.unit ? ' ' + p.unit : ''); }
      setup = STA.setup.refresh(setup);
    }
  }
  const story = JSON.stringify(log.map((l) => [+l.push.toFixed(2), l.front, l.rear, l.tc, l.picked]));
  if (process.env.STORY) console.log(log.map((l, i) => 'run ' + (i + 1) + ': push ' + l.push.toFixed(2) + ' front bar ' + l.front + ' rear bar ' + l.rear + ' tc ' + l.tc + ' | ticked: ' + l.picked.join(', ') + ' | all: ' + l.all.join(', ') + (l.exhausted.length ? ' | no route left: ' + l.exhausted.join('; ') : '')).join('\n'));
  // the rear bar is never softened and the front bar never stiffened: nothing adds understeer
  assert.ok(log.every((l) => l.rear >= start.rear && l.front <= start.front), story);
  assert.ok(log.every((l) => !l.all.includes('arb|rear|-') && !l.all.includes('arb|front|+') && !l.all.includes('spring|rear|-')), story);
  // the push mid-corner is dealt with first, and ends lower than it began
  assert.strictEqual(log[0].picked[0], 'arb|front|-', story);
  assert.ok(log[log.length - 1].push < log[0].push - 0.1, story);
  // no setting is moved the same way more than twice running while the slide stays
  const tcSteps = log.filter((l) => l.picked.includes('tc||+')).length;
  assert.strictEqual(tcSteps, 2, 'traction control raised ' + tcSteps + ' times: ' + story);
  // and after three steps that did not shrink the slide, the app stops changing the car and says it is the driving
  const last = log[log.length - 1];
  assert.ok(log.length <= 5 && last.picked.length === 0, 'the changes stop: ' + story);
  assert.deepStrictEqual(last.exhausted, ['Corner exit oversteer in slow corners']);
  assert.deepStrictEqual(log.map((l) => l.picked.length).reduce((a, b) => a + b, 0), 5, 'five changes in all: two to the front bar, two to the traction control, one to the rear toe');
});

test('three steps without effect on a slide that starts with the feet: no further change, the reason and what to do instead', () => {
  const a = setupOf(arbs(3, 2, 4), 'a'), b = setupOf(arbs(3, 2, 6), 'b');
  const moreToe = setupOf(arbs(3, 2, 6).replace(/ToeIn: \+1\.0 mm/g, 'ToeIn: +1.5 mm'), 'c');
  const r1 = rec(1, a, bal(0, 0.05, 0), [osExit()]), r2 = rec(2, b, bal(0, 0.05, 0), [osExit()]), r3 = rec(3, moreToe, bal(0, 0.05, 0), [osExit()]);
  const an = { findings: [osExit()], balance: { matrix: matrix(0, 0.05, 0) } };
  // traction control went up once (by two) and the toe once: two steps, so one more route is still offered
  const two = AD.advise(an, moreToe, { trail: STA.learning.trail([r1, r2, r3], [a, b, moreToe], sess(r3, moreToe)) });
  assert.ok(two.suggestions.length >= 1 && two.exhausted.length === 0, JSON.stringify(two.exhausted));
  // a third step, still no smaller: stop
  const c2 = setupOf(arbs(3, 2, 7).replace(/ToeIn: \+1\.0 mm/g, 'ToeIn: +1.5 mm'), 'd');
  const r4 = rec(4, c2, bal(0, 0.05, 0), [osExit()]);
  const three = AD.advise(an, c2, { trail: STA.learning.trail([r1, r2, r3, r4], [a, b, moreToe, c2], sess(r4, c2)) });
  assert.deepStrictEqual(three.suggestions, []);
  assert.strictEqual(three.exhausted[0].why, '3 changes have been made for this over the last runs and it has not shrunk, so the car is not what causes it.');
  assert.match(three.exhausted[0].tips[0], /Squeeze the throttle on as you take the steering off/);
  // the same history with the slide down by half: the changes are working, so the advice carries on
  const working = AD.advise({ findings: [osExit({ severity: 0.2 })], balance: { matrix: matrix(0, 0.05, 0) } }, c2, { trail: STA.learning.trail([r1, r2, r3, r4], [a, b, moreToe, c2], sess(r4, c2)) });
  assert.ok(working.suggestions.length >= 1 && working.exhausted.length === 0);
  // understeer that is the car's own is not cut off this way
  const us = { findings: [usMid()], balance: { matrix: matrix(0, 0.41, 0) } };
  const fa = setupOf(arbs(5, 2), 'fa'), fb = setupOf(arbs(4, 2), 'fb'), fc = setupOf(arbs(3, 2), 'fc');
  const u1 = rec(5, fa, bal(0, 0.41, 0), [usMid()]), u2 = rec(6, fb, bal(0, 0.41, 0), [usMid()]), u3 = rec(7, fc, bal(0, 0.41, 0), [usMid()]);
  const next = AD.advise(us, fc, { trail: STA.learning.trail([u1, u2, u3], [fa, fb, fc], sess(u3, fc)) });
  assert.ok(next.suggestions.length >= 1 && !next.suggestions.some((x) => x.blockKey === 'arb|front|-'), 'the bar is not moved a third time, but another route is: ' + next.suggestions.map((x) => x.blockKey).join(', '));
});
