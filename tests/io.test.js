const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const sim = require('./helpers/sim.js');
const { makeIbt } = require('./helpers/make-ibt.js');
const { fakeLmuDb } = require('./helpers/fake-lmu.js');

test('yaml-lite reads nested maps, lists and values containing colons', () => {
  const y = STA.yaml.parse('---\nA:\n B: 1\n T: 12:00 pm\n L:\n - X: 1\n   Y: two words\n - X: 2\nC: "q"\n...\n');
  assert.deepStrictEqual(y, { A: { B: '1', T: '12:00 pm', L: [{ X: '1', Y: 'two words' }, { X: '2' }] }, C: 'q' });
});

test('ibt reader: header, variables, session info and samples survive a round trip', async () => {
  const run = sim.drive({ laps: 1 });
  const raw = await STA.ibt.read(makeIbt(run), { want: ['Speed', 'Lat', 'Lap', 'OnPitRoad', 'NotThere'] });
  assert.strictEqual(raw.tickRate, 60);
  assert.strictEqual(raw.n, run.n);
  assert.deepStrictEqual(Object.keys(raw.vars).sort(), ['Lap', 'Lat', 'OnPitRoad', 'Speed']);
  assert.ok(raw.vars.Lat.data instanceof Float64Array);
  assert.ok(Math.abs(raw.vars.Speed.data[500] - run.speed[500]) < 1e-3);
  assert.strictEqual(raw.sessionInfo.WeekendInfo.TrackDisplayName, 'Test Ring');
  assert.strictEqual(raw.sessionInfo.DriverInfo.Drivers.length, 2);
  assert.strictEqual(raw.sessionInfo.CarSetup.Chassis.Front.ArbBlades, '3');
});

test('ibt reader: headerOnly skips the samples, and junk is rejected', async () => {
  const raw = await STA.ibt.read(makeIbt(sim.drive({ laps: 1 })), { headerOnly: true });
  assert.strictEqual(raw.n, 0);
  assert.ok(raw.sessionInfo.CarSetup);
  await assert.rejects(STA.ibt.read(Buffer.alloc(4000, 7)), /does not look like an iRacing/);
  await assert.rejects(STA.ibt.read(Buffer.alloc(10)), /too small/);
});

test('iRacing session: laps, lap times and track length match the simulation', async () => {
  const run = sim.drive({ laps: 3 });
  const s = STA.session.fromIbt(await STA.ibt.read(makeIbt(run), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
  assert.strictEqual(s.meta.car, 'Test GT3');
  assert.strictEqual(s.trackName, 'Test Ring – Grand Prix');
  assert.strictEqual(s.laps.length, 5, 'part lap, three full laps, part lap');
  assert.deepStrictEqual(s.laps.map((l) => l.complete), [false, true, true, true, false]);
  assert.ok(Math.abs(s.trackLen - run.length) < 1.0, 'track length ' + s.trackLen + ' vs ' + run.length);
  const full = s.laps.filter((l) => l.complete);
  full.forEach((l, i) => {
    assert.ok(Math.abs(l.timeComputed - run.trueLaps[i]) < 0.01, 'lap ' + i + ' timed from telemetry: ' + l.timeComputed + ' vs ' + run.trueLaps[i]);
    assert.ok(Math.abs(l.time - run.trueLaps[i]) < 0.002, 'lap ' + i + ' uses the sim\'s own lap time');
    assert.ok(l.valid);
  });
  const best = run.trueLaps.indexOf(Math.min(...run.trueLaps));
  assert.strictEqual(s.bestLap.idx, full[best].idx);
  assert.strictEqual(s.setup.name, 'baseline');
  assert.strictEqual(s.meta.maxRpm, 7600);
});

test('lap grid: one point per metre, elapsed time ends at the lap time, laps line up by distance', async () => {
  const run = sim.drive({ laps: 2 });
  const s = STA.session.fromIbt(await STA.ibt.read(makeIbt(run), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
  const [l1, l2] = s.laps.filter((l) => l.complete);
  const g1 = STA.session.lapGrid(s, l1), g2 = STA.session.lapGrid(s, l2);
  assert.strictEqual(g1.n, Math.round(s.trackLen) + 1);
  assert.ok(Math.abs(g1.t[g1.n - 1] - l1.time) < 0.01);
  assert.ok(Math.abs(g1.t[0]) < 0.02);
  const d = STA.session.deltaTime(g1, g2);
  assert.ok(Math.abs(d[d.length - 1] - (l2.time - l1.time)) < 0.02, 'time difference at the line equals the lap time difference');
  // the same place on track is at the same grid index on both laps
  const i = Math.round(g1.n / 3);
  assert.ok(Math.hypot(g1.x[i] - g2.x[i], g1.y[i] - g2.y[i]) < 1.5);
});

test('corner detection finds the four right-handers and classes them by speed', async () => {
  const run = sim.drive({ laps: 2 });
  const s = STA.session.fromIbt(await STA.ibt.read(makeIbt(run), { want: STA.session.IBT_WANT }), { name: 'run.ibt' });
  assert.strictEqual(s.corners.length, 4);
  assert.ok(s.corners.every((c) => c.dir === 'R'));
  // limit speed for radii 40, 120, 60 and 250 m at 1.9 g is about 98, 170, 120 and 245 km/h
  assert.deepStrictEqual(s.corners.map((c) => c.band), ['low', 'high', 'medium', 'high']);
  const st = STA.session.cornerStats(STA.session.lapGrid(s, s.bestLap), s.corners[0], null);
  assert.ok(st.brakeAt != null && st.brakeAt < s.corners[0].dApex, 'brake point comes before the apex');
  assert.ok(Math.abs(st.min - Math.sqrt(1.9 * sim.G * 40)) < 1.5, 'minimum speed matches the grip limit for a 40 m radius');
  assert.ok(s.profile.wot > 0.3 && s.profile.wot < 0.9);
});

test('LMU session: channels on different rates line up, G channels are un-swapped, sim lap times are used', async () => {
  const run = sim.drive({ laps: 3, hz: 100 });
  const s = STA.session.fromLmu(await STA.lmu.read(fakeLmuDb(run)), { name: 'Test Ring_P_2026.duckdb' });
  assert.strictEqual(s.meta.sim, 'lmu');
  assert.strictEqual(s.hz, 50);
  assert.deepStrictEqual(s.laps.map((l) => l.complete), [false, true, true, true, false]);
  s.laps.filter((l) => l.complete).forEach((l, i) => assert.ok(Math.abs(l.time - run.trueLaps[i]) < 1e-6));
  assert.ok(Math.abs(s.trackLen - run.length) < 2);
  assert.ok((s.notes || []).some((n) => /labelled the other way round/.test(n)));
  const g = STA.session.lapGrid(s, s.bestLap);
  // all four corners are right-handers: lateral G and steering must both be negative there, braking negative
  const c = s.corners[0];
  assert.ok(g.latG[c.apex] < -1 && g.steer[c.apex] < 0, 'right turn reads as negative lateral G and steering');
  let minLong = 0; for (let i = 0; i < g.n; i++) if (g.longG[i] < minLong) minLong = g.longG[i];
  assert.ok(minLong < -1, 'braking reads as negative longitudinal G');
  assert.strictEqual(s.corners.length, 4);
  assert.strictEqual(s.setup.params.find((p) => p.role === 'rearWing').raw, '3.3 deg');
});

test('LMU session: a lap the sim invalidated is kept but not counted as the best', async () => {
  const run = sim.drive({ laps: 3, hz: 100 });
  const fastest = run.trueLaps.indexOf(Math.min(...run.trueLaps));
  const s = STA.session.fromLmu(await STA.lmu.read(fakeLmuDb(run, { invalidLap: fastest + 1 })), { name: 'x.duckdb' });
  const full = s.laps.filter((l) => l.complete);
  assert.strictEqual(full[fastest].valid, false);
  assert.notStrictEqual(s.bestLap.idx, full[fastest].idx);
});

test('LMU reader rejects a database that is not a telemetry recording', async () => {
  const db = { rows: async () => [{ name: 'something_else' }], cols: async () => ({}) };
  await assert.rejects(STA.lmu.read(db), /does not look like a Le Mans Ultimate/);
});

/* ---------- runs saved by the LMU lap recorder (.lmulaps) ---------- */

const { makeLmuLaps } = require('./helpers/make-lmulaps.js');
const SETUP_JSON = { VM_REAR_WING: { available: true, value: 5, stringValue: 'P5', minValue: 0, maxValue: 11 }, VM_FRONT_ANTISWAY: { available: true, value: 3, stringValue: 'P3', minValue: 0, maxValue: 9 } };

test('a run from the LMU lap recorder reads like the game\'s own recording, with the extra live channels', async () => {
  const run = require('./helpers/sim.js').drive({ laps: 4, hz: 50, grips: [1, 1, 1, 1], slip: true });
  const file = makeLmuLaps(run, { setup: SETUP_JSON });
  const head = await STA.lmuLive.read(file, { headerOnly: true });
  assert.deepStrictEqual([head.meta.CarName, head.meta.TrackName, head.meta.Live, typeof head.meta.CarSetup], ['Test GT3 #1', 'Test Ring', true, 'string']);
  const s = STA.session.fromLmu(await STA.lmuLive.read(file), { name: 'Test Ring_Test GT3 #1_2026-11-19T20_00_00Z.lmulaps' });
  assert.deepStrictEqual([s.meta.sim, s.meta.car, s.meta.live, s.meta.recordedAt], ['lmu', 'Test GT3 #1', true, Date.parse('2026-11-19T20:00:00Z')]);
  const done = s.laps.filter((l) => l.complete);
  assert.ok(done.length >= 3, 'laps: ' + done.length);
  for (let k = 0; k < done.length; k++) assert.ok(Math.abs(done[k].time - run.trueLaps[k + 1 < run.trueLaps.length ? k + 1 : k]) < 2, 'lap ' + k + ': ' + done[k].time);
  assert.ok(s.ch.x && s.ch.y && s.ch.velX && s.ch.velY && s.ch.yawRate, 'position and the car\'s own velocities are carried');
  assert.ok(s.corners.length >= 3, 'corners: ' + s.corners.length);
  assert.ok(s.setup && s.setup.params.some((p) => p.role === 'rearWing'), 'the setup the game reported is read');
  // the car's own velocities make the measured oversteer reading available for LMU too
  const an = STA.handling.analyse(s);
  assert.ok(an.balance && an.balance.slide, an.notes.join(' / '));
  assert.deepStrictEqual(an.findings.filter((f) => f.kind === 'oversteer'), []);
  const loose = STA.handling.analyse(STA.session.fromLmu(await STA.lmuLive.read(makeLmuLaps(require('./helpers/sim.js').drive({ laps: 4, hz: 50, grips: [1, 1, 1, 1], looseExit: 1 }))), { name: 'x.lmulaps' }));
  assert.ok(loose.findings.some((f) => f.kind === 'oversteer' && f.phase === 'exit' && f.measured), JSON.stringify(loose.findings.map((f) => f.id)));
});

test('a damaged or foreign .lmulaps file is refused with a plain message, and a run without a setup says so', async () => {
  const run = require('./helpers/sim.js').drive({ laps: 2, hz: 50, slip: true }), file = makeLmuLaps(run);
  await assert.rejects(STA.lmuLive.read(Buffer.from('not a recorder file at all')), /not a run saved by the LMU lap recorder/);
  await assert.rejects(STA.lmuLive.read(file.subarray(0, file.length - 1000)), /cut short/);
  const bad = Buffer.from(file); bad.writeInt32LE(-5, 8);
  await assert.rejects(STA.lmuLive.read(bad), /bad header length/);
  const raw = await STA.lmuLive.read(file);
  assert.match(raw.warnings.join(' '), /saved without the setup/);
  assert.strictEqual(STA.session.fromLmu(raw, { name: 'x.lmulaps' }).setup, null);
});
