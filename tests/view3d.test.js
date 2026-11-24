const test = require('node:test'), assert = require('node:assert');
const path = require('path');
const STA = require('./helpers/load.js');
require(path.join(__dirname, '..', 'js', 'ui', 'track3d.js'));
const sim = require('./helpers/sim.js');
const { makeIbt } = require('./helpers/make-ibt.js');
const { makeLmuLaps } = require('./helpers/make-lmulaps.js');
const { fakeLmuDb } = require('./helpers/fake-lmu.js');
const V = STA.view3d;

const ibtSession = async (opts, extra) => STA.session.fromIbt(await STA.ibt.read(makeIbt(sim.drive(Object.assign({ laps: 3, grips: [1, 1, 1] }, opts)), extra), { want: STA.session.IBT_WANT }), { name: 'x.ibt' });

test('height is kept from iRacing altitude and from the LMU lap recorder, and is absent in LMU\'s own file', async () => {
  const s = await ibtSession({}, { hill: 8 });
  assert.ok(Math.abs(s.heightRange - 16) < 0.5, 'iRacing height range ' + s.heightRange);
  const g = STA.session.lapGrid(s, s.refLap);
  assert.ok(g.z && g.z.length === g.n);
  let lo = Infinity, hi = -Infinity; for (const v of g.z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.ok(lo >= -0.01 && hi > 15 && hi < 16.5, 'heights are metres above the lowest point: ' + lo + ' .. ' + hi);
  assert.strictEqual(s.ch.alt, undefined, 'the raw altitude is not kept twice');

  const run = sim.drive({ laps: 3, hz: 50, grips: [1, 1, 1], slip: true });
  const live = STA.session.fromLmu(await STA.lmuLive.read(makeLmuLaps(run, { hill: 5 })), { name: 'x.lmulaps' });
  assert.ok(Math.abs(live.heightRange - 10) < 0.5, 'LMU lap recorder height range ' + live.heightRange);

  const duck = STA.session.fromLmu(await STA.lmu.read(fakeLmuDb(run)), { name: 'Test Ring_P_2026.duckdb' });
  assert.strictEqual(duck.ch.z, undefined);
  assert.strictEqual(STA.view3d.sceneOf(STA.session.lapGrid(duck, duck.refLap)).z, null, 'drawn flat');

  // a level track counts as flat too
  const level = await ibtSession({});
  assert.strictEqual(V.sceneOf(STA.session.lapGrid(level, level.refLap)).z, null);
});

test('the camera: the target is in the middle, east is to the right looking north, up is up, behind is not drawn', () => {
  const view = { tx: 100, ty: 50, tz: 0, yaw: -Math.PI / 2, pitch: (30 * Math.PI) / 180, dist: 500 };
  const cam = V.camera(view, 800, 600), p = [0, 0, 0];
  assert.ok(V.project(cam, 100, 50, 0, p));
  assert.ok(Math.abs(p[0] - 400) < 1e-6 && Math.abs(p[1] - 300) < 1e-6 && Math.abs(p[2] - 500) < 1e-6);
  V.project(cam, 150, 50, 0, p); assert.ok(p[0] > 400 + 10 && Math.abs(p[1] - 300) < 1e-6, 'east of the target is to the right');
  V.project(cam, 100, 50, 40, p); assert.ok(p[1] < 300 - 10, 'higher is further up the screen');
  V.project(cam, 100, 150, 0, p); assert.ok(p[1] < 300, 'further north is further up the screen');
  assert.strictEqual(V.project(cam, 100, -1000, 0, p), false, 'behind the camera');
  // from above, north is up and east is right: the same as the flat map
  const top = V.camera(Object.assign({}, view, { pitch: V.PITCH_MAX }), 800, 600);
  V.project(top, 100, 150, 0, p); assert.ok(Math.abs(p[0] - 400) < 2 && p[1] < 300 - 50);
  V.project(top, 150, 50, 0, p); assert.ok(p[0] > 400 + 50 && Math.abs(p[1] - 300) < 2);
});

test('the first view shows the whole lap, and walls stay inside it', async () => {
  const s = await ibtSession({}, { hill: 8 }), g = STA.session.lapGrid(s, s.refLap), sc = V.sceneOf(g);
  for (const [W, H] of [[1200, 700], [700, 900]]) {
    const Hw = V.wallMetres(sc), view = V.fitView(sc, W, H, 2, Hw * 1.2), cam = V.camera(view, W, H), p = [0, 0, 0];
    let spanX = 0, spanY = 0;
    for (let i = 0; i < g.n; i += 5) {
      const z = (sc.z[i] - sc.zMin) * 2;
      for (const up of [0, Hw]) {
        assert.ok(V.project(cam, g.x[i], g.y[i], z + up, p), 'in front of the camera');
        assert.ok(p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H, W + 'x' + H + ' point ' + i + ' at ' + p[0].toFixed(0) + ',' + p[1].toFixed(0));
        spanX = Math.max(spanX, Math.abs(p[0] - W / 2)); spanY = Math.max(spanY, Math.abs(p[1] - H / 2));
      }
    }
    assert.ok(spanX > W * 0.3 || spanY > H * 0.3, 'and it fills a good part of the view: ' + spanX.toFixed(0) + ' x ' + spanY.toFixed(0));
  }
});

test('smoothing for heights skips gaps instead of pulling towards zero', () => {
  const a = Float64Array.from([10, 10, NaN, 10, 10, 10]), out = V.smoothGaps(a, 3);
  assert.ok(Number.isNaN(out[2]));
  for (const k of [0, 1, 3, 4, 5]) assert.strictEqual(out[k], 10);
});
