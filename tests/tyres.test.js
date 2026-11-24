const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const sim = require('./helpers/sim.js');
const { makeIbt } = require('./helpers/make-ibt.js');

/* A run where the surface temperatures behave as in real iRacing files: they climb over
   the first laps and settle, and one tyre heats up much more in one corner than in the
   others. `reading` puts a carcass reading in at the end, as iRacing takes in the pits. */
function tyreRun(opts) {
  const run = sim.drive({ laps: 6, grips: [1, 1, 1, 1, 1, 1] });
  // the corner that gets the spike: the first stretch of the lap with high lateral load
  const max = Math.max(...run.latG.map(Math.abs));
  let a = -1, b = -1;
  for (let j = 0; j < run.n && b < 0; j++) {
    if (Math.abs(run.latG[j]) > 0.8 * max && a < 0) a = run.dist[j];
    else if (a >= 0 && Math.abs(run.latG[j]) < 0.5 * max && run.dist[j] > a) b = run.dist[j];
  }
  const warm = (t) => 50 + 22 * Math.min(1, t / (2.2 * run.trueLaps[0])); // in after a couple of laps
  const corner = (j) => (Math.abs(run.latG[j]) > 0.3 * max ? 6 : 0);      // every corner heats a little
  const spike = (j) => (run.dist[j] >= a && run.dist[j] <= b ? 25 : 0);   // one corner heats a lot
  const surf = (w, j) => warm(run.t[j]) + corner(j) + (w === 'RR' ? spike(j) : 0);
  const end = run.n - Math.round(run.hz * 0.5);
  const carc = (w, side, j) => (opts.reading && j >= end ? { LF: 92, RF: 88, LR: 90, RR: 94 }[w] + (side === 'L' ? -3 : side === 'R' ? 3 : 0) : 60);
  const cols = [];
  for (const w of ['LF', 'RF', 'LR', 'RR']) for (const side of ['L', 'M', 'R']) {
    cols.push([w + 'temp' + side, 4, 'C', (j) => surf(w, j) + (side === 'M' ? 0 : 1) + ((j * 7) % 5) * 0.01]);
    cols.push([w + 'tempC' + side, 4, 'C', (j) => carc(w, side, j)]);
  }
  return { run, cols, spikeAt: [a, b] };
}
const load = async (opts) => {
  const r = tyreRun(opts);
  const s = STA.session.fromIbt(await STA.ibt.read(makeIbt(r.run, { cols: r.cols }), { want: STA.session.IBT_WANT }), { name: 'tyres.ibt' });
  return { s, r };
};

test('iRacing surface temperatures are read live; the pit-only carcass set gives the readings', async () => {
  const { s } = await load({ reading: true });
  assert.strictEqual(s.meta.tyreLive, true);
  assert.strictEqual(STA.tyres.modeOf(s), 'relative');
  // the surface set moves round the lap, not the carcass set
  const fl = s.ch.tyreTempM[0];
  assert.ok(Math.max(...fl) - Math.min(...fl) > 15);
  // one reading at the start (what the tyres held), one at the end
  assert.strictEqual(s.tyreReadings.length, 2);
  assert.deepStrictEqual(s.tyreReadings[1].rows[3], { inner: 91, mid: 94, outer: 97 }, 'right side: the left edge is the inner one');
  assert.deepStrictEqual(s.tyreReadings[1].rows[0], { inner: 95, mid: 92, outer: 89 }, 'left side: the right edge is the inner one');
});

test('the corner where one tyre heats up far more than in the others is found, with a tip', async () => {
  const { s, r } = await load({ reading: true });
  const an = STA.handling.analyse(s);
  const info = an.tyreTemps;
  assert.ok(info.spots.length >= 1);
  const top = info.spots[0];
  assert.strictEqual(top.wheel, 'RR');
  const c = s.corners[top.cornerIdx], g = STA.session.lapGrid(s, s.refLap);
  assert.ok(g.d[c.b] >= r.spikeAt[0] - 60 && g.d[c.a] <= r.spikeAt[1] + 60, 'the spike sits in the corner that was heated');
  assert.ok(top.excess - top.typical > 12);
  assert.match(top.tip, /rear/i);
  assert.ok(!info.spots.some((x) => x.wheel !== 'RR'), 'no other tyre stands out');
});

test('the warm-up is measured per run and the routine says when to push', async () => {
  const { s } = await load({ reading: true });
  const info = STA.tyres.analyse(s, STA.handling.analyse(s).laps);
  const run = info.runs.find((x) => x.laps.length >= 5);
  assert.ok(run, 'one long run');
  assert.ok(run.warmAt >= 1 && run.warmAt <= 3, 'in after a couple of laps, got ' + run.warmAt);
  assert.strictEqual(info.routine.lapsIn, run.warmAt + 1);
  assert.match(info.routine.steps.map((x) => x.title).join(' | '), /Push from the \d+(st|nd|rd|th) lap of a run/);
  assert.match(info.routine.steps[0].title, /Brake hard/);
});

test('camber and pressure come from the pit readings; without them iRacing tyre advice is left out', async () => {
  const withR = STA.handling.analyse((await load({ reading: true })).s);
  assert.ok(withR.tyres && withR.tyres.reading);
  assert.match(withR.tyres.note, /in the pits after lap/);
  assert.strictEqual(withR.tyres.rows[3].inner, 91);
  // 92/88/90/94 against 80–100: in the window, so no hot or cold finding
  assert.ok(!withR.findings.some((f) => f.kind === 'tyreCold' || f.kind === 'tyreHot'));
  const without = STA.handling.analyse((await load({ reading: false })).s);
  assert.strictEqual(without.tyres, null);
  assert.ok(without.notes.some((n) => /took no tyre readings/.test(n)));
  assert.ok(!without.findings.some((f) => f.area === 'Tyres'), 'no camber or pressure advice from surface temperatures');
});

test('window colours and findings: under, inside and over the window', () => {
  const N = 9, mk = (vals) => [0, 1, 2, 3].map(() => Float64Array.from(vals));
  const vals = [60, 75, 79, 80, 90, 100, 101, 107, 130];
  const g = { n: N, step: 100, d: // points 100 m apart, so the 30 m smoothing leaves them alone
     Float64Array.from(vals.map((_, i) => i)), speed: new Float64Array(N).fill(30), tyreTempI: mk(vals), tyreTempM: mk(vals), tyreTempO: mk(vals) };
  const lm = STA.tyres.lapMap(g, 0, 'window', { lo: 80, hi: 100 });
  assert.deepStrictEqual(Array.from(lm.cls), [-2, -1, -1, 0, 0, 0, 1, 1, 2]);
  const info = { mode: 'window', win: { lo: 80, hi: 100, mine: false }, lapNums: [3, 4], avg: [72, 70, 104, 92] };
  const f = STA.tyres.findings(info);
  assert.deepStrictEqual(f.map((x) => [x.kind, x.axle, x.confidence]), [['tyreCold', 'front', 'low']], 'rear: one in, one over, so no axle finding');
  info.win.mine = true;
  assert.strictEqual(STA.tyres.findings(info)[0].confidence, 'medium', 'a window the driver set counts for more');
  const rule = STA.advisor.ruleFor({ kind: 'tyreCold' })[0];
  assert.deepStrictEqual([rule.role, rule.dir], ['brakeDuct', '+']);
  assert.deepStrictEqual([STA.advisor.ruleFor({ kind: 'tyreHot' })[0].dir], ['-']);
});

test('the tyre window is kept per car', () => {
  const W = STA.library.tyreWindow;
  W.clear('lmu', 'Car A');
  assert.strictEqual(W.get('lmu', 'Car A'), null);
  assert.strictEqual(STA.tyres.windowFor('lmu', 'Car A').mine, false);
  assert.strictEqual(W.set('lmu', 'Car A', 95, 85), false, 'low above high is refused');
  assert.strictEqual(W.set('lmu', 'Car A', '75', '92'), true);
  assert.deepStrictEqual(STA.tyres.windowFor('lmu', 'Car A'), { lo: 75, hi: 92, mine: true });
  assert.strictEqual(W.get('lmu', 'Car B'), null);
  // limits and blocked changes for the same car are untouched
  STA.library.blocked.add('lmu', 'Car A', 'arb|front|+');
  assert.deepStrictEqual(STA.library.blocked.list('lmu', 'Car A'), ['arb|front|+']);
  assert.strictEqual(STA.library.limits.list('lmu', 'Car A').length, 0);
  W.clear('lmu', 'Car A');
  assert.strictEqual(W.get('lmu', 'Car A'), null);
  assert.deepStrictEqual(STA.library.blocked.list('lmu', 'Car A'), ['arb|front|+']);
  STA.library.blocked.remove('lmu', 'Car A', 'arb|front|+');
});

test('a tyre window survives export and import', async () => {
  const W = STA.library.tyreWindow;
  W.set('iracing', 'Export Car', 85, 105);
  const data = JSON.parse(JSON.stringify(await STA.library.exportAll())); // as saved to a file
  W.clear('iracing', 'Export Car');
  await STA.library.importAll(data);
  assert.deepStrictEqual(STA.tyres.windowFor('iracing', 'Export Car'), { lo: 85, hi: 105, mine: true });
  W.clear('iracing', 'Export Car');
});
