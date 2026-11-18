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
