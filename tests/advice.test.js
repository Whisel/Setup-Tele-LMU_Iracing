const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const sim = require('./helpers/sim.js');
const { makeIbt, SETUP_YAML } = require('./helpers/make-ibt.js');

async function session(opts, extra) {
  const run = sim.drive(Object.assign({ laps: 4 }, opts));
  return STA.session.fromIbt(await STA.ibt.read(makeIbt(run, extra), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
}

test('a car that follows the steering shows no balance finding', async () => {
  const an = STA.handling.analyse(await session({ understeer: 0 }));
  assert.ok(an.balance, 'steering was calibrated');
  assert.deepStrictEqual(an.findings.filter((f) => f.area === 'Balance'), []);
  for (const ph of STA.handling.PHASES) assert.ok(Math.abs(an.balance.matrix[ph].all.idx) < 0.1, ph + ' is near zero');
});

test('extra steering at the limit in slow corners is reported as slow-corner understeer, and nowhere else', async () => {
  const an = STA.handling.analyse(await session({ understeer: 0.6 }));
  const bal = an.findings.filter((f) => f.area === 'Balance');
  assert.ok(bal.length >= 1);
  assert.ok(bal.every((f) => f.kind === 'understeer' && f.band === 'low'), JSON.stringify(bal.map((f) => f.id)));
  assert.ok(bal.some((f) => f.corners.indexOf('C1') >= 0));
  assert.ok(an.balance.matrix.mid.high.idx == null || Math.abs(an.balance.matrix.mid.high.idx) < 0.1, 'the fast corner stays neutral');
});

test('advice turns understeer into changes that exist on this car, with current values and direction', async () => {
  const s = await session({ understeer: 0.6 });
  const an = STA.handling.analyse(s), adv = STA.advisor.advise(an, s.setup);
  assert.ok(adv.suggestions.length >= 1);
  const top = adv.suggestions[0];
  assert.strictEqual(top.rank, 1);
  assert.ok(['arb', 'brakeBias', 'spring', 'slowBump', 'toe', 'camber', 'diffPreload'].indexOf(top.role) >= 0, top.role);
  const arb = adv.suggestions.find((x) => x.role === 'arb' && x.axle === 'front');
  if (arb) { assert.strictEqual(arb.dir, '-'); assert.strictEqual(arb.current, '3'); assert.strictEqual(arb.change.delta, -1); }
  const prop = STA.advisor.proposeSetup(s.setup, adv.suggestions.slice(0, 1));
  assert.notStrictEqual(prop.id, s.setup.id);
  assert.strictEqual(prop.parentId, s.setup.id);
  assert.ok(STA.setup.diff(s.setup, prop).some((r) => r.changed));
});

test('advice never proposes a setting the car does not have, and says so', () => {
  const setup = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'c', track: 't', name: 'n' });
  const findings = [
    { id: 'a', kind: 'oversteer', phase: 'entry', band: 'low', title: 'Entry oversteer', severity: 0.8, confidence: 'medium' },
    { id: 'b', kind: 'frontLock', title: 'Front locking', severity: 0.5, confidence: 'high' },
    { id: 'c', kind: 'camberTooMuch', axle: 'rear', title: 'Rear camber', severity: 0.3, confidence: 'low' },
  ];
  const adv = STA.advisor.advise({ findings }, setup);
  const ids = new Set(setup.params.map((p) => p.id));
  for (const sg of adv.suggestions) for (const id of sg.paramIds) assert.ok(ids.has(id));
  const bias = adv.suggestions.find((x) => x.role === 'brakeBias');
  assert.ok(bias && bias.conflict, 'entry oversteer wants bias forward, front locking wants it rearward: flagged as a conflict');
  assert.strictEqual(adv.suggestions.find((x) => x.role === 'camber').axle, 'rear');
  assert.strictEqual(adv.suggestions.find((x) => x.role === 'camber').change.delta, 0.2, 'less negative camber');
  assert.ok(adv.skipped.some((k) => /Engine braking|Differential lock off power/.test(k.items.join(' '))));
  assert.strictEqual(STA.advisor.advise({ findings }, null).suggestions.length, 0);
});

const setupWith = (edit) => STA.setup.fromIracing(STA.yaml.parse(edit(SETUP_YAML)).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'n' });
// In the test setup the front bar is "ArbBlades: 3" and the rear bar "ArbBlades: 2".
const rearBarDisconnected = (y) => y.replace('ArbBlades: 2', 'ArbBlades: Disconnected');

test('a setting already at the end of its range is recognised from its value', () => {
  const s = setupWith((y) => rearBarDisconnected(y).replace('DiffPreload: 80 Nm', 'DiffPreload: 0 Nm'));
  const rearBar = STA.setup.byRole(s, 'arb', 'rear')[0], frontBar = STA.setup.byRole(s, 'arb', 'front')[0], preload = STA.setup.byRole(s, 'diffPreload')[0];
  assert.strictEqual(STA.setup.limitReason(rearBar, '-'), 'already disconnected');
  assert.strictEqual(STA.setup.limitReason(rearBar, '+'), null, 'a disconnected bar can still be stiffened');
  assert.strictEqual(STA.setup.limitReason(frontBar, '-'), null);
  assert.strictEqual(STA.setup.limitReason(preload, '-'), 'already at 0 Nm');
  const camber = STA.setup.byRole(s, 'camber', 'front')[0];
  assert.strictEqual(STA.setup.limitReason(camber, '-'), null, 'a negative value is not treated as a floor');
});

test('advice never asks to soften a disconnected bar: it gets the same balance change another way', () => {
  const s = setupWith(rearBarDisconnected);
  const findings = [{ id: 'os', kind: 'oversteer', phase: 'mid', band: 'low', title: 'Mid-corner oversteer', severity: 0.8, confidence: 'medium' },
    { id: 'tr', kind: 'traction', phase: 'exit', band: 'low', title: 'Traction-limited exits', severity: 0.6, confidence: 'medium' }];
  const adv = STA.advisor.advise({ findings }, s);
  assert.ok(!adv.suggestions.some((x) => x.role === 'arb' && x.axle === 'rear' && x.dir === '-'), 'no softer-rear-bar suggestion');
  const top = adv.suggestions[0];
  assert.deepStrictEqual([top.role, top.axle, top.dir], ['arb', 'front', '+'], 'stiffening the front bar shifts roll stiffness the same way');
  assert.match(top.insteadOf, /Rear anti-roll bar \(already disconnected\)/);
  assert.ok(adv.skipped.some((k) => k.items.some((i) => /already disconnected/.test(i))));
  // the proposed setup leaves the disconnected bar alone
  const prop = STA.advisor.proposeSetup(s, adv.suggestions);
  assert.strictEqual(STA.setup.byRole(prop, 'arb', 'rear')[0].raw, 'Disconnected');
});

test('a change the driver marks as not possible is dropped and the next route is used', () => {
  const s = setupWith(rearBarDisconnected);
  const findings = [{ id: 'os', kind: 'oversteer', phase: 'mid', band: 'low', title: 'Mid-corner oversteer', severity: 0.8, confidence: 'medium' }];
  const first = STA.advisor.advise({ findings }, s).suggestions[0];
  assert.strictEqual(first.blockKey, 'arb|front|+');
  const adv = STA.advisor.advise({ findings }, s, { blocked: new Set([first.blockKey]) });
  assert.ok(!adv.suggestions.some((x) => x.blockKey === first.blockKey));
  assert.deepStrictEqual([adv.suggestions[0].role, adv.suggestions[0].axle, adv.suggestions[0].dir], ['spring', 'rear', '-'], 'softer rear springs are the next way to add rear grip');
  assert.ok(adv.skipped[0].items.some((i) => /you marked this as not possible/.test(i)));
  // and the remembered list round-trips per car
  STA.library.blocked.clear();
  STA.library.blocked.add('iracing', 'Test GT3', first.blockKey);
  assert.ok(STA.library.blocked.set('iracing', 'test gt3').has('arb|front|+'), 'car names match regardless of case');
  assert.strictEqual(STA.library.blocked.set('iracing', 'Other Car').size, 0);
  STA.library.blocked.remove('iracing', 'Test GT3', first.blockKey);
  assert.strictEqual(STA.library.blocked.list('iracing', 'Test GT3').length, 0);
});

// A GT3-style clutch-pack differential: lock on power is a count of friction faces.
const withFaces = (n) => (y) => y.replace('DiffPreload: 80 Nm', 'DiffPreload: 80 Nm\n   ClutchFrictionFaces: ' + n);
const exitUndersteer = [{ id: 'us', kind: 'understeer', phase: 'exit', band: 'low', title: 'Corner exit understeer', severity: 0.8, confidence: 'medium' }];

test('differential lock on power is never taken below 2 friction faces', () => {
  const at2 = setupWith(withFaces(2)), at4 = setupWith(withFaces(4));
  const p2 = STA.setup.byRole(at2, 'diffPower')[0];
  assert.strictEqual(p2.id, 'drivetrain/differential/clutchfrictionfaces');
  assert.match(STA.setup.limitReason(p2, '-'), /already at 2, the lowest this setting goes/);
  assert.strictEqual(STA.setup.limitReason(p2, '+'), null, 'it can still be raised');
  assert.strictEqual(STA.setup.limitReason(STA.setup.byRole(at4, 'diffPower')[0], '-'), null, 'from 4 it can still come down');

  // exit understeer normally starts with less lock on power; at 2 the app must go elsewhere
  const adv2 = STA.advisor.advise({ findings: exitUndersteer }, at2);
  assert.ok(!adv2.suggestions.some((x) => x.role === 'diffPower' && x.dir === '-'));
  assert.strictEqual(adv2.suggestions[0].role, 'diffPreload', 'next route: less preload');
  assert.ok(adv2.skipped[0].items.some((i) => /Differential lock on power \(already at 2/.test(i)));
  const adv4 = STA.advisor.advise({ findings: exitUndersteer }, at4);
  assert.deepStrictEqual([adv4.suggestions[0].role, adv4.suggestions[0].dir], ['diffPower', '-'], 'at 4 the reduction is offered');
});

test('a limit the driver reports applies at that value, not for ever', () => {
  const at80 = setupWith((y) => y), at120 = setupWith((y) => y.replace('DiffPreload: 80 Nm', 'DiffPreload: 120 Nm'));
  const lim = new Map([['drivetrain/differential/diffpreload|-', { paramId: 'drivetrain/differential/diffpreload', dir: '-', num: 80, raw: '80 Nm' }]]);
  const none = STA.advisor.advise({ findings: exitUndersteer }, at80);
  assert.strictEqual(none.suggestions[0].role, 'diffPreload', 'without a limit, less preload is the first available fix');
  const held = STA.advisor.advise({ findings: exitUndersteer }, at80, { limits: lim });
  assert.ok(!held.suggestions.some((x) => x.role === 'diffPreload'));
  assert.ok(held.skipped[0].items.some((i) => /cannot go below 80 Nm on this car/.test(i)));
  const above = STA.advisor.advise({ findings: exitUndersteer }, at120, { limits: lim });
  assert.strictEqual(above.suggestions[0].role, 'diffPreload', 'at 120 Nm there is room to come down to the limit');
  // stored per car, and a role-level block and a value limit can sit side by side
  STA.library.blocked.clear();
  STA.library.limits.add('iracing', 'Test GT3', { paramId: 'x/y', dir: '-', num: 2, raw: '2', label: 'X / Y' });
  STA.library.blocked.add('iracing', 'Test GT3', 'arb|front|+');
  assert.strictEqual(STA.library.limits.map('iracing', 'test gt3').get('x/y|-').num, 2);
  assert.deepStrictEqual(STA.library.blocked.list('iracing', 'Test GT3'), ['arb|front|+']);
  STA.library.limits.remove('iracing', 'Test GT3', 'x/y', '-');
  assert.strictEqual(STA.library.limits.list('iracing', 'Test GT3').length, 0);
  STA.library.blocked.clear();
});

test('baseline also routes around a setting that cannot move', () => {
  const ref = setupWith(rearBarDisconnected);
  const r = STA.baseline.build(ref, { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15 }, pref: { balance: 'stable' }, track: 'Test Ring' });
  assert.ok(!r.changes.some((c) => c.label === 'Rear anti-roll bar'));
  const alt = r.changes.find((c) => c.label === 'Front anti-roll bar');
  assert.ok(alt, 'front bar used instead');
  assert.strictEqual(alt.to, '4');
  assert.match(alt.why, /Used instead of: Rear anti-roll bar \(already disconnected\)/);
  assert.strictEqual(STA.setup.byRole(r.setup, 'arb', 'rear')[0].raw, 'Disconnected');
});

test('baseline: earlier work on the same car and track is found before anything new is proposed', async () => {
  await STA.library.open(true); await STA.library.clearAll();
  const s = await session({}, { setupName: 'my_race_v3.sto' });
  const base = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML.replace('RearWingSetting: 5', 'RearWingSetting: 7')).CarSetup, { car: 'Test GT3', track: 'Other Park', name: 'baseline' });
  const other = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML.replace('ArbBlades: 3', 'ArbBlades: 5')).CarSetup, { car: 'Test GT3', track: 'Other Park', name: 'other_park_q' });
  await STA.library.saveSetup(base); await STA.library.saveSetup(other);
  const q = { sim: 'iracing', car: 'Test GT3', track: s.trackName, carClass: 'GT3' };

  let prev = STA.baseline.findPrevious(await STA.library.setups(), q);
  assert.strictEqual(prev.sameCombo.length, 0);
  assert.strictEqual(STA.baseline.recommend(prev).mode, 'adapt', 'a setup for the same car elsewhere comes before the sim baseline');
  assert.strictEqual(STA.baseline.recommend(prev).setup.name, 'other_park_q');
  assert.strictEqual(prev.simBaselines.length, 1);

  await STA.library.recordUse(s.setup, STA.session.summaryOf(s));
  prev = STA.baseline.findPrevious(await STA.library.setups(), q);
  const rec = STA.baseline.recommend(prev);
  assert.strictEqual(rec.mode, 'continue');
  assert.strictEqual(rec.setup.name, 'my_race_v3');
  assert.ok(Math.abs(rec.setup.usage.bestLap - s.bestLap.time) < 1e-9);

  assert.strictEqual(STA.baseline.recommend(STA.baseline.findPrevious([], q)).mode, 'none');
});

test('baseline: built from the sim baseline, differs from it, and explains each change', () => {
  const ref = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'baseline' });
  const profile = { wot: 0.72, tLow: 0.4, tHigh: 0.05, bump: 0.3 };
  const r = STA.baseline.build(ref, { profile, pref: { balance: 'stable' }, track: 'Test Ring' });
  assert.strictEqual(r.track.downforce, 'low'); assert.strictEqual(r.track.surface, 'bumpy'); assert.strictEqual(r.track.corners, 'slow');
  const by = (label) => r.changes.find((c) => c.label === label);
  assert.strictEqual(by('Rear wing').to, '3', 'two steps off a rear wing of 5');
  assert.strictEqual(by('Front ride height').to, '56.0 mm');
  assert.strictEqual(by('Rear anti-roll bar').to, '0', 'softened once for slow corners and once for stability');
  assert.strictEqual(by('Brake bias').to, '54.5%');
  assert.ok(r.changes.every((c) => c.why));
  assert.notStrictEqual(r.setup.fingerprint, ref.fingerprint);
  assert.strictEqual(r.setup.parentId, ref.id);
  assert.ok(STA.setup.diff(ref, r.setup).filter((x) => x.changed).length >= r.changes.length);
  // with nothing to react to, the baseline is the reference
  const same = STA.baseline.build(ref, { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15, bump: 0.05 }, pref: {}, track: 'Test Ring' });
  assert.strictEqual(same.changes.length, 0);
});

test('baseline leans against a balance problem that keeps recurring with this car', () => {
  const ref = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'baseline' });
  const tnd = { id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners' };
  const sums = [1, 2, 3].map((i) => ({ id: 's' + i, sim: 'iracing', car: 'Test GT3', tendencies: i < 3 ? [tnd] : [] }));
  const t = STA.baseline.tendencies(sums, { sim: 'iracing', car: 'test gt3' });
  assert.strictEqual(t[0].count, 2);
  const r = STA.baseline.build(ref, { profile: { wot: 0.58, tLow: 0.2, tHigh: 0.15 }, pref: {}, tendencies: t, track: 'Test Ring' });
  assert.strictEqual(r.changes.length, 1);
  assert.strictEqual(r.changes[0].label, 'Front anti-roll bar');
  assert.strictEqual(r.changes[0].to, '2');
});

test('several setups for one car and track are kept apart, each with its own sessions and best lap', async () => {
  await STA.library.open(true); await STA.library.clearAll();
  const v2 = SETUP_YAML.replace('ArbBlades: 3', 'ArbBlades: 2').replace('RearWingSetting: 5', 'RearWingSetting: 6');
  const load = async (opts, extra) => STA.session.fromIbt(await STA.ibt.read(makeIbt(sim.drive(opts), extra), { want: STA.session.IBT_WANT }), { name: extra.file });
  // three runs: two on race_v1 (the second one later and quicker), one on race_v2
  const runs = [
    await load({ laps: 3 }, { file: 'a.ibt', setupName: 'race_v1.sto', startDate: 1767225600 }),
    await load({ laps: 3 }, { file: 'b.ibt', setupName: 'race_v2.sto', setupYaml: v2, startDate: 1767229200 }),
    await load({ laps: 3, grips: [1.03, 1.03, 1.03, 1.03] }, { file: 'c.ibt', setupName: 'race_v1.sto', startDate: 1767232800 }),
  ];
  assert.strictEqual(runs[0].setup.id, runs[2].setup.id, 'the same values on the same car and track are one setup');
  assert.notStrictEqual(runs[0].setup.id, runs[1].setup.id);
  for (const r of runs) await STA.library.recordUse(r.setup, STA.session.summaryOf(r));

  const all = await STA.library.setups();
  assert.strictEqual(all.length, 2);
  const v1 = all.find((x) => x.name === 'race_v1'), second = all.find((x) => x.name === 'race_v2');
  assert.strictEqual(v1.usage.sessions.length, 2);
  assert.strictEqual(second.usage.sessions.length, 1);
  assert.ok(Math.abs(v1.usage.bestLap - Math.min(runs[0].bestLap.time, runs[2].bestLap.time)) < 1e-9, 'best lap is the best across both runs on that setup');
  assert.ok(v1.usage.bestLap < second.usage.bestLap);

  // both are offered as earlier work, most recently driven first, and they can be compared
  const prev = STA.baseline.findPrevious(all, { sim: 'iracing', car: 'Test GT3', track: runs[0].trackName });
  assert.deepStrictEqual(prev.sameCombo.map((x) => x.name), ['race_v1', 'race_v2']);
  assert.deepStrictEqual(STA.setup.diff(v1, second).filter((r) => r.changed).map((r) => r.label).sort(), ['ARB blades', 'Rear wing setting']);
});

test('library: remembers setups and usage, exports and re-imports', async () => {
  await STA.library.open(true); await STA.library.clearAll();
  const a = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'a' });
  await STA.library.recordUse(a, { id: 's1', recordedAt: 1000, bestLap: 95.5, laps: 8 });
  await STA.library.recordUse(a, { id: 's2', recordedAt: 2000, bestLap: 94.9, laps: 5 });
  await STA.library.recordUse(a, { id: 's2', recordedAt: 2000, bestLap: 94.9, laps: 5 });
  const [rec] = await STA.library.setups();
  assert.deepStrictEqual([rec.usage.sessions.length, rec.usage.lastUsed, rec.usage.bestLap, rec.usage.laps], [2, 2000, 94.9, 13]);
  const dump = JSON.parse(JSON.stringify(await STA.library.exportAll()));
  await STA.library.clearAll();
  assert.strictEqual((await STA.library.setups()).length, 0);
  await STA.library.importAll(dump);
  assert.strictEqual((await STA.library.setups())[0].name, 'a');
  await assert.rejects(STA.library.importAll({ nope: true }), /not a library export/);
});

/* ---------- oversteer measured from the rear slip angle ---------- */

const simLib = require('./helpers/sim.js'), { makeIbt: mkIbt } = require('./helpers/make-ibt.js');
const sessionOf = async (opts) => STA.session.fromIbt(await STA.ibt.read(mkIbt(simLib.drive(Object.assign({ laps: 4, grips: [1, 1, 1, 1] }, opts))), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
const REAR_LOOSENING = ['arb|front|-', 'arb|rear|+', 'brakeBias||-', 'diffCoast||-', 'diffPreload||-', 'diffPower||-', 'rearWing|rear|-', 'rideHeight|rear|+', 'spring|front|-'];

test('a rear that steps out and is caught is reported as oversteer, where it happens', async () => {
  // tidy car with the slip channels: nothing to report
  const tidy = STA.handling.analyse(await sessionOf({ slip: true }));
  assert.ok(tidy.balance.slide, 'the rear slip angle is measured when the file has the car\'s velocities');
  assert.ok(Math.abs(tidy.balance.slide.rearSlipRef - 4) < 1, 'rear slip at the limit is read back as about 4 degrees: ' + tidy.balance.slide.rearSlipRef);
  assert.deepStrictEqual(tidy.findings.filter((f) => f.kind === 'oversteer'), []);
  // the same car sliding under power out of the slow corners
  const exit = STA.handling.analyse(await sessionOf({ looseExit: 1 }));
  const os = exit.findings.filter((f) => f.kind === 'oversteer');
  assert.ok(os.length >= 1 && os.every((f) => f.phase === 'exit' && f.band === 'low' && f.measured), JSON.stringify(os.map((f) => f.id)));
  assert.match(os[0].detail, /^Rear slides: at a bigger slip angle than the front for \d+% of the time near the limit \(rear up to 1\d°, normally \d°\)\.$/);
  assert.ok(os.every((f) => /laps\.$/.test(f.evidence)));
  assert.ok(!exit.findings.some((f) => f.kind === 'understeer'));
  // without the velocity channels the older steering-only reading is used, as before
  const plain = STA.handling.analyse(await sessionOf({}));
  assert.strictEqual(plain.balance.slide, undefined);
});

test('understeer next to a rear that is loose on its own: the rear comes first and no cure for the front may loosen it', async () => {
  // the rear slides on the way in, while the car is still slowing down: nothing to do with the throttle
  const s = await sessionOf({ looseEntry: 1, understeer: 0.8 }), an = STA.handling.analyse(s);
  const us = an.findings.filter((f) => f.kind === 'understeer'), os = an.findings.filter((f) => f.kind === 'oversteer');
  assert.ok(us.length >= 1 && os.length >= 1, JSON.stringify(an.findings.map((f) => f.id)));
  assert.ok(os.every((f) => f.cause === 'braking' && /on the brakes/.test(f.causeText)), JSON.stringify(os.map((f) => [f.id, f.cause])));
  assert.ok(us.every((f) => f.rearFirst && !f.first && /settle the rear first/.test(f.evidence)));
  assert.ok(Math.max(...os.map((f) => f.severity)) > Math.max(...us.map((f) => f.severity)), 'the sliding rear outranks the understeer');
  const adv = STA.advisor.advise(an, s.setup, {});
  const offered = adv.suggestions.map((x) => x.blockKey);
  assert.deepStrictEqual(offered.filter((k) => REAR_LOOSENING.includes(k)), [], 'offered: ' + offered.join(', '));
  assert.ok(adv.suggestions[0].findingIds.some((id) => id.indexOf('os-') === 0), 'first change is for the rear: ' + adv.suggestions[0].title);
  assert.ok(offered.includes('brakeBias||+'), 'a slide on the brakes is answered with the brake bias: ' + offered.join(', '));
  const firstFront = adv.suggestions.findIndex((x) => x.rearFirst), lastRear = adv.suggestions.map((x) => x.findingIds.some((id) => id.indexOf('os-') === 0)).lastIndexOf(true);
  assert.ok(firstFront < 0 || firstFront > lastRear, 'every change for the rear is listed before the front-only ones');
  // the same understeer on a car whose rear is stable still gets the usual cures
  const calm = await sessionOf({ slip: true, understeer: 0.8 }), advCalm = STA.advisor.advise(STA.handling.analyse(calm), calm.setup, {});
  assert.ok(advCalm.suggestions.some((x) => x.blockKey === 'arb|front|-'), advCalm.suggestions.map((x) => x.blockKey).join(', '));
});

test('understeer on a car whose rear only steps out on the throttle: the understeer comes first and is not made worse', async () => {
  const s = await sessionOf({ looseExit: 1, understeer: 0.8 }), an = STA.handling.analyse(s);
  const us = an.findings.filter((f) => f.kind === 'understeer'), os = an.findings.filter((f) => f.kind === 'oversteer');
  assert.ok(us.length >= 1 && os.length >= 1, JSON.stringify(an.findings.map((f) => f.id)));
  assert.ok(os.every((f) => f.cause === 'power' && /^It starts on the throttle: 100% of it is with the throttle on/.test(f.causeText)), os.map((f) => f.causeText).join(' | '));
  assert.ok(os.every((f) => /A slide typically begins at \d+% throttle with \d+% of the corner's steering still on/.test(f.causeText)));
  assert.ok(us.every((f) => f.first && !f.rearFirst), 'not "rear first": the rear is not loose on its own');
  assert.ok(us.some((f) => /this comes first: a front that pushes leaves steering on when the power goes down/.test(f.evidence)));
  assert.ok(os.every((f) => f.follows && f.severity < f.raw && /cure that first and this often goes with it/.test(f.causeText)));
  assert.ok(Math.max(...us.map((f) => f.severity)) > Math.max(...os.map((f) => f.severity)), 'the understeer outranks the slide on the throttle');
  const adv = STA.advisor.advise(an, s.setup, {});
  const offered = adv.suggestions.map((x) => x.blockKey);
  assert.strictEqual(adv.suggestions[0].blockKey, 'arb|front|-', 'first: more front grip. Offered: ' + offered.join(', '));
  // nothing that adds understeer to the rest of the corner, and nothing that takes grip or drive from the rear axle
  const ADDS_UNDERSTEER = ['arb|rear|-', 'arb|front|+', 'spring|rear|-', 'spring|front|+', 'rideHeight|rear|-', 'rearWing|rear|+'];
  const FROM_THE_REAR = ['arb|rear|+', 'spring|rear|+', 'rideHeight|rear|+', 'rearWing|rear|-', 'brakeBias||-', 'diffCoast||-', 'diffPreload||-'];
  assert.deepStrictEqual(offered.filter((k) => ADDS_UNDERSTEER.includes(k) || FROM_THE_REAR.includes(k)), [], 'offered: ' + offered.join(', '));
  assert.ok(offered.includes('tc||+'), 'the slide itself gets what acts only on the throttle');
  // the driver is told before the car is changed
  assert.deepStrictEqual(adv.driving.map((d) => [d.cause, d.phase]), [['power', 'exit']]);
  assert.match(adv.driving[0].tips[0], /Squeeze the throttle on as you take the steering off/);
  // a neutral car that slides on the throttle: what acts on the throttle first, the rear bar only after that
  const neutral = await sessionOf({ looseExit: 1 }), advN = STA.advisor.advise(STA.handling.analyse(neutral), neutral.setup, {});
  assert.deepStrictEqual(advN.suggestions.map((x) => x.blockKey).slice(0, 2), ['tc||+', 'toe|rear|+']);
  assert.deepStrictEqual(advN.held, []);
});
