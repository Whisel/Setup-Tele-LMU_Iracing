/* Reader for ".lmulaps" files: runs written by the Le Mans Ultimate lap recorder
   (recorder/lmu-recorder.ps1) from the game's live data, while the session is still on.

   File layout (little-endian):
     "STALMU01"                 8 bytes
     header length              int32
     header                     UTF-8 JSON: { format, version, hz, n, tStart, tEnd, cols, wheelCols, meta, laps, setup }
     zero padding               to a multiple of 8 bytes
     time                       n float64 (the game's session clock, seconds)
     one block per column       n float32 each: cols first, then four (FL FR RL RR) per wheel column

   The result has the same shape as STA.lmu.read() gives for the game's own .duckdb
   recording, with the same channel names and units, so the rest of the app treats both
   the same way. Extra channels the live data has (the car's own velocities and yaw rate,
   and its position in metres) are carried under their own names. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const MAGIC = 'STALMU01';
  // Columns that are switches or steps rather than curves: turned into change events.
  const STEPS = { Gear: 'Gear', ABS: 'ABS' };

  async function bytesOf(file, from, to) {
    if (typeof file.arrayBuffer === 'function' && typeof file.slice === 'function' && !(file instanceof Uint8Array)) { // a File or Blob
      return new Uint8Array(await file.slice(from, to).arrayBuffer());
    }
    const u = file instanceof Uint8Array ? file : new Uint8Array(file); // bytes already in memory (tests)
    return u.subarray(from || 0, to == null ? u.length : Math.min(to, u.length));
  }

  async function readHeader(file) {
    const first = await bytesOf(file, 0, 12);
    if (first.length < 12 || String.fromCharCode.apply(null, first.subarray(0, 8)) !== MAGIC) throw new Error('This is not a run saved by the LMU lap recorder.');
    const len = new DataView(first.buffer, first.byteOffset, 12).getInt32(8, true);
    if (!(len > 0 && len < 8e6)) throw new Error('The run file is damaged (bad header length).');
    const raw = await bytesOf(file, 12, 12 + len);
    if (raw.length < len) throw new Error('The run file is cut short.');
    let head;
    try { head = JSON.parse(new TextDecoder('utf-8').decode(raw)); } catch (e) { throw new Error('The run file is damaged (the header cannot be read).'); }
    if (!head || head.format !== 'sta-lmu-live' || !Array.isArray(head.cols) || !Array.isArray(head.wheelCols) || !(head.n > 1)) throw new Error('The run file is damaged (unexpected header).');
    return { head, dataAt: 12 + len + ((8 - ((12 + len) % 8)) % 8) };
  }

  /* The setup is kept as the game gave it: the same JSON the .duckdb recording stores. */
  function metaOf(head) {
    const m = Object.assign({}, head.meta || {});
    if (head.setup && typeof head.setup === 'object') m.CarSetup = JSON.stringify(head.setup);
    m.Live = true;
    return m;
  }

  async function read(file, opts) {
    const { head, dataAt } = await readHeader(file);
    if (opts && opts.headerOnly) return { meta: metaOf(head), head };
    const n = head.n, blocks = head.cols.length + head.wheelCols.length * 4, need = dataAt + n * 8 + blocks * n * 4;
    const all = await bytesOf(file, dataAt, need);
    if (all.length < need - dataAt) throw new Error('The run file is cut short: it should hold ' + n + ' samples.');
    const buf = all.buffer.slice(all.byteOffset, all.byteOffset + all.length); // aligned copy
    const t = new Float64Array(buf, 0, n);
    for (let i = 1; i < n; i++) if (!(t[i] > t[i - 1])) throw new Error('The run file is damaged (time does not run forward).');
    let at = n * 8;
    const next = () => { const a = new Float32Array(buf, at, n); at += n * 4; return a; };
    const cont = {}, wheel = {}, events = {}, warnings = [];
    for (const name of head.cols) {
      const v = next();
      if (STEPS[name]) { // keep only the moments it changes
        const ts = [t[0]], vs = [v[0]];
        for (let i = 1; i < n; i++) if (v[i] !== v[i - 1]) { ts.push(t[i]); vs.push(v[i]); }
        events[STEPS[name]] = { ts: Float64Array.from(ts), v: Float64Array.from(vs) };
      } else cont[name] = { t, v };
    }
    for (const name of head.wheelCols) wheel[name] = { t, v: [next(), next(), next(), next()] };

    const L = head.laps || {}, ts = L.ts || [];
    const col = (a) => Float64Array.from(ts.map((_, k) => (a && a[k] > 0 ? a[k] : NaN)));
    events['Lap'] = { ts: Float64Array.from(ts), v: Float64Array.from(ts.map((_, k) => (L.num ? L.num[k] : k + 1))) };
    events['Lap Time'] = { ts: Float64Array.from(ts), v: col(L.time) };
    events['Last Sector1'] = { ts: Float64Array.from(ts), v: col(L.s1) };
    events['Last Sector2'] = { ts: Float64Array.from(ts), v: col(L.s2) };
    events['In Pits'] = { ts: Float64Array.from([t[0]]), v: Float64Array.from([0]) }; // the recorder stops at the pit lane
    if (head.meta && head.meta.MaxRpm > 0) events['Engine Max RPM'] = { ts: Float64Array.from([t[0]]), v: Float64Array.from([head.meta.MaxRpm]) };
    if (!head.setup) warnings.push('This run was saved without the setup (the game did not answer when the recorder asked), so setup changes cannot be suggested for it.');
    return { meta: metaOf(head), tStart: t[0], tEnd: t[n - 1], cont, wheel, events, warnings, live: true };
  }

  STA.lmuLive = { read, readHeader, MAGIC };
})(typeof window !== 'undefined' ? window : globalThis);
