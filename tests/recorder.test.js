const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const R = STA.recorder;

test('recorder client: a saved run is announced once, and a restarted recorder announces nothing', () => {
  let b = null;
  const seen = [];
  for (const n of [2, 2, 3, 3, 4, 0, 0, 1]) { const s = R.step(b, { finished: n }); b = s.baseline; seen.push(s.finished); }
  //              first look, same, +1, same, +1, recorder restarted, same, +1
  assert.deepStrictEqual(seen, [false, false, true, false, true, false, false, true]);
  assert.deepStrictEqual(R.step(5, null), { baseline: 5, finished: false });
  assert.deepStrictEqual(R.step(5, { connected: true }), { baseline: 5, finished: false }, 'a status without a count changes nothing');
});

test('recorder client: one plain line for every state', () => {
  const d = (cfg, st) => R.describe(cfg, st);
  const on = { on: true };
  assert.deepStrictEqual(d({ on: false }, {}), { tone: 'off', text: 'iRacing recorder is off' });
  assert.strictEqual(d(on, { reachable: false }).tone, 'missing');
  assert.strictEqual(d(on, { reachable: true, status: { connected: false } }).text, 'Waiting for iRacing');
  assert.strictEqual(d(on, { reachable: true, status: { connected: true, enabled: true, recording: true } }).tone, 'rec');
  assert.strictEqual(d(on, { reachable: true, status: { connected: true, enabled: true, recording: false } }).text, 'Ready: records when you drive');
  assert.strictEqual(d(on, { reachable: true, status: { connected: true, enabled: false } }).text, 'Recording is switched off');
  // an older sim that does not say whether recording is on
  assert.strictEqual(d(on, { reachable: true, status: { connected: true, enabled: null, mode: 'manual' } }).text, 'iRacing running');
});

test('recorder client: off by default, and settings are kept', () => {
  assert.deepStrictEqual([R.settings().on, R.settings().port, R.settings().autoOpen], [false, 8765, true]);
  R.save({ autoOpen: false });
  assert.strictEqual(R.settings().autoOpen, false);
  R.save({ autoOpen: true });
});
