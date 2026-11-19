/* Client for the iRacing recorder, the small program in recorder/ that switches
   iRacing's telemetry recording on and off on the driver's PC.

   The app only talks to it when the driver has turned this on, and only on this
   computer (http://127.0.0.1). It asks for the status every couple of seconds,
   sends start / stop / mode commands, and notices when a run has been saved so
   the folder library can pick the new file up at once.

   Status from the recorder:
     { app: 'sta-recorder', mode: 'auto' | 'manual', connected, onTrack, enabled,
       recording, finished, lastFinishedAt, recordingSince, simulated } */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const DEFAULTS = { on: false, port: 8765, autoOpen: true };

  let settings = null;
  function load() {
    if (settings) return settings;
    let saved = {};
    try { saved = JSON.parse(root.localStorage.getItem('sta-recorder') || '{}') || {}; } catch (e) { /* defaults */ }
    settings = Object.assign({}, DEFAULTS, saved);
    return settings;
  }
  function save(patch) {
    Object.assign(load(), patch);
    try { root.localStorage.setItem('sta-recorder', JSON.stringify(settings)); } catch (e) { /* this visit only */ }
    return settings;
  }

  const state = { reachable: false, status: null, baseline: null, error: '' };
  const listeners = { change: [], finished: [] };
  const emit = (name, arg) => { for (const fn of listeners[name]) { try { fn(arg); } catch (e) { console.error(e); } } };
  const base = () => 'http://127.0.0.1:' + load().port;

  async function call(path, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 2500) : null;
    try {
      const res = await root.fetch(base() + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl && ctl.signal } : { signal: ctl && ctl.signal });
      const data = await res.json();
      if (!data || data.app !== 'sta-recorder') throw new Error('Something else is answering on port ' + load().port + '.');
      return data;
    } finally { if (timer) clearTimeout(timer); }
  }

  /* What a new status means, given the number of saved runs seen so far.
     -> { baseline, finished }: finished is true when a run has been saved since the last look. */
  function step(baseline, status) {
    const n = status && typeof status.finished === 'number' ? status.finished : null;
    if (n == null) return { baseline, finished: false };
    // First look, or the recorder was restarted (its count starts again): nothing to announce.
    if (baseline == null || n < baseline) return { baseline: n, finished: false };
    return { baseline: n, finished: n > baseline };
  }

  function take(status) {
    const was = JSON.stringify([state.reachable, state.status]);
    state.reachable = true; state.status = status; state.error = '';
    const s = step(state.baseline, status);
    state.baseline = s.baseline;
    if (JSON.stringify([state.reachable, state.status]) !== was) emit('change');
    if (s.finished) emit('finished', status);
  }

  async function poll() {
    if (!load().on) return;
    try { take(await call('/status')); }
    catch (e) {
      const changed = state.reachable || state.status;
      state.reachable = false; state.status = null; state.error = e && e.message ? e.message : String(e);
      if (changed) emit('change');
    }
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!load().on) return;
    // Ask often while the recorder is there, rarely while it is not.
    timer = setTimeout(async () => { await poll(); schedule(); }, state.reachable ? 2000 : 8000);
  }

  async function setOn(on) {
    save({ on: !!on });
    if (!on) { state.reachable = false; state.status = null; state.baseline = null; if (timer) clearTimeout(timer); emit('change'); return; }
    await poll(); emit('change'); schedule();
  }

  /* start | stop | restart | auto | manual. Returns the recorder's answer; throws if it cannot be reached. */
  async function command(cmd) {
    const res = await call('/command', { cmd });
    take(res);
    // The sim takes a moment to act on a command; look again shortly so the display follows.
    setTimeout(poll, 700);
    return res;
  }

  /* One line for the display. tone: off | missing | waiting | idle | ready | rec */
  function describe(cfg, st) {
    if (!cfg.on) return { tone: 'off', text: 'iRacing recorder is off' };
    if (!st.reachable) return { tone: 'missing', text: 'Recorder not found on this PC' };
    const s = st.status || {};
    if (!s.connected) return { tone: 'waiting', text: 'Waiting for iRacing' };
    if (s.recording) return { tone: 'rec', text: 'Recording this run' };
    if (s.enabled) return { tone: 'ready', text: 'Ready: records when you drive' };
    if (s.enabled === false) return { tone: 'idle', text: 'Recording is switched off' };
    return { tone: 'ready', text: s.mode === 'auto' ? 'Ready: records when you drive' : 'iRacing running' };
  }

  function start() { if (load().on) { poll().then(schedule); } }

  STA.recorder = { settings: load, save, state, on: (name, fn) => listeners[name].push(fn), poll, start, setOn, command, describe, step };
})(typeof window !== 'undefined' ? window : globalThis);
