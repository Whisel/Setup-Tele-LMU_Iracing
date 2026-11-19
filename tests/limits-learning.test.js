const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const sim = require('./helpers/sim.js');
const { makeIbt, SETUP_YAML } = require('./helpers/make-ibt.js');

const setupFor = (car, edit, track) => STA.setup.fromIracing(STA.yaml.parse((edit || ((y) => y))(SETUP_YAML)).CarSetup, { car, track: track || 'Test Ring', name: 'n' });
const frontRh = (mm) => (y) => y.replace(/RideHeight: 55\.0 mm/g, 'RideHeight: ' + mm + ' mm');
const frontLow = [{ id: 'bottom-front', kind: 'bottoming', axle: 'front', title: 'The front of the car is close to the ground at speed', severity: 0.6, confidence: 'low' }];

/* ---------- car limits ---------- */

test('car limits: the right entry is found from the sim\'s car name, and unknown cars have none', () => {
  const L = STA.carLimits;
  assert.strictEqual(L.forCar('iracing', 'Super Formula Lights').name, 'Super Formula Lights');
  assert.strictEqual(L.forCar('iracing', 'Porsche 911 GT3 R (992)').name, 'Porsche 911 GT3 R (992)');
  assert.strictEqual(L.forCar('iracing', 'Porsche 911 GT3 Cup (992.2)').name, 'Porsche 911 GT3 Cup (992.2)');
  assert.strictEqual(L.forCar('iracing', 'Lamborghini Huracán GT3 EVO').name, 'Lamborghini Huracán GT3 EVO');
  assert.strictEqual(L.forCar('iracing', 'BMW M4 GT3').name, 'BMW M4 GT3');
  assert.strictEqual(L.forCar('iracing', 'BMW M4 G82 GT4').name, 'BMW M4 G82 GT4');
  assert.strictEqual(L.forCar('iracing', 'Test GT3'), null);
  assert.strictEqual(L.forCar('lmu', 'BMW M4 GT3'), null, 'LMU carries its own ranges in the recording');
  // every built-in entry parses to at least one usable limit and links its source
  for (const c of L.CARS) { assert.ok(c.limits.length >= 1, c.name); assert.match(c.url, /^https:\/\/s100\.iracing\.com\//); assert.ok(c.limits.every((x) => x.role && (x.min != null || x.max != null)), c.name); }
});

test('Super Formula Lights: front ride height is never taken above 20 mm', () => {
  // 19.5 mm: the usual 1 mm step is shortened to land on the limit
  const near = setupFor('Super Formula Lights', frontRh('19.5'));
  const a = STA.advisor.advise({ findings: frontLow }, near);
  assert.deepStrictEqual([a.suggestions[0].role, a.suggestions[0].axle, a.suggestions[0].dir], ['rideHeight', 'front', '+']);
  assert.match(a.suggestions[0].title, /Raise the front ride height to 20 mm, the limit for this car/);
  const prop = STA.advisor.proposeSetup(near, a.suggestions.slice(0, 1));
  assert.deepStrictEqual(STA.setup.byRole(prop, 'rideHeight', 'front').map((p) => p.num), [20, 20]);

  // 20.0 mm: raising it is not offered at all, and the reason is given
  const at = setupFor('Super Formula Lights', frontRh('20.0'));
  const b = STA.advisor.advise({ findings: frontLow }, at);
  assert.ok(!b.suggestions.some((x) => x.role === 'rideHeight' && x.axle === 'front' && x.dir === '+'));
  assert.ok(b.skipped[0].items.some((i) => /Front ride height \(cannot go above 20 mm on this car, reported by a driver\)/.test(i)), JSON.stringify(b.skipped));
  // the rear has no limit on this car and is untouched by the front one
  assert.strictEqual(STA.setup.limitReason(STA.setup.byRole(at, 'rideHeight', 'rear')[0], '+'), null);

  // the same value on a car with no such limit is still free to move
  const other = STA.advisor.advise({ findings: frontLow }, setupFor('Test GT3', frontRh('20.0')));
  assert.deepStrictEqual([other.suggestions[0].role, other.suggestions[0].dir], ['rideHeight', '+']);
  assert.strictEqual(other.car, null);
});

test('a setting outside the car\'s limit is put right before anything else', () => {
  const s = setupFor('Super Formula Lights', frontRh('22.5'));
  const understeer = [{ id: 'us-entry-high', kind: 'understeer', phase: 'entry', band: 'high', title: 'Corner entry understeer in fast corners', severity: 0.9, confidence: 'medium' }];
  const adv = STA.advisor.advise({ findings: understeer }, s);
  assert.strictEqual(adv.violations.length, 2, 'left and right front');
  const top = adv.suggestions[0];
  assert.ok(top.fix);
  assert.strictEqual(top.title, 'Lower the front ride height to 20 mm');
  assert.strictEqual(adv.suggestions.filter((x) => x.role === 'rideHeight' && x.axle === 'front').length, 1, 'no second, conflicting front ride-height item');
  const prop = STA.advisor.proposeSetup(s, [top]);
  assert.deepStrictEqual(STA.setup.byRole(prop, 'rideHeight', 'front').map((p) => p.raw), ['20.0 mm', '20.0 mm']);
});

test('manual limits: legal ride-height window, click ranges, and a track-only rule', () => {
  // Ferrari 488 GT3 Evo: rear ride height 50 to 90 mm, front at least 50 mm
  const f = setupFor('Ferrari 488 GT3 Evo 2020', (y) => y.replace(/RideHeight: 70\.0 mm/g, 'RideHeight: 90.0 mm').replace(/RideHeight: 55\.0 mm/g, 'RideHeight: 50.0 mm'));
  STA.carLimits.apply(f);
  const rear = STA.setup.byRole(f, 'rideHeight', 'rear')[0], front = STA.setup.byRole(f, 'rideHeight', 'front')[0];
  assert.deepStrictEqual([rear.lo, rear.hi, front.lo, front.hi], [50, 90, 50, undefined]);
  assert.match(STA.setup.limitReason(rear, '+'), /cannot go above 90 mm on this car, from the iRacing manual/);
  assert.match(STA.setup.limitReason(front, '-'), /cannot go below 50 mm/);
  assert.strictEqual(STA.setup.limitReason(front, '+'), null);
  // dampers 0..11 clicks apply to "6 clicks"; the bar range 1..10 applies to a bare blade number
  const damper = STA.setup.byRole(f, 'slowBump', 'front')[0];
  assert.deepStrictEqual([damper.lo, damper.hi], [0, 11]);
  assert.deepStrictEqual([STA.setup.byRole(f, 'arb', 'front')[0].lo, STA.setup.byRole(f, 'arb', 'front')[0].hi], [1, 10]);

  // BMW M4 GT3: the 70 mm minimum applies only on the Nordschleife
  const spa = setupFor('BMW M4 GT3', (y) => y, 'Circuit de Spa-Francorchamps'), ring = setupFor('BMW M4 GT3', (y) => y, 'Nürburgring Nordschleife');
  STA.carLimits.apply(spa); STA.carLimits.apply(ring);
  assert.strictEqual(STA.setup.byRole(spa, 'rideHeight', 'front')[0].lo, undefined);
  assert.strictEqual(STA.setup.byRole(ring, 'rideHeight', 'front')[0].lo, 70);
  assert.strictEqual(STA.carLimits.violations(ring).length, 2, 'the 55 mm fronts are under the Nordschleife minimum');
  assert.strictEqual(STA.carLimits.violations(spa).length, 0);
});

test('a limit the driver enters works like a built-in one and replaces it', () => {
  const s = setupFor('Super Formula Lights', frontRh('19.5'));
  const own = new Map(STA.setup.byRole(s, 'rideHeight', 'front').map((p) => [p.id + '|+', { paramId: p.id, dir: '+', num: 25, raw: '25 mm' }]));
  const adv = STA.advisor.advise({ findings: frontLow }, s, { limits: own });
  assert.strictEqual(adv.suggestions[0].title, 'Raise the front ride height', 'with 25 mm entered, a full 1 mm step from 19.5 is allowed');
  assert.strictEqual(STA.setup.byRole(s, 'rideHeight', 'front')[0].hiSrc, 'set by you');
  // and on a car with nothing built in, the entered limit shortens the step
  const t = setupFor('Test GT3', frontRh('19.5'));
  const own2 = new Map(STA.setup.byRole(t, 'rideHeight', 'front').map((p) => [p.id + '|+', { paramId: p.id, dir: '+', num: 20, raw: '20 mm' }]));
  assert.match(STA.advisor.advise({ findings: frontLow }, t, { limits: own2 }).suggestions[0].title, /to 20 mm, the limit for this car/);
});

test('baseline never steps past a car limit and pulls an illegal starting value back inside', () => {
  const ref = setupFor('Super Formula Lights', frontRh('19.5'));
  const r = STA.baseline.build(ref, { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15, bump: 0.4 }, pref: {}, track: 'Test Ring' });
  assert.ok(STA.setup.byRole(r.setup, 'rideHeight', 'front').every((p) => p.num <= 20), 'bumpy track wants more clearance, but not past 20 mm');
  const bad = STA.baseline.build(setupFor('Super Formula Lights', frontRh('23.0')), { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15 }, pref: {}, track: 'Test Ring' });
  assert.deepStrictEqual(STA.setup.byRole(bad.setup, 'rideHeight', 'front').map((p) => p.num), [20, 20]);
  assert.ok(bad.changes.some((c) => /Moved inside the limit/.test(c.text)));
});

/* ---------- learning from outcomes ---------- */

const load = async (opts, extra) => STA.session.fromIbt(await STA.ibt.read(makeIbt(sim.drive(Object.assign({ laps: 4 }, opts)), extra), { want: STA.session.IBT_WANT }), { name: extra.file });
const record = (s) => Object.assign(STA.session.summaryOf(s), STA.learning.snapshot(s, STA.handling.analyse(s), STA.technique.analyse(s, STA.handling.analyse(s))));

test('changes between two setups are read as role, axle and direction', () => {
  const a = setupFor('Test GT3'), b = setupFor('Test GT3', (y) => y.replace('ArbBlades: 3', 'ArbBlades: 2').replace('RearWingSetting: 5', 'RearWingSetting: 7').replace(/Camber: -3\.4 deg/g, 'Camber: -3.0 deg'));
  assert.deepStrictEqual(STA.learning.changesBetween(a, b).map((c) => c.key).sort(), ['arb|front|-', 'camber|front|+', 'rearWing|rear|+']);
  assert.deepStrictEqual(STA.learning.changesBetween(a, a), []);
});

test('a softer front bar that cures slow-corner understeer is judged to have helped, and is ranked up next time', async () => {
  const softer = SETUP_YAML.replace('ArbBlades: 3', 'ArbBlades: 2');
  const before = await load({ understeer: 0.6 }, { file: 'before.ibt', setupName: 'v1.sto', startDate: 1767225600 });
  const after = await load({ understeer: 0.0 }, { file: 'after.ibt', setupName: 'v2.sto', setupYaml: softer, startDate: 1767229200 });
  const sums = [record(before), record(after)], setups = [before.setup, after.setup];
  assert.ok(sums[0].balance.mid.low >= 0.25 && Math.abs(sums[1].balance.mid.low) < 0.1, 'the stored balance shows the problem, then its absence');

  const rv = STA.learning.review(sums, setups, after);
  assert.strictEqual(rv.changes.length, 1);
  assert.strictEqual(rv.changes[0].key, 'arb|front|-');
  assert.ok(rv.changes[0].targets.length >= 1, 'it is matched to the understeer finding it is a usual answer to');
  assert.strictEqual(rv.changes[0].verdict, 'helped');
  assert.strictEqual(rv.lap.word, 'same', 'equal lap times are not called faster or slower');
  assert.ok(STA.learning.review(sums, setups, before).first);

  const out = STA.learning.outcomes(sums, setups, { sim: 'iracing', car: 'Test GT3' });
  assert.deepStrictEqual([out.get('arb|front|-').tried, out.get('arb|front|-').helped], [1, 1]);
  // Next time the same problem shows up on this car, that change carries its record.
  const findings = [{ id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners', severity: 0.6, confidence: 'medium' }];
  const plain = STA.advisor.advise({ findings }, before.setup), learned = STA.advisor.advise({ findings }, before.setup, { outcomes: out });
  const pick = (adv) => adv.suggestions.find((x) => x.blockKey === 'arb|front|-');
  assert.ok(pick(learned).score > pick(plain).score);
  assert.match(pick(learned).historyText, /On this car before: 1 helped\./);
});

test('a change that twice fails to help is moved below the alternatives', async () => {
  const softer = SETUP_YAML.replace('ArbBlades: 3', 'ArbBlades: 2'), softest = SETUP_YAML.replace('ArbBlades: 3', 'ArbBlades: 1');
  const runs = [
    await load({ understeer: 0.6 }, { file: '1.ibt', setupName: 'v1.sto', startDate: 1767225600 }),
    await load({ understeer: 0.6 }, { file: '2.ibt', setupName: 'v2.sto', setupYaml: softer, startDate: 1767229200 }),
    await load({ understeer: 0.6 }, { file: '3.ibt', setupName: 'v3.sto', setupYaml: softest, startDate: 1767232800 }),
  ];
  const sums = runs.map(record), setups = runs.map((r) => r.setup);
  const rv = STA.learning.review(sums, setups, runs[2]);
  assert.strictEqual(rv.changes[0].verdict, 'none');
  assert.ok(STA.technique.forTargets(rv.changes[0].targets).length >= 1, 'driving advice is available for the problem the change did not fix');
  const out = STA.learning.outcomes(sums, setups, { sim: 'iracing', car: 'Test GT3' });
  assert.deepStrictEqual([out.get('arb|front|-').tried, out.get('arb|front|-').none], [2, 2]);
  const an = STA.handling.analyse(runs[2]);
  const adv = STA.advisor.advise(an, runs[2].setup, { outcomes: out });
  const bar = adv.suggestions.find((x) => x.blockKey === 'arb|front|-');
  if (bar) { assert.ok(bar.demoted); assert.strictEqual(bar.rank, adv.suggestions.length, 'listed last'); assert.match(bar.historyText, /2 no effect\. Listed last\./); }
  assert.notStrictEqual(adv.suggestions[0].blockKey, 'arb|front|-');
  // a different car starts with a clean sheet
  assert.strictEqual(STA.learning.outcomes(sums, setups, { sim: 'iracing', car: 'Other Car' }).size, 0);
});

test('the same setup twice is reported as nothing to judge', async () => {
  const a = await load({}, { file: 'a.ibt', startDate: 1767225600 }), b = await load({}, { file: 'b.ibt', startDate: 1767229200 });
  assert.ok(STA.learning.review([record(a), record(b)], [a.setup], b).sameSetup);
});

/* ---------- driving technique ---------- */

test('driving technique: sections cover the whole lap and the ideal lap is never slower than the best', async () => {
  const s = await load({ laps: 5 }, { file: 't.ibt' });
  const tech = STA.technique.analyse(s, STA.handling.analyse(s));
  assert.ok(tech.laps.length >= 3);
  assert.ok(tech.ideal.gain >= -1e-6 && tech.ideal.time <= s.bestLap.time + 1e-6);
  assert.ok(tech.ideal.gain < 0.5, 'laps that differ only by overall grip have little to gain from mixing sections: ' + tech.ideal.gain);
  for (const it of tech.items) { assert.ok(it.title && it.detail && it.how && it.evidence, it.id); assert.match(it.confidence, /^(low|medium|high)$/); }
  assert.ok(Number.isFinite(tech.metrics.coast) && tech.metrics.coast >= 0 && tech.metrics.coast < 0.5);
});

/* Add `lost` seconds to one lap inside one corner, moving everything after it later. */
function slowDown(s, lap, corner, lost) {
  const g = STA.session.lapGrid(s, lap), t0 = lap.t0 + g.t[corner.a], t1 = lap.t0 + g.t[corner.b];
  for (let i = lap.i0; i < s.n; i++) { const t = s.ch.t[i]; if (t > t0) s.ch.t[i] = t + lost * Math.min(1, (t - t0) / (t1 - t0)); }
  for (const l of s.laps) { if (l === lap) { l.t1 += lost; l.time += lost; } else if (l.t0 > lap.t0) { l.t0 += lost; l.t1 += lost; } }
  s._grids.clear();
}

test('driving technique: a corner the best lap was slow through shows up as time available there', async () => {
  const s = await load({ laps: 5, grips: [1, 1, 1, 1, 1] }, { file: 't.ibt' });
  const timed = s.laps.filter((l) => l.complete && l.valid);
  assert.ok(timed.length >= 4);
  // Every lap but one loses 0.4 s in C1; that one loses 0.7 s in C3 instead, so it is not the best lap.
  const odd = timed[1];
  for (const l of timed) slowDown(s, l, l === odd ? s.corners[2] : s.corners[0], l === odd ? 0.7 : 0.4);
  const tech = STA.technique.analyse(s, STA.handling.analyse(s));
  const ideal = tech.items.find((x) => x.id === 'ideal');
  assert.ok(ideal, 'reported');
  assert.strictEqual(ideal.corners[0], 'C1');
  assert.strictEqual(tech.ideal.sections[0].lap, odd.num, 'and it names the lap that did it better');
  assert.ok(Math.abs(tech.ideal.sections[0].lost - 0.4) < 0.05, 'about 0.4 s: ' + tech.ideal.sections[0].lost);
  assert.ok(Math.abs(tech.ideal.gain - 0.4) < 0.08, 'total: ' + tech.ideal.gain);
  assert.match(ideal.title, /^Best sections add up to .* \(−0\.\d\d s\)$/);
});

test('driving technique: every balance finding has something to try from the seat', () => {
  for (const kind of ['understeer', 'oversteer']) for (const phase of STA.handling.PHASES) assert.ok(STA.technique.forFinding({ kind, phase }).length >= 2, kind + ' ' + phase);
  for (const kind of ['frontLock', 'rearLock', 'wheelspin', 'traction']) assert.ok(STA.technique.forFinding({ kind }).length >= 1, kind);
  assert.deepStrictEqual(STA.technique.forFinding({ kind: 'limiter' }), []);
});

/* ---------- contesting a suggested change ---------- */

const midUndersteer = [{ id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners', severity: 0.7, confidence: 'medium' }];
const contest = (...pairs) => new Map(pairs.map(([key, reason]) => [key, { contest: key, reason }]));

test('a contested change is taken out and the next route is offered in its place, with the reason shown', () => {
  const s = setupFor('Test GT3');
  const plain = STA.advisor.advise({ findings: midUndersteer }, s);
  assert.strictEqual(plain.suggestions[0].blockKey, 'arb|front|-', 'the usual first answer is a softer front bar');
  assert.ok(!plain.suggestions.some((x) => x.alternativeTo));

  const adv = STA.advisor.advise({ findings: midUndersteer }, s, { contested: contest(['arb|front|-', 'tradeoff']) });
  assert.ok(!adv.suggestions.some((x) => x.blockKey === 'arb|front|-'), 'the contested change is gone');
  assert.ok(adv.suggestions.length >= 2, 'and the finding still gets its usual number of answers');
  assert.strictEqual(adv.suggestions[0].blockKey, 'arb|rear|+', 'a stiffer rear bar shifts roll stiffness the same way');
  assert.deepStrictEqual(adv.suggestions[0].alternativeTo, ['Soften the front anti-roll bar (trade-off not wanted)']);
  assert.ok(adv.skipped[0].items.some((i) => /trade-off not wanted/.test(i)));

  // contesting the alternative as well moves on again, and each reason is reported in the driver's terms
  const two = STA.advisor.advise({ findings: midUndersteer }, s, { contested: contest(['arb|front|-', 'none'], ['arb|rear|+', 'worse']) });
  assert.ok(!two.suggestions.some((x) => x.role === 'arb'));
  assert.ok(two.suggestions.length >= 1);
  assert.deepStrictEqual(two.suggestions[0].alternativeTo, ['Soften the front anti-roll bar (tried, did not help)', 'Stiffen the rear anti-roll bar (tried, made it worse)']);
  // the opposite direction is a different change and is not affected
  const os = [{ id: 'os-mid-low', kind: 'oversteer', phase: 'mid', band: 'low', title: 'Mid-corner oversteer in slow corners', severity: 0.7, confidence: 'medium' }];
  assert.ok(STA.advisor.advise({ findings: os }, s, { contested: contest(['arb|front|-', 'tradeoff']) }).suggestions.some((x) => x.blockKey === 'arb|front|+'));
});

test('when every setup route has been contested the app says so and falls back to driving advice', () => {
  const s = setupFor('Test GT3');
  const all = new Map();
  for (let i = 0; i < 20; i++) {
    const adv = STA.advisor.advise({ findings: midUndersteer }, s, { contested: all });
    if (!adv.suggestions.length) {
      assert.strictEqual(adv.exhausted.length, 1);
      assert.strictEqual(adv.exhausted[0].finding, midUndersteer[0].title);
      assert.ok(adv.exhausted[0].tips.length >= 2, 'driving-side options are given');
      assert.ok(adv.exhausted[0].contested.length >= 2);
      return;
    }
    assert.deepStrictEqual(adv.exhausted, []);
    for (const x of adv.suggestions) all.set(x.blockKey, { contest: x.blockKey, reason: 'tradeoff' });
  }
  assert.fail('suggestions never ran out');
});

test('contested changes are remembered per car, can be allowed again, and travel with the library export', async () => {
  await STA.library.open(true); await STA.library.clearAll();
  STA.library.contested.add('iracing', 'Test GT3', 'arb|front|-', 'none');
  STA.library.contested.add('iracing', 'Test GT3', 'arb|front|-', 'worse'); // changing the reason replaces the entry
  STA.library.limits.add('iracing', 'Test GT3', { paramId: 'x/y', dir: '-', num: 2, raw: '2', label: 'X / Y' });
  STA.library.blocked.add('iracing', 'Test GT3', 'tc||+');
  assert.deepStrictEqual(STA.library.contested.list('iracing', 'test gt3').map((e) => [e.contest, e.reason]), [['arb|front|-', 'worse']]);
  assert.strictEqual(STA.library.contested.map('iracing', 'Other Car').size, 0);
  assert.deepStrictEqual(STA.library.blocked.list('iracing', 'Test GT3'), ['tc||+'], 'the three kinds of entry do not mix');
  assert.strictEqual(STA.library.limits.list('iracing', 'Test GT3').length, 1);

  const dump = JSON.parse(JSON.stringify(await STA.library.exportAll()));
  await STA.library.clearAll();
  assert.strictEqual(STA.library.contested.list('iracing', 'Test GT3').length, 0);
  await STA.library.importAll(dump);
  assert.strictEqual(STA.library.contested.map('iracing', 'Test GT3').get('arb|front|-').reason, 'worse');

  STA.library.contested.remove('iracing', 'Test GT3', 'arb|front|-');
  assert.strictEqual(STA.library.contested.list('iracing', 'Test GT3').length, 0);
  assert.strictEqual(STA.library.limits.list('iracing', 'Test GT3').length, 1, 'allowing a change again leaves limits alone');
  STA.library.blocked.clear();
});

test('baseline: a contested change is replaced by another route to the same effect', () => {
  const ref = setupFor('Test GT3'), opts = { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15 }, pref: { balance: 'stable' }, track: 'Test Ring' };
  const first = STA.baseline.build(ref, opts);
  const bar = first.changes.find((c) => c.key === 'arb|rear|-');
  assert.ok(bar, 'a stable car normally starts with a softer rear bar');
  const again = STA.baseline.build(ref, Object.assign({ contested: contest(['arb|rear|-', 'tradeoff']) }, opts));
  assert.ok(!again.changes.some((c) => c.key === 'arb|rear|-'));
  const alt = again.changes.find((c) => /Used instead of: Soften the rear anti-roll bar \(trade-off not wanted\)/.test(c.why));
  assert.ok(alt, JSON.stringify(again.changes.map((c) => [c.key, c.why])));
  assert.strictEqual(STA.setup.byRole(again.setup, 'arb', 'rear')[0].raw, STA.setup.byRole(ref, 'arb', 'rear')[0].raw, 'the rear bar is left where it was');
});

test('baseline: contesting the rear wing change also drops the front aero change that only existed to balance it', () => {
  const ref = setupFor('Test GT3'), opts = { profile: { wot: 0.72, tLow: 0.2, tHigh: 0.15 }, pref: {}, track: 'Test Ring' };
  const first = STA.baseline.build(ref, opts);
  assert.deepStrictEqual(first.changes.map((c) => c.key), ['rearWing|rear|-', 'frontAero|front|-'], 'low-downforce track: less wing at both ends');
  const again = STA.baseline.build(ref, Object.assign({ contested: contest(['rearWing|rear|-', 'tradeoff']) }, opts));
  assert.deepStrictEqual(again.changes, [], 'the front is not trimmed on its own');
  assert.ok(again.notApplied.some((x) => x.label === 'Front aero' && /only wanted together with the rear wing change/.test(x.reason)));
  assert.ok(again.notApplied.some((x) => x.label === 'Rear wing' && /trade-off not wanted/.test(x.reason)));
});

/* ---------- reasoning: why a change was made, what happened, what the app now thinks ---------- */

const usMidLow = { id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners', severity: 0.7 };
const bal = (midLow, entryAll) => ({ entry: { low: null, medium: null, high: null, all: entryAll == null ? 0 : entryAll }, mid: { low: midLow, medium: null, high: null, all: midLow }, exit: { low: null, medium: null, high: null, all: 0 } });
let runNo = 0;
const run = (setup, midLow, extra) => Object.assign({ id: 'run-' + (++runNo), sim: 'iracing', car: 'Test GT3', track: 'Test Ring', recordedAt: 1767225600000 + runNo * 3600000,
  bestLap: 90, medianLap: 90.2, lapSpread: 0.1, setupId: setup.id, balance: bal(midLow), findings: midLow >= 0.25 ? [usMidLow] : [], metrics: {}, habits: [] }, extra || {});
const base = () => setupFor('Test GT3');
const softBar = () => setupFor('Test GT3', (y) => y.replace('ArbBlades: 3', 'ArbBlades: 2'));
const softerBar = () => setupFor('Test GT3', (y) => y.replace('ArbBlades: 3', 'ArbBlades: 1'));
const moreWing = () => setupFor('Test GT3', (y) => y.replace('RearWingSetting: 5', 'RearWingSetting: 6'));
const evenMoreWing = () => setupFor('Test GT3', (y) => y.replace('RearWingSetting: 5', 'RearWingSetting: 7'));
const judged = (a, b, sa, sb, notes) => STA.learning.judge(a, b, sa, sb, notes).changes[0];

test('when a change misses its target, the app says which part of the reasoning failed', () => {
  const a = base(), b = softBar();
  const small = judged(run(a, 0.60), run(b, 0.57), a, b);
  assert.deepStrictEqual([small.why, small.verdict, small.cause], ['app', 'none', 'tooSmall']);
  assert.match(small.rethink, /Right direction, too small/);
  assert.match(small.targets[0].mechanism, /front grip/, 'the reasoning behind the change is on record');

  const nothing = judged(run(a, 0.60), run(b, 0.60), a, b);
  assert.strictEqual(nothing.cause, 'noLever');
  assert.match(nothing.rethink, /does not drive it on this car\. Next: /, nothing.rethink);
  assert.ok(!/anti-roll bar/.test(nothing.rethink.split('Next:')[1]), 'the next idea is a different kind of setting: ' + nothing.rethink);

  const habit = judged(run(a, 0.60), run(b, 0.60, { habits: [{ relates: 'understeer|mid', title: 'Early, hesitant throttle' }] }), a, b);
  assert.strictEqual(habit.cause, 'driver');
  assert.match(habit.rethink, /your laps show early, hesitant throttle: likely the driving/);

  const wrong = judged(run(a, 0.60), run(b, 0.70), a, b);
  assert.deepStrictEqual([wrong.verdict, wrong.cause], ['hurt', 'wrongWay']);

  const far = judged(run(a, 0.60), run(b, -0.20), a, b);
  assert.deepStrictEqual([far.verdict, far.cause, far.overshot], ['helped', 'overshot', true]);

  const fixedButSlower = judged(run(a, 0.60), run(b, 0.20, { medianLap: 91.5 }), a, b);
  assert.deepStrictEqual([fixedButSlower.verdict, fixedButSlower.cause], ['none', 'notTheLimit']);

  const good = judged(run(a, 0.60), run(b, 0.20), a, b);
  assert.deepStrictEqual([good.verdict, good.cause, good.rethink], ['helped', 'asExpected', 'As expected.']);
});

test('the driver can say what a change was for, and overrule the telemetry', () => {
  const a = base(), b = moreWing();
  const before = run(a, 0.0, { balance: bal(0.0, -0.20) }), after = run(b, 0.0, { balance: bal(0.0, -0.05) });
  const blind = judged(before, after, a, b);
  assert.deepStrictEqual([blind.why, blind.cause, blind.targets.length], ['unknown', 'lapOnly', 0]);
  assert.match(blind.rethink, /No reason on record: lap unchanged\. Say what it was for\./);
  assert.ok(STA.learning.intentChoices(before).some((o) => o.value === 'g:oversteer|entry'));

  const told = judged(before, after, a, b, { 'rearWing|rear|+': { target: 'g:oversteer|entry' } });
  assert.deepStrictEqual([told.why, told.verdict, told.targets[0].title, told.targets[0].text], ['driver', 'helped', 'Entry oversteer', '−20% → −5%']);

  const overruled = judged(before, after, a, b, { 'rearWing|rear|+': { target: 'g:oversteer|entry', verdict: 'hurt' } });
  assert.deepStrictEqual([overruled.verdict, overruled.cause, overruled.auto], ['hurt', 'yourCall', 'helped']);
  assert.match(overruled.rethink, /Your call \(telemetry said helped\)/);

  // a stated problem the telemetry never showed cannot be judged by numbers, only by the driver
  const unseen = judged(before, after, a, b, { 'rearWing|rear|+': { target: 'g:understeer|exit' } });
  assert.strictEqual(unseen.cause, 'notSeen');
  assert.strictEqual(judged(before, after, a, b, { 'rearWing|rear|+': { target: 'g:understeer|exit', verdict: 'helped' } }).verdict, 'helped');
  const trying = judged(before, after, a, b, { 'rearWing|rear|+': { target: 'none' } });
  assert.deepStrictEqual([trying.why, trying.rethink], ['none', 'No target: lap unchanged.']);
  // a stated reason that was measured by a wheel-speed share
  const lock = judged(run(a, 0, { metrics: { frontLock: 0.08 } }), run(b, 0, { metrics: { frontLock: 0.02 } }), a, b, { 'rearWing|rear|+': { target: 'g:frontLock' } });
  assert.deepStrictEqual([lock.verdict, lock.targets[0].text], ['helped', '8.0% → 2.0% of the time']);
});

test('an unexpected gain is credited to the change and offered for that problem from then on', () => {
  const a = base(), b = moreWing(), c = evenMoreWing();
  const r1 = run(a, 0.60), r2 = run(b, 0.30);
  const j = STA.learning.judge(r1, r2, a, b);
  assert.strictEqual(j.changes[0].why, 'unknown', 'more rear wing is not a textbook answer to slow-corner understeer');
  assert.deepStrictEqual(j.bonus.map((x) => [x.key, x.text, x.credit]), [['understeer|mid', '+60% → +30%', ['rearWing|rear|+']]]);

  const know = STA.learning.knowledge([r1, r2], [a, b], { sim: 'iracing', car: 'Test GT3' });
  assert.deepStrictEqual(know.links.get('understeer|mid').map((e) => [e.key, e.n]), [['rearWing|rear|+', 1]]);
  assert.match(know.relay[0].text, /^New: add rear wing also cut mid-corner understeer \(1 run\)\. Now offered for it\.$/);
  assert.strictEqual(know.relay[0].confidence, 'low');

  // The next time that problem shows up, the learned answer leads and says where it came from.
  const adv = STA.advisor.advise({ findings: [Object.assign({ confidence: 'medium' }, usMidLow)] }, b, { learned: know.links, outcomes: know.stats });
  assert.deepStrictEqual([adv.suggestions[0].blockKey, adv.suggestions[0].learned], ['rearWing|rear|+', 1]);
  assert.match(adv.suggestions[0].effect, /Learned from your own runs/);
  assert.ok(STA.advisor.advise({ findings: [Object.assign({ confidence: 'medium' }, usMidLow)] }, b).suggestions[0].blockKey !== 'rearWing|rear|+', 'without the lesson it is not offered');

  // Tried again on the strength of that lesson and it works: now it is a tested answer, not a one-off.
  const r3 = run(c, 0.05);
  const again = STA.learning.knowledge([r1, r2, r3], [a, b, c], { sim: 'iracing', car: 'Test GT3' });
  const last = again.judged.get(r3.id).changes[0];
  assert.deepStrictEqual([last.why, last.verdict, last.targets[0].mechanism], ['app', 'helped', 'Learned on this car: it cut this problem before.']);
  assert.ok(again.relay.some((x) => x.kind === 'works' && /Add rear wing works for mid-corner understeer \(1 of 1 run\)/.test(x.text)), JSON.stringify(again.relay));

  // Tried again and it does nothing: the lesson is withdrawn.
  const r3b = run(c, 0.30);
  const gone = STA.learning.knowledge([r1, r2, r3b], [a, b, c], { sim: 'iracing', car: 'Test GT3' });
  assert.strictEqual(gone.links.has('understeer|mid'), false);
  assert.ok(gone.relay.some((x) => x.kind === 'fails' && /Add rear wing does not move mid-corner understeer/.test(x.text)));
});

test('a gain shared between two changes is not learned from a single run', () => {
  const a = base(), both = setupFor('Test GT3', (y) => y.replace('RearWingSetting: 5', 'RearWingSetting: 6').replace('BrakePressureBias: 54.0%', 'BrakePressureBias: 55.0%'));
  const know = STA.learning.knowledge([run(a, 0.60), run(both, 0.30)], [a, both], { sim: 'iracing', car: 'Test GT3' });
  assert.strictEqual(know.links.size, 0);
  assert.strictEqual(STA.learning.judge(run(a, 0.60), run(both, 0.30), a, both).bonus[0].credit.length, 2);
});

test('a step that was too small is offered again as a bigger one', () => {
  const a = base(), b = softBar();
  const know = STA.learning.knowledge([run(a, 0.60), run(b, 0.57)], [a, b], { sim: 'iracing', car: 'Test GT3' });
  assert.strictEqual(know.stats.get('arb|front|-').by['understeer|mid'].last, 'tooSmall');
  assert.ok(know.relay.some((x) => x.kind === 'size' && /one step was too small\. A bigger step is offered/.test(x.text)));
  const adv = STA.advisor.advise({ findings: [Object.assign({ confidence: 'medium' }, usMidLow)] }, b, { outcomes: know.stats, learned: know.links });
  const bar = adv.suggestions.find((x) => x.blockKey === 'arb|front|-');
  assert.deepStrictEqual([bar.amount, bar.bigger], ['2 steps', true]);
  // ...unless the car has no room for it
  const adv2 = STA.advisor.advise({ findings: [Object.assign({ confidence: 'medium' }, usMidLow)] }, softerBar(), { outcomes: know.stats });
  const bar2 = adv2.suggestions.find((x) => x.blockKey === 'arb|front|-');
  assert.ok(!bar2 || bar2.amount === '2 steps', 'a GT3 without a known bar range is not capped');
});

test('what the driver says about a change is stored, exported and cleared with the library', async () => {
  await STA.library.open(true); await STA.library.clearAll();
  const R = STA.library.reasons;
  R.set('run-x', 'rearWing|rear|+', { target: 'g:oversteer|entry' });
  R.set('run-x', 'rearWing|rear|+', { verdict: 'helped' });
  assert.deepStrictEqual(R.get('run-x', 'rearWing|rear|+'), { target: 'g:oversteer|entry', verdict: 'helped' });
  R.set('run-x', 'rearWing|rear|+', { verdict: null });
  assert.deepStrictEqual(R.get('run-x', 'rearWing|rear|+'), { target: 'g:oversteer|entry' });
  const dump = JSON.parse(JSON.stringify(await STA.library.exportAll()));
  await STA.library.clearAll();
  assert.deepStrictEqual(R.all(), {});
  await STA.library.importAll(dump);
  assert.strictEqual(R.get('run-x', 'rearWing|rear|+').target, 'g:oversteer|entry');
  R.set('run-x', 'rearWing|rear|+', { target: null });
  assert.deepStrictEqual(R.all(), {}, 'an emptied answer leaves nothing behind');
});

/* ---------- folder library ---------- */

test('the folder index is grouped by sim, then car, then track, newest first', () => {
  const e = (name, sim, car, track, when, extra) => Object.assign({ id: 'f:' + name, folderId: 'f', path: name, name, kind: 'run', sim, car, track, recordedAt: when }, extra || {});
  const list = [
    e('a.ibt', 'iracing', 'Super Formula Lights', 'Okayama – Full', 100, { sessionId: 's1', bestLap: 84.2 }),
    e('b.ibt', 'iracing', 'Super Formula Lights', 'Okayama – Full', 300),
    e('c.ibt', 'iracing', 'Super Formula Lights', 'Suzuka – Grand Prix', 200, { sessionId: 's2', bestLap: 110.5 }),
    e('d.ibt', 'iracing', 'BMW M4 GT3', 'Spa', 50, { sessionId: 's3' }),
    e('x.duckdb', 'lmu', 'Team WRT 2024 #46:WE2', 'Fuji Speedway', 400),
    e('bad.ibt', 'iracing', 'x', 'y', 1, { error: 'not a telemetry file' }),
    { id: 'f:s.svm', folderId: 'f', kind: 'setup', name: 's.svm' },
  ];
  const tree = STA.folders.tree(list, [{ sim: 'iracing', car: 'BMW M4 GT3', track: 'Spa', bestLap: 137.9 }]);
  assert.deepStrictEqual(tree.map((s) => [s.sim, s.runs]), [['iracing', 4], ['lmu', 1]], 'unreadable files and setup files are not runs');
  const sfl = tree[0].cars[0];
  assert.deepStrictEqual([sfl.car, tree[0].cars[1].car], ['Super Formula Lights', 'BMW M4 GT3'], 'the car driven most recently comes first');
  assert.deepStrictEqual(sfl.tracks.map((t) => [t.track, t.runs.length, t.unopened, t.best]), [['Okayama – Full', 2, 1, 84.2], ['Suzuka – Grand Prix', 1, 0, 110.5]]);
  assert.deepStrictEqual(sfl.tracks[0].runs.map((r) => r.name), ['b.ibt', 'a.ibt']);
  assert.strictEqual(tree[0].cars[1].tracks[0].best, 137.9, 'a best lap from an earlier visit is found through the session history');
  assert.strictEqual(sfl.tracks[0].key, STA.folders.comboKey({ sim: 'iracing', car: 'super formula lights', track: 'Okayama - Full' }), 'the same combination under slightly different spelling');
});

test('where the driver left off is remembered per car and track', () => {
  const R = STA.folders.resume; R.clear();
  assert.strictEqual(R.last(), null);
  R.set('iracing|sfl|okayama', { open: ['f:a.ibt'], active: 'f:a.ibt', overlay: [{ f: 'f:a.ibt', n: 4, ref: true }], tab: 'map', at: 1 });
  R.set('lmu|wrt|fuji', { open: ['f:x.duckdb'], active: 'f:x.duckdb', overlay: [], tab: 'advice', at: 2 });
  assert.strictEqual(R.last(), 'lmu|wrt|fuji');
  assert.deepStrictEqual(R.get('iracing|sfl|okayama').overlay, [{ f: 'f:a.ibt', n: 4, ref: true }]);
  assert.strictEqual(R.get('nothing'), null);
  R.clear();
});
