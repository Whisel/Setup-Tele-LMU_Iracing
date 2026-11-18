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
  assert.match(pick(learned).historyText, /Tried once on this car before: 1 helped/);
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
  if (bar) { assert.ok(bar.demoted); assert.strictEqual(bar.rank, adv.suggestions.length, 'listed last'); assert.match(bar.historyText, /2 made no clear difference/); }
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
  assert.match(ideal.title, /quicker than your best lap/);
});

test('driving technique: every balance finding has something to try from the seat', () => {
  for (const kind of ['understeer', 'oversteer']) for (const phase of STA.handling.PHASES) assert.ok(STA.technique.forFinding({ kind, phase }).length >= 2, kind + ' ' + phase);
  for (const kind of ['frontLock', 'rearLock', 'wheelspin', 'traction']) assert.ok(STA.technique.forFinding({ kind }).length >= 1, kind);
  assert.deepStrictEqual(STA.technique.forFinding({ kind: 'limiter' }), []);
});
